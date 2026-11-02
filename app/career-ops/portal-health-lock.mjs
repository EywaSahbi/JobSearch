import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  isMkdirContention, rmLockArtifactSync, createLockWaitPolicy,
  lockRecoveryVerdict, RECOVER_STALE,
} from './pipeline-lock.mjs';

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 80;
const DEFAULT_TIMEOUT_MS = 8_000;

export { OWNERLESS_GRACE_MS } from './pipeline-lock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LockTimeoutError extends Error {
  constructor(lockDir, timeoutMs) {
    super(`portal-health lock timeout: ${lockDir} held > ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
    this.lockDir = lockDir;
  }
}

function lockDirFor(filePath) {
  return `${filePath}.lock`;
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function sameLockDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs);
}

export async function acquirePortalHealthLock(filePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const retryMs = options.retryMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_RETRY_MS) || DEFAULT_RETRY_MS);
  const staleMs = options.staleMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_STALE_MS) || DEFAULT_STALE_MS);
  const lockDir = lockDirFor(filePath);
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const { backoffMs, holderStillWedged, noteWaiting, ceilingReached } = createLockWaitPolicy(lockDir, {
    timeoutMs, retryMs, deadline,
  });

  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if (!isMkdirContention(err)) throw err;
      noteWaiting();

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (!isMkdirContention(guardErr)) throw guardErr;
        if (guardErr.code !== 'EEXIST') {
          if (holderStillWedged() || ceilingReached()) throw new LockTimeoutError(lockDir, timeoutMs);
          await sleep(backoffMs());
          continue;
        }
        if (lockRecoveryVerdict(recoverGuardDir, staleMs) === RECOVER_STALE) {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      if (hasRecoverGuard) {
        try {
          if (lockRecoveryVerdict(lockDir, staleMs) === RECOVER_STALE) {
            rmLockArtifactSync(lockDir);
            continue;
          }
        } finally {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      if (holderStillWedged() || ceilingReached()) throw new LockTimeoutError(lockDir, timeoutMs);
      await sleep(backoffMs());
      continue;
    }

    try {
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        file: filePath,
      }, null, 2));
    } catch (ownerErr) {
      rmLockArtifactSync(lockDir);
      throw ownerErr;
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
        const owner = readLockOwner(lockDir);
        if (owner?.token !== token) return;
        let after;
        try {
          after = statSync(lockDir);
        } catch {
          return;
        }
        if (!sameLockDirectory(before, after)) return;
        try {
          rmLockArtifactSync(lockDir);
        } catch {
        }
      },
    };
  }
}

export async function withPortalHealthLock(filePath, fn, options = {}) {
  const lock = await acquirePortalHealthLock(filePath, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
