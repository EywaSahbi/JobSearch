import { mkdirSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const DEFAULT_STALE_MS = 30_000;
const configuredOwnerlessGraceMs = Number(process.env.CAREER_OPS_OWNERLESS_GRACE_MS);
export const OWNERLESS_GRACE_MS = Number.isFinite(configuredOwnerlessGraceMs) && configuredOwnerlessGraceMs > 0
  ? configuredOwnerlessGraceMs
  : 1_000;
const DEFAULT_RETRY_MS = 80;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_WAIT_FACTOR = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LockTimeoutError extends Error {
  constructor(lockDir, timeoutMs) {
    super(`pipeline lock timeout: ${lockDir} held > ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
    this.lockDir = lockDir;
  }
}

export function lockDirFor(pipelinePath) {
  return `${pipelinePath}.lock`;
}

function readLockOwner(lockDir) {
  let raw;
  try {
    raw = readFileSync(join(lockDir, 'owner.json'), 'utf-8');
  } catch (err) {
    return { inspected: err?.code === 'ENOENT', owner: null };
  }
  try {
    return { inspected: true, owner: JSON.parse(raw) };
  } catch {
    return { inspected: true, owner: null };
  }
}

function statOrNull(dir) {
  try {
    return statSync(dir);
  } catch {
    return null;
  }
}

export function sameLockDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs);
}

export function isMkdirContention(err) {
  return err?.code === 'EEXIST' || err?.code === 'EPERM' || err?.code === 'EACCES';
}

export function isRmContention(err) {
  return err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY' || err?.code === 'ENOTEMPTY';
}

export function rmLockArtifactSync(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (isRmContention(err)) return false;
    throw err;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export const RECOVER_STALE = 'stale';
export const RECOVER_VANISHED = 'vanished';
export const RECOVER_LIVE = 'live';

export function lockRecoveryVerdict(lockDir, staleMs) {
  const { inspected, owner } = readLockOwner(lockDir);
  if (!inspected) return RECOVER_LIVE;
  if (owner?.pid) return processIsAlive(owner.pid) ? RECOVER_LIVE : RECOVER_STALE;
  try {
    return Date.now() - statSync(lockDir).mtimeMs > Math.max(staleMs, OWNERLESS_GRACE_MS)
      ? RECOVER_STALE
      : RECOVER_LIVE;
  } catch (err) {
    return err?.code === 'ENOENT' ? RECOVER_VANISHED : RECOVER_LIVE;
  }
}

export function createLockWaitPolicy(lockDir, { timeoutMs, retryMs, deadline, hardDeadline }) {
  let perHolderDeadline = deadline;
  let lastFingerprint;

  const ceiling = hardDeadline ?? Date.now() + timeoutMs * DEFAULT_MAX_WAIT_FACTOR;
  if (typeof ceiling !== 'number' || Number.isNaN(ceiling)) {
    throw new TypeError(
      `createLockWaitPolicy: hardDeadline must be a number or omitted, got ${String(hardDeadline)}`,
    );
  }

  const backoffMs = () => Math.max(0, Math.min(
    retryMs * (0.5 + Math.random()),
    ceiling - Date.now(),
    perHolderDeadline - Date.now(),
  ));

  const holderStillWedged = () => {
    if (Date.now() <= perHolderDeadline) return false;
    const fingerprint = lockFingerprint(lockDir);
    if (fingerprint !== null && fingerprint === lastFingerprint) return true;
    lastFingerprint = fingerprint;
    perHolderDeadline = Date.now() + timeoutMs;
    return false;
  };

  const noteWaiting = () => {
    if (lastFingerprint === undefined) lastFingerprint = lockFingerprint(lockDir);
  };

  const ceilingReached = () => Date.now() > ceiling;

  return { backoffMs, holderStillWedged, noteWaiting, ceilingReached };
}

function lockFingerprint(lockDir) {
  try {
    const st = statSync(lockDir);
    const { owner } = readLockOwner(lockDir);
    return `${owner?.token ?? ''}|${st.ino}|${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

export async function acquirePipelineLock(pipelinePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? (Number(process.env.CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const retryMs = options.retryMs ?? (Number(process.env.CAREER_OPS_PIPELINE_LOCK_RETRY_MS) || DEFAULT_RETRY_MS);
  const staleMs = options.staleMs ?? (Number(process.env.CAREER_OPS_PIPELINE_LOCK_STALE_MS) || DEFAULT_STALE_MS);
  const defaultMaxWaitMs = timeoutMs * DEFAULT_MAX_WAIT_FACTOR;
  const envMaxWait = process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
  const requestedMaxWait = Number(
    options.maxWaitMs ?? (envMaxWait === undefined || envMaxWait.trim() === '' ? defaultMaxWaitMs : envMaxWait),
  );
  const maxWaitMs = requestedMaxWait === Infinity ? Infinity
    : Number.isFinite(requestedMaxWait) && requestedMaxWait >= 0 ? requestedMaxWait
      : defaultMaxWaitMs;
  const lockDir = lockDirFor(pipelinePath);
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  let deadline = Date.now() + timeoutMs;
  const hardDeadline = Date.now() + maxWaitMs;
  let lastContentionError = null;

  const { backoffMs, holderStillWedged, noteWaiting } = createLockWaitPolicy(lockDir, {
    timeoutMs, retryMs, deadline, hardDeadline,
  });
  const buildTimeoutError = (expiredMs = timeoutMs) => {
    const err = new LockTimeoutError(lockDir, expiredMs);
    try {
      const { inspected, owner } = readLockOwner(lockDir);
      err.owner = owner
        ? { pid: owner.pid, alive: processIsAlive(owner.pid), started_at: owner.started_at, heldMs: Date.parse(owner.started_at) ? Date.now() - Date.parse(owner.started_at) : null }
        : {
          pid: null,
          alive: null,
          note: !inspected ? 'owner.json exists but could not be read'
            : existsSync(lockDir) ? 'lock exists with no owner.json'
              : 'lock vanished before it could be read',
        };
      err.message += ` — owner=${JSON.stringify(err.owner)}`;
      if (lastContentionError && lastContentionError.code !== 'EEXIST') {
        err.lastMkdirError = lastContentionError.code;
        err.message += `, last mkdir error=${lastContentionError.code} on ${lastContentionError.path ?? '?'}`;
      }
    } catch { }
    return err;
  };

  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    if (Date.now() > hardDeadline) throw buildTimeoutError(maxWaitMs);

    try {
      mkdirSync(lockDir);
    } catch (err) {
      if (!isMkdirContention(err)) throw err;
      lastContentionError = err;
      noteWaiting();

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (!isMkdirContention(guardErr)) throw guardErr;
        lastContentionError = guardErr;
        if (guardErr.code !== 'EEXIST') {
          if (holderStillWedged()) throw buildTimeoutError();
          await sleep(backoffMs());
          continue;
        }
        if (lockRecoveryVerdict(recoverGuardDir, staleMs) === RECOVER_STALE) {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      if (hasRecoverGuard) {
        try {
          const judged = statOrNull(lockDir);
          if (judged && lockRecoveryVerdict(lockDir, staleMs) === RECOVER_STALE
            && sameLockDirectory(judged, statOrNull(lockDir) ?? {})) {
            if (rmLockArtifactSync(lockDir)) {
              continue;
            }
          }
        } finally {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      if (holderStillWedged()) throw buildTimeoutError();
      await sleep(backoffMs());
      continue;
    }

    try {
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        pipeline: pipelinePath,
      }, null, 2));
    } catch (ownerErr) {
      if (ownerErr?.code === 'ENOENT') {
        if (holderStillWedged()) throw buildTimeoutError();
        continue;
      }
      try {
        rmLockArtifactSync(lockDir);
      } catch {
      }
      throw ownerErr;
    }

    const confirmed = readLockOwner(lockDir);
    if (confirmed.owner?.token !== token) {
      if (holderStillWedged()) throw buildTimeoutError();
      continue;
    }

    let released = false;
    return {
      lockDir,
      release() {
        if (released) return;
        released = true;
        let before;
        try {
          before = statSync(lockDir);
        } catch {
          return;
        }
        const { owner } = readLockOwner(lockDir);
        if (owner?.token !== token) return;
        let after;
        try {
          after = statSync(lockDir);
        } catch {
          return;
        }
        if (!sameLockDirectory(before, after)) return;
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
        }
      },
    };
  }
}

export async function withPipelineLock(pipelinePath, fn, options = {}) {
  const lock = await acquirePipelineLock(pipelinePath, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
