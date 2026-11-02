import { readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const SCRATCH_PREFIX = '.tmp-script-test-';

export function isScratchDir(name) {
  return name.startsWith(SCRATCH_PREFIX);
}

export const MIN_SCRATCH_AGE_MS = 60 * 60 * 1000;

export const SCRATCH_OWNER_FILE = '.owner-pid';

export const MAX_SCRATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function markScratchOwner(dir, pid = process.pid) {
  writeFileSync(join(dir, SCRATCH_OWNER_FILE), `${pid}\n`);
}

export function scratchOwnerAlive(dir, signal = (pid) => process.kill(pid, 0)) {
  let pid;
  try {
    pid = Number.parseInt(readFileSync(join(dir, SCRATCH_OWNER_FILE), 'utf-8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    signal(pid);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function sweepScratchDirs(root, options = {}) {
  const {
    minAgeMs = MIN_SCRATCH_AGE_MS,
    maxAgeMs = MAX_SCRATCH_AGE_MS,
    now = Date.now,
    remove = (dir) => rmSync(dir, { recursive: true, force: true }),
    isAlive = scratchOwnerAlive,
  } = options;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [], failed: [] };
  }

  const removed = [];
  const kept = [];
  const failed = [];
  const at = now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !isScratchDir(entry.name)) continue;
    const dir = join(root, entry.name);

    let age;
    try {
      age = at - statSync(dir).mtimeMs;
    } catch {
      continue;
    }

    if (age < maxAgeMs && isAlive(dir)) {
      kept.push(entry.name);
      continue;
    }
    if (age < minAgeMs) {
      kept.push(entry.name);
      continue;
    }

    try {
      remove(dir);
      removed.push(entry.name);
    } catch (err) {
      failed.push({ name: entry.name, error: err?.message ?? String(err) });
    }
  }
  return { removed: removed.sort(), kept: kept.sort(), failed };
}
