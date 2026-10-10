#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, realpathSync } from 'fs';
import { join, dirname, basename, resolve, isAbsolute, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import {
  isMkdirContention, isRmContention, rmLockArtifactSync, createLockWaitPolicy,
  sameLockDirectory, lockRecoveryVerdict, RECOVER_STALE,
} from './pipeline-lock.mjs';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import { tmpdir } from 'os';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  resolveCadenceConfig,
  normalizeStatus,
  parseAppliedDate,
  parseNextOverrides,
  parseDate,
  addDays,
} from './followup-cadence.mjs';
import { getCareerOpsRoot, resolveTrackerPath as sharedResolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

export const FOLLOWUPS_HEADER = [
  '# Follow-ups',
  '',
  '| num | appNum | date | company | role | channel | contact | notes |',
  '|---|---|---|---|---|---|---|---|',
].join('\n');

const FOLLOWUPS_LOCK_PREFIX = 'career-ops-followups-';

export { OWNERLESS_GRACE_MS } from './pipeline-lock.mjs';

export class SeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
  }
}

function todayStr() {
  return localToday();
}

export function isValidCalendarDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = parseDate(str);
  if (!d || isNaN(d)) return false;
  return d.toISOString().slice(0, 10) === str;
}

export function resolveAppliedDate(row, explicitDate) {
  if (explicitDate) return { appliedDate: explicitDate, appDateSource: 'explicit' };
  const notesDate = parseAppliedDate(row?.notes);
  if (notesDate) {
    if (!isValidCalendarDate(notesDate)) {
      throw new SeedError('INVALID_DATE', `Application #${row?.num ?? '?'} notes carry an impossible "Applied ${notesDate}" date; fix the notes or pass --date`);
    }
    return { appliedDate: notesDate, appDateSource: 'notes' };
  }
  const columnDate = String(row?.date ?? '').trim();
  if (isValidCalendarDate(columnDate)) {
    return { appliedDate: columnDate, appDateSource: 'evaluation-date' };
  }
  return { appliedDate: todayStr(), appDateSource: 'today' };
}

export function formatPinLine(appNum, nextDate, setDate) {
  return `- next #${appNum} ${nextDate} (set ${setDate})`;
}

function resolveTrackerPath(override) {
  if (override) return override;
  return sharedResolveTrackerPath(CAREER_OPS);
}

function resolveFollowupsPath(override) {
  if (override) return override;
  if (process.env.CAREER_OPS_FOLLOWUPS) return process.env.CAREER_OPS_FOLLOWUPS;
  return join(CAREER_OPS, 'data/follow-ups.md');
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readTrackerRows(trackerPath) {
  const content = readFileSync(trackerPath, 'utf-8');
  const lines = content.split('\n');
  const parseOptions = { allowTabs: true, allowIndentation: true };
  const colmap = resolveColumns(lines, parseOptions);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap, parseOptions);
    if (row) rows.push(row);
  }
  return rows;
}

function hasFollowupTableRow(content, appNum) {
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 8) continue;
    const rowAppNum = parseInt(parts[2], 10);
    if (!isNaN(rowAppNum) && rowAppNum === appNum) return true;
  }
  return false;
}

function isAlreadySeeded(content, appNum) {
  if (!content) return false;
  if (parseNextOverrides(content).has(appNum)) return true;
  return hasFollowupTableRow(content, appNum);
}

function pathIsInside(childPath, parentDir) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function resolveFollowupsLockDir(envValue, lockKey) {
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `${FOLLOWUPS_LOCK_PREFIX}${lockKey}.lock`);
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith(FOLLOWUPS_LOCK_PREFIX)) return fallback;
  return candidate;
}

function resolveLockDir(explicitLockDir, followupsPath) {
  if (explicitLockDir) return explicitLockDir;
  const lockKey = createHash('sha256').update(followupsPath).digest('hex').slice(0, 16);
  return resolveFollowupsLockDir(process.env.CAREER_OPS_FOLLOWUPS_LOCK, lockKey);
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function acquireFollowupsLock(lockDir, followupsPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();

  const { backoffMs, holderStillWedged, noteWaiting, ceilingReached } = createLockWaitPolicy(lockDir, {
    timeoutMs, retryMs, deadline: Date.now() + timeoutMs,
  });
  for (;;) {
    if (holderStillWedged() || ceilingReached()) break;
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
        followups: followupsPath,
      }, null, 2));

      let released = false;
      return {
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
          rmLockArtifactSync(lockDir);
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
        if (guardErr.code !== 'EEXIST') {
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
            if (rmLockArtifactSync(lockDir)) continue;
          }
        } finally {
          rmLockArtifactSync(recoverGuardDir);
        }
      }

      await sleep(backoffMs());
    }
  }

  throw new SeedError('LOCK_TIMEOUT', `Timed out waiting for follow-ups lock at ${lockDir}`);
}

function writeFileAtomic(filePath, content) {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSyncWithRetry(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function appendPins(existingContent, pinLines) {
  const joined = pinLines.join('\n');
  if (existingContent == null) {
    return `${FOLLOWUPS_HEADER}\n${joined}\n`;
  }
  return existingContent + (existingContent.endsWith('\n') ? '' : '\n') + joined + '\n';
}

export async function withFollowupsLock(followupsPath, fn, options = {}) {
  const resolvedPath = resolveFollowupsPath(followupsPath);
  const lockDir = resolveLockDir(options.lockDir, resolvedPath);
  const lock = await acquireFollowupsLock(lockDir, resolvedPath, {
    timeoutMs: options.timeoutMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_TIMEOUT_MS', 60_000),
    retryMs: options.retryMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_RETRY_MS', 75),
    staleMs: options.staleMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_STALE_MS', 10 * 60_000),
  });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export async function seedFollowup(appNum, options = {}) {
  if (!Number.isInteger(appNum) || appNum <= 0) {
    throw new SeedError('USAGE', `Invalid appNum: ${appNum}`);
  }
  if (options.date != null && !isValidCalendarDate(options.date)) {
    throw new SeedError('INVALID_DATE', `--date must be a real calendar date in YYYY-MM-DD form: ${options.date}`);
  }

  const trackerPath = resolveTrackerPath(options.trackerPath);
  const followupsPath = resolveFollowupsPath(options.followupsPath);

  if (!existsSync(trackerPath)) {
    throw new SeedError('ROW_NOT_FOUND', `Tracker not found at ${trackerPath}`);
  }
  const rows = readTrackerRows(trackerPath);
  const row = rows.find(r => r.num === appNum);
  if (!row) {
    throw new SeedError('ROW_NOT_FOUND', `Application #${appNum} not found in ${trackerPath}`);
  }

  const normalized = normalizeStatus(row.status);
  if (normalized !== 'applied' && !options.force && !options.assumeApplied) {
    throw new SeedError('NOT_APPLIED', `Application #${appNum} is not Applied (status: "${row.status.trim()}"); use --force to seed anyway`);
  }

  const { appliedDate, appDateSource } = resolveAppliedDate(row, options.date);
  const cadence = resolveCadenceConfig({ profilePath: options.profilePath });
  const nextDate = addDays(parseDate(appliedDate), cadence.applied_first);
  const setDate = todayStr();
  const pin = formatPinLine(appNum, nextDate, setDate);

  if (options.dryRun) {
    const existingContent = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf-8') : '';
    if (isAlreadySeeded(existingContent, appNum) && !options.force) {
      return { seeded: false, appNum, pin: null, nextDate, appliedDate, appDateSource, setDate, reason: 'already-seeded', dryRun: true };
    }
    return { seeded: true, appNum, pin, nextDate, appliedDate, appDateSource, setDate, dryRun: true };
  }

  const lockDir = resolveLockDir(options.lockDir, followupsPath);
  const lock = await acquireFollowupsLock(lockDir, followupsPath, {
    timeoutMs: options.lockTimeoutMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_TIMEOUT_MS', 60_000),
    retryMs: options.lockRetryMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_RETRY_MS', 75),
    staleMs: options.lockStaleMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_STALE_MS', 10 * 60_000),
  });

  try {
    const existingContent = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf-8') : null;
    if (existingContent != null && isAlreadySeeded(existingContent, appNum) && !options.force) {
      return { seeded: false, appNum, pin: null, nextDate, appliedDate, appDateSource, setDate, reason: 'already-seeded' };
    }

    mkdirSync(dirname(followupsPath), { recursive: true });
    writeFileAtomic(followupsPath, appendPins(existingContent, [pin]));
    return { seeded: true, appNum, pin, nextDate, appliedDate, appDateSource, setDate };
  } finally {
    lock.release();
  }
}

export async function seedBackfill(options = {}) {
  const trackerPath = resolveTrackerPath(options.trackerPath);
  const followupsPath = resolveFollowupsPath(options.followupsPath);

  if (!existsSync(trackerPath)) {
    throw new SeedError('ROW_NOT_FOUND', `Tracker not found at ${trackerPath}`);
  }
  const rows = readTrackerRows(trackerPath);
  const appliedRows = rows.filter(r => normalizeStatus(r.status) === 'applied');
  const cadence = resolveCadenceConfig({ profilePath: options.profilePath });
  const setDate = todayStr();

  function planFor(row) {
    const { appliedDate, appDateSource } = resolveAppliedDate(row, null);
    const nextDate = addDays(parseDate(appliedDate), cadence.applied_first);
    return { appNum: row.num, pin: formatPinLine(row.num, nextDate, setDate), nextDate, appliedDate, appDateSource, setDate };
  }

  if (options.dryRun) {
    const existingContent = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf-8') : '';
    const seeded = [];
    const skipped = [];
    for (const row of appliedRows) {
      if (isAlreadySeeded(existingContent, row.num) && !options.force) {
        skipped.push({ appNum: row.num, reason: 'already-seeded' });
        continue;
      }
      try {
        seeded.push({ ...planFor(row), dryRun: true });
      } catch (err) {
        if (err instanceof SeedError && err.code === 'INVALID_DATE') {
          skipped.push({ appNum: row.num, reason: 'invalid-notes-date', detail: err.message });
        } else {
          throw err;
        }
      }
    }
    return { seeded, skipped, dryRun: true };
  }

  const lockDir = resolveLockDir(options.lockDir, followupsPath);
  const lock = await acquireFollowupsLock(lockDir, followupsPath, {
    timeoutMs: options.lockTimeoutMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_TIMEOUT_MS', 60_000),
    retryMs: options.lockRetryMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_RETRY_MS', 75),
    staleMs: options.lockStaleMs ?? envInt('CAREER_OPS_FOLLOWUPS_LOCK_STALE_MS', 10 * 60_000),
  });

  try {
    const existingContent = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf-8') : null;
    const checkContent = existingContent ?? '';
    const seeded = [];
    const skipped = [];
    const newPins = [];
    for (const row of appliedRows) {
      if (isAlreadySeeded(checkContent, row.num) && !options.force) {
        skipped.push({ appNum: row.num, reason: 'already-seeded' });
        continue;
      }
      let plan;
      try {
        plan = planFor(row);
      } catch (err) {
        if (err instanceof SeedError && err.code === 'INVALID_DATE') {
          skipped.push({ appNum: row.num, reason: 'invalid-notes-date', detail: err.message });
          continue;
        }
        throw err;
      }
      seeded.push(plan);
      newPins.push(plan.pin);
    }

    if (newPins.length > 0) {
      mkdirSync(dirname(followupsPath), { recursive: true });
      writeFileAtomic(followupsPath, appendPins(existingContent, newPins));
    }

    return { seeded, skipped };
  } finally {
    lock.release();
  }
}

function parseCliArgs(argv) {
  const opts = { force: false, dryRun: false, json: false, backfill: false, date: null, appNum: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      i++;
      if (argv[i] === undefined) throw new SeedError('USAGE', '--date requires a value');
      opts.date = argv[i];
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--backfill') {
      opts.backfill = true;
    } else if (a.startsWith('--')) {
      throw new SeedError('USAGE', `Unknown flag: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  if (opts.backfill) {
    if (positionals.length !== 0) {
      throw new SeedError('USAGE', '--backfill does not take a positional appNum');
    }
    if (opts.date != null) {
      throw new SeedError('USAGE', '--date cannot be combined with --backfill (each row resolves its own apply date from its notes)');
    }
  } else {
    if (positionals.length !== 1) {
      throw new SeedError('USAGE', 'Usage: node followup-seed.mjs <appNum> [--date YYYY-MM-DD] [--force] [--dry-run] [--json]');
    }
    const raw = positionals[0];
    const n = parseInt(raw, 10);
    if (isNaN(n) || n <= 0 || String(n) !== raw.trim()) {
      throw new SeedError('USAGE', `Invalid appNum: ${raw}`);
    }
    opts.appNum = n;
  }

  return opts;
}

const EXIT_CODES = {
  USAGE: 1,
  INVALID_DATE: 1,
  NOT_APPLIED: 1,
  ROW_NOT_FOUND: 2,
  LOCK_TIMEOUT: 4,
};

function failWith(exitCode, code, message, json) {
  if (json) console.log(JSON.stringify({ error: message, code }));
  console.error(`❌ ${message}`);
  process.exit(exitCode);
}

function appDateNote(source) {
  if (source === 'evaluation-date') return ', from the evaluation date — notes carry no apply date';
  if (source === 'today') return ', assumed today — no apply date and no evaluation date';
  return '';
}

function reportSingle(result, json) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const dryTag = result.dryRun ? ' [dry-run]' : '';
  if (result.seeded) {
    console.log(`✅ Seeded #${result.appNum}: next follow-up ${result.nextDate} (applied ${result.appliedDate}${appDateNote(result.appDateSource)}, set ${result.setDate})${dryTag}`);
  } else {
    console.log(`⏭️  #${result.appNum} already seeded — no-op (${result.reason})${dryTag}`);
  }
}

function reportBackfill(result, json) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const dryTag = result.dryRun ? ' [dry-run]' : '';
  console.log(`✅ Backfill${dryTag}: seeded ${result.seeded.length}, skipped ${result.skipped.length}`);
  for (const s of result.seeded) console.log(`  + #${s.appNum}: next ${s.nextDate}${appDateNote(s.appDateSource)}`);
  for (const s of result.skipped) console.log(`  - #${s.appNum}: ${s.reason}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonRequested = argv.includes('--json');
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    failWith(EXIT_CODES[err.code] ?? 1, err.code || 'USAGE', err.message, jsonRequested);
    return;
  }

  try {
    if (opts.backfill) {
      const result = await seedBackfill({ dryRun: opts.dryRun, force: opts.force });
      reportBackfill(result, opts.json);
    } else {
      const result = await seedFollowup(opts.appNum, { date: opts.date, force: opts.force, dryRun: opts.dryRun });
      reportSingle(result, opts.json);
    }
    process.exit(0);
  } catch (err) {
    const code = err.code || 'ERROR';
    const exitCode = EXIT_CODES[code] ?? 1;
    failWith(exitCode, code, err.message, opts.json);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
