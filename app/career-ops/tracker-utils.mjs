import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, statSync, lstatSync, existsSync, realpathSync, chmodSync } from 'fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'path';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import * as yaml from 'js-yaml';
import {
  isMkdirContention, isRmContention, rmLockArtifactSync, createLockWaitPolicy,
  lockRecoveryVerdict, RECOVER_STALE,
} from './pipeline-lock.mjs';
import { normalizeTextKey } from './tracker-parse.mjs';

export { OWNERLESS_GRACE_MS } from './pipeline-lock.mjs';

export function rebuildRow(parts) {
  const cells = parts.slice(1);
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return '| ' + cells.join(' | ') + ' |';
}

export function findDeadReportLink(reportCell, trackerDir, dataRoot, options = {}) {
  const match = String(reportCell ?? '').match(/\]\(([^)]+)\)/);
  if (!match) return null;
  const link = match[1];
  const inspect = options.stat ?? statSync;
  const errors = [];
  const candidates = [...new Set([join(trackerDir, link), join(dataRoot, link)])];
  for (const path of candidates) {
    try {
      if (inspect(path).isFile()) return null;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') errors.push({ path, error: err });
    }
  }
  if (errors.length > 0) {
    options.onInspectionError?.({ link, errors });
    return null;
  }
  return link;
}

export function normalizeCompany(name) {
  return normalizeTextKey(name);
}

export const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function cell(v) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(/\s*\|\s*/g, ' / ')
    .trim();
}

export { resolveTrackerPath } from './path-resolver.mjs';

export function resolveWorkspaceRoot(trackerPath) {
  const trackerDir = dirname(trackerPath);
  return basename(trackerDir) === 'data' ? dirname(trackerDir) : trackerDir;
}

export function resolveWorkspaceRootFor(rootDir) {
  return resolveWorkspaceRoot(resolve(rawTrackerPath(rootDir)));
}

export function resolvePdfIndexPath(trackerPath) {
  return process.env.CAREER_OPS_PDF_INDEX
    || join(resolveWorkspaceRoot(trackerPath), 'data', 'pdf-index.tsv');
}

import { canonicalizeTrackerPath, rawTrackerPath } from './path-resolver.mjs';
export { canonicalizeTrackerPath };

export function pathIsInside(childPath, parentDir, pathMod = { relative, isAbsolute, sep }) {
  const relativePath = pathMod.relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${pathMod.sep}`) && !pathMod.isAbsolute(relativePath));
}

function nearestExistingPath(pathValue) {
  let candidate = pathValue;
  while (true) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export function pathIsInsideCanonical(childPath, parentDir) {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (!pathIsInside(child, parent)) return false;

  try {
    const canonicalParent = realpathSync(parent);
    const canonicalChild = realpathSync(nearestExistingPath(child));
    return pathIsInside(canonicalChild, canonicalParent);
  } catch {
    return false;
  }
}

export function trackerLockDirFor(appsFile) {
  const lockKey = createHash('sha256').update(appsFile).digest('hex').slice(0, 16);
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `career-ops-merge-tracker-${lockKey}.lock`);
  const envValue = process.env.CAREER_OPS_TRACKER_LOCK;
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith('career-ops-merge-tracker-')) return fallback;
  return candidate;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export async function acquireTrackerLock(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const startedAt = Date.now();
  let attempts = 0;
  let staleRecovered = false;

  const { backoffMs, holderStillWedged, noteWaiting, ceilingReached } = createLockWaitPolicy(lockDir, {
    timeoutMs, retryMs, deadline: Date.now() + timeoutMs,
  });
  for (;;) {
    if (holderStillWedged() || ceilingReached()) break;
    attempts++;
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token,
          started_at: new Date().toISOString(),
          tracker: options.tracker ?? '',
        }, null, 2));
      } catch (ownerErr) {
        if (ownerErr?.code === 'ENOENT') continue;
        rmLockArtifactSync(lockDir);
        throw ownerErr;
      }

      let ownerVerified = false;
      let verifiedDir = null;
      let released = false;
      const removeLock = typeof options.removeLock === 'function'
        ? options.removeLock
        : path => rmSync(path, { recursive: true, force: true });
      return {
        attempts,
        waitMs: Date.now() - startedAt,
        staleRecovered,
        release() {
          if (released) return;
          if (ownerVerified) {
            let currentDir;
            try {
              currentDir = statSync(lockDir);
            } catch (err) {
              if (err?.code === 'ENOENT') {
                released = true;
                return;
              }
              throw err;
            }
            if (!sameLockDirectory(verifiedDir, currentDir)) {
              released = true;
              return;
            }
            const owner = readLockOwner(lockDir);
            if (owner && owner.token !== token) {
              released = true;
              return;
            }
            if (!owner && existsSync(join(lockDir, 'owner.json'))) {
              throw new Error(`Cannot verify tracker lock ownership at ${lockDir}`);
            }
          } else {
            let beforeRead;
            try {
              beforeRead = statSync(lockDir);
            } catch (err) {
              if (err?.code === 'ENOENT') {
                released = true;
                return;
              }
              throw err;
            }
            const owner = readLockOwner(lockDir);
            if (owner?.token !== token) {
              if (owner) released = true;
              else throw new Error(`Cannot verify tracker lock ownership at ${lockDir}`);
              return;
            }
            const afterRead = statSync(lockDir);
            if (!sameLockDirectory(beforeRead, afterRead)) {
              released = true;
              return;
            }
            ownerVerified = true;
            verifiedDir = afterRead;
          }
          try {
            removeLock(lockDir);
          } catch (rmErr) {
            if (!isRmContention(rmErr)) throw rmErr;
          }
          released = true;
        },
      };
    } catch (err) {
      if (!isMkdirContention(err)) throw err;
      noteWaiting();

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (!isMkdirContention(guardErr)) throw guardErr;
        if (guardErr.code === 'EEXIST'
          && lockRecoveryVerdict(recoverGuardDir, staleMs) === RECOVER_STALE) {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      if (hasRecoverGuard) {
        const testWaitingMarker = process.env.NODE_ENV === 'test'
          ? process.env.CAREER_OPS_TRACKER_TEST_LOCK_WAIT_MARKER
          : undefined;
        if (testWaitingMarker) {
          try {
            writeFileSync(testWaitingMarker, JSON.stringify({
              pid: process.pid, lockDir, guardCreated: true,
            }), { flag: 'wx' });
          } catch {
          }
        }

        try {
          if (lockRecoveryVerdict(lockDir, staleMs) === RECOVER_STALE) {
            if (rmLockArtifactSync(lockDir)) {
              staleRecovered = true;
              continue;
            }
          }
        } finally {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      await sleep(backoffMs());
    }
  }

  const timeoutErr = new Error(`Timed out waiting for tracker lock at ${lockDir}`);
  timeoutErr.code = 'LOCK_TIMEOUT';
  throw timeoutErr;
}

export async function openTrackerTransaction(appsFile, options = {}) {
  const trackerPath = canonicalizeTrackerPath(appsFile);
  const { lockDir = trackerLockDirFor(trackerPath), ...lockOptions } = options;
  const lock = await acquireTrackerLock(lockDir, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
    tracker: trackerPath,
    ...lockOptions,
  });
  let closed = false;
  let closeError = null;
  const assertOpen = () => {
    if (closed) throw new Error('Tracker transaction is already closed');
  };
  return {
    path: trackerPath,
    read() {
      assertOpen();
      return readFileSync(trackerPath, 'utf-8');
    },
    replace(content) {
      assertOpen();
      writeFileAtomic(trackerPath, content);
    },
    close() {
      if (closed) return closeError;
      try {
        lock.release();
      } catch (err) {
        closeError = err;
        console.error(`Warning: tracker transaction closed but lock cleanup failed at ${lockDir}: ${err.message}`);
      } finally {
        closed = true;
      }
      return closeError;
    },
  };
}

const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export const RENAME_RETRY_DELAYS_MS = [1, 2, 5, 10, 25, 50, 100];

export function isRenameContention(err) {
  return RENAME_CONTENTION_CODES.has(err?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameSyncWithRetry(tmpPath, path, rename = renameSync) {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmpPath, path);
      return;
    } catch (err) {
      if (!isRenameContention(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function writeFileAtomic(path, content, { mode } = {}) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    if (mode === undefined) {
      writeFileSync(tmpPath, content);
    } else {
      writeFileSync(tmpPath, content, { mode });
      chmodSync(tmpPath, mode);
    }
    renameSyncWithRetry(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function loadCanonicalStates(statesPath) {
  const doc = yaml.load(readFileSync(statesPath, 'utf-8'));
  if (!doc || !Array.isArray(doc.states)) {
    throw new Error(`Malformed states file at ${statesPath}: expected a top-level "states" list`);
  }
  return doc.states.map(s => ({
    id: String(s.id ?? ''),
    label: String(s.label ?? ''),
    aliases: Array.isArray(s.aliases) ? s.aliases.map(String) : [],
    description: String(s.description ?? ''),
    terminal: s.terminal === true,
  }));
}

export function foldStatusInput(input) {
  return String(input ?? '')
    .replace(/\*\*/g, '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u0307/gu, '');
}

export function resolveCanonicalState(input, states) {
  const clean = foldStatusInput(input);
  if (!clean) return null;
  for (const s of states) {
    if (s.label.toLowerCase() === clean) return s.label;
    if (s.id.toLowerCase() === clean) return s.label;
    if (s.aliases.some(a => a.toLowerCase() === clean)) return s.label;
  }
  return null;
}

export const CLI_EXIT = { OK: 0, USAGE: 1, NOT_FOUND: 2, AMBIGUOUS: 3, LOCK_TIMEOUT: 4 };

export function makeCliFailWith(json) {
  return function failWith(exitCode, code, message, extra = {}) {
    if (json) {
      console.log(JSON.stringify({ error: message, code, ...extra }));
    }
    console.error(`❌ ${message}`);
    process.exit(exitCode);
  };
}

export async function acquireTrackerLockForCli(appsFile, { dryRun, failWith }) {
  if (dryRun) return null;
  let lock;
  try {
    lock = await acquireTrackerLock(trackerLockDirFor(appsFile), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
      staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
      tracker: appsFile,
    });
  } catch (err) {
    if (err?.code === 'LOCK_TIMEOUT') {
      failWith(CLI_EXIT.LOCK_TIMEOUT, 'lock-timeout', err.message);
    } else {
      failWith(CLI_EXIT.USAGE, 'lock-error', `Cannot acquire tracker lock: ${err.message}`);
    }
    throw err;
  }
  process.once('exit', () => lock.release());
  return lock;
}
