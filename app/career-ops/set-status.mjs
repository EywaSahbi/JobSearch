#!/usr/bin/env node

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname, resolve, sep, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { extractTrackerReportNumbers, resolveColumns, parseTrackerRow, normalizeTextKey, splitTrackerCells, trackerRowSeparator } from './tracker-parse.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  resolveTrackerPath, writeFileAtomic, loadCanonicalStates, resolveCanonicalState,
  normalizeCompany, cell, CLI_EXIT, makeCliFailWith, acquireTrackerLockForCli, resolveWorkspaceRoot,
} from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { claimActivity, releaseActivity, describeActiveOwner } from './session-activity.mjs';
import { hasEmbeddedJdArchive } from './check-jd-archive.mjs';
import { captureSlug, findCaptureForReport } from './jd-capture.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const STATES_FILE = join(CODE_ROOT, 'templates/states.yml');
const JD_ARCHIVE_TIMEOUT_MS = Math.min(
  300_000,
  Math.max(100, Number(process.env.CAREER_OPS_JD_ARCHIVE_TIMEOUT_MS) || 120_000),
);

const { OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND, AMBIGUOUS: EXIT_AMBIGUOUS } = CLI_EXIT;

const USAGE = `Usage: node set-status.mjs <report#|company> <state> [--note "..."] [--role "..."] [--on YYYY-MM-DD] [--force] [--dry-run] [--json]
       node set-status.mjs --row N <state> [...]        (explicit tracker row ID)
       node set-status.mjs --report N <state> [...]     (explicit report ID)
       node set-status.mjs --report-link N <state> [...] (strict Report-cell identity)

  <report#|company>  Row selector: tracker # (exact) or company name (normalized match)
  <state>            Canonical state from templates/states.yml (aliases accepted)
  --row N            Select by tracker # explicitly (unambiguous; skips the mismatch guard)
  --report N         Select the row whose Report cell links report #N
  --report-link N    Select an exact numeric Report link; reject malformed cells
                     and unknown current states (used by the dashboard)
  --note "..."       Append to the Notes cell ("; "-separated, idempotent)
  --note=VALUE       Pass a literal note, including text beginning with --
  --replace-note "OLD" Replace whole OLD notes with --note text; fail if neither is present
  --role "..."       Disambiguate when several rows share the company (fuzzy match)
  --on YYYY-MM-DD    Real event date for the status-log entry (defaults to today —
                     pass it when the transition happened earlier than it's recorded)
  --source NAME      Attribution for the transition ledger: set-status (default)
                     or web (a caller delegating to this script)
  --force            Allow a numeric selector despite a report-link mismatch, or despite a
                     report-less row whose number another row claims as its report link
  --dry-run          Resolve and validate, but write nothing
  --repair-status-log  On an idempotent Applied retry, repair a missing ledger observation
  --repair-followup  On an idempotent Applied retry, repair a missing follow-up pin
  --json             Machine-readable output on stdout (errors included)

  Tracker row IDs and report IDs are separate counters that diverge permanently
  once any row exists without a report. Prefer --row/--report (or the company
  name) over a bare number, and prefer any of them over --force.

Examples:
  node set-status.mjs --report 12 Applied
  node set-status.mjs --report 12 Interview --note "recruiter screen booked"
  node set-status.mjs "Acme Corp" Rejected --on 2026-08-01
  node set-status.mjs "Acme Corp" Applied --role "Platform Engineer"
  node set-status.mjs --row 7 Discarded --dry-run`;

function renderStatesSection() {
  let states;
  try {
    states = loadCanonicalStates(STATES_FILE);
  } catch {
    return `\nCanonical states: see ${STATES_FILE}`;
  }
  if (!states.length) return `\nCanonical states: see ${STATES_FILE}`;
  const width = Math.max(...states.map(st => st.label.length));
  const lines = states.map((st) => {
    const terminal = st.terminal ? '  (terminal)' : '';
    const desc = st.description ? `  ${st.description}` : '';
    return `  ${st.label.padEnd(width)}${desc}${terminal}`;
  });
  return [
    '',
    'Canonical states (aliases also accepted — see templates/states.yml):',
    ...lines,
    '',
    '  A terminal state ends the application. Discarded is YOUR decision or a',
    '  closed req; Rejected is theirs; SKIP means never applied for.',
  ].join('\n');
}

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = { note: null, replaceNote: null, role: null, on: null, row: null, report: null, reportLink: null, source: null, force: false, dryRun: false, repairStatusLog: false, repairFollowup: false, json: false };
const VALUE_FLAGS = { '--note': 'note', '--replace-note': 'replaceNote', '--role': 'role', '--on': 'on', '--row': 'row', '--report': 'report', '--report-link': 'reportLink', '--source': 'source' };

function wantsHelp(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (Object.hasOwn(VALUE_FLAGS, a)) { i++; continue; }
    if (a === '--help' || a === '-h') return true;
  }
  return false;
}

if (wantsHelp(rawArgs)) {
  console.log(`${USAGE}\n${renderStatesSection()}`);
  process.exit(EXIT_OK);
}

const WRITER_SOURCES = new Set(['set-status', 'web', 'reply-watch']);

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith('--note=')) {
    flags.note = a.slice('--note='.length);
  } else if (a in VALUE_FLAGS) {
    const value = rawArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      failUsage(`Missing value for ${a}`);
    }
    if ((a === '--row' || a === '--report' || a === '--report-link') && !/^\d+$/.test(value)) {
      failUsage(`${a} expects a positive integer, got "${value}"`);
    }
    if (a === '--source' && !WRITER_SOURCES.has(value)) {
      failUsage(`--source expects one of ${[...WRITER_SOURCES].join(', ')}, got "${value}"`);
    }
    flags[VALUE_FLAGS[a]] = value;
    i++;
  }
  else if (a === '--force') { flags.force = true; }
  else if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--repair-status-log') { flags.repairStatusLog = true; }
  else if (a === '--repair-followup') { flags.repairFollowup = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a === '-h' || a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (flags.replaceNote !== null && (!cell(flags.replaceNote) || flags.note === null || !cell(flags.note))) {
  failUsage('--replace-note requires non-empty OLD and --note NEW values');
}

if ([flags.row, flags.report, flags.reportLink].filter(value => value !== null).length > 1) {
  failUsage('--row, --report and --report-link are mutually exclusive selectors');
}
const explicitSelector = flags.row !== null || flags.report !== null || flags.reportLink !== null;

if (explicitSelector) {
  if (positional.length !== 1) {
    failUsage(positional.length === 0
      ? `Expected the state after ${flags.row !== null ? '--row' : flags.report !== null ? '--report' : '--report-link'}`
      : `With ${flags.row !== null ? '--row' : flags.report !== null ? '--report' : '--report-link'} the only positional argument is the state, got ${positional.length}`);
  }
} else if (positional.length !== 2) {
  failUsage(positional.length === 0 ? null : `Expected 2 arguments (selector, state), got ${positional.length}`);
}

if (flags.on !== null) {
  const m = /^\d{4}-\d{2}-\d{2}$/.test(flags.on);
  const d = m ? new Date(`${flags.on}T00:00:00Z`) : null;
  const roundTrips = d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === flags.on;
  if (!roundTrips) failUsage(`--on expects a real date as YYYY-MM-DD, got "${flags.on}"`);
  if (flags.on > localToday()) failUsage(`--on date is in the future: "${flags.on}"`);
}

const selector = explicitSelector ? null : positional[0];
const stateInput = explicitSelector ? positional[0] : positional[1];

const isBareNumericSelector = selector !== null && /^\d+$/.test(selector);

const failWith = makeCliFailWith(flags.json);

function failUsage(message) {
  const msg = message ?? 'Expected 2 arguments: <report#|company> <state>';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

let states;
try {
  states = loadCanonicalStates(STATES_FILE);
} catch (err) {
  failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
}
const newStatus = resolveCanonicalState(stateInput, states);
if (!newStatus) {
  const valid = states.map(s => s.label).join(' · ');
  failWith(EXIT_USAGE, 'invalid-state', `"${stateInput}" is not a canonical state. Valid states: ${valid}`);
}

const APPS_FILE = resolveTrackerPath(DATA_ROOT);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

function resolveCandidates(matches, { notFound, ambiguous }) {
  if (matches.length === 0) {
    failWith(EXIT_NOT_FOUND, 'not-found', notFound);
  }
  if (matches.length > 1 && flags.role) {
    const narrowed = matches.filter(r => roleFuzzyMatch(r.role, flags.role));
    if (narrowed.length === 1) return narrowed[0];
  }
  if (matches.length > 1) {
    const candidates = matches.map(r => ({ num: r.num, company: r.company, role: r.role }));
    const listing = candidates.map(c => `#${c.num}\t${c.company}\t${c.role}`).join('\n');
    failWith(EXIT_AMBIGUOUS, 'ambiguous', ambiguous(matches.length, listing), { candidates });
  }
  return matches[0];
}

function resolveRow(rows) {
  if (flags.reportLink !== null) {
    const matches = [];
    for (const row of rows) {
      const links = [...String(row.report ?? '').matchAll(/\[(\d+)\]\(([^)]+)\)/g)];
      if (!links.some(link => link[1] === flags.reportLink)) continue;
      if (links.length !== 1 || links[0][0] !== String(row.report ?? '').trim()) {
        failWith(EXIT_AMBIGUOUS, 'malformed-report', `Malformed Report cell for report #${flags.reportLink}: expected exactly one report link`);
      }
      matches.push(row);
    }
    return resolveCandidates(matches, {
      notFound: `No tracker row has Report link #${flags.reportLink}`,
      ambiguous: () => `Report #${flags.reportLink} occurs in multiple tracker rows`,
    });
  }

  if (flags.report !== null) {
    const num = parseInt(flags.report, 10);
    return resolveCandidates(
      rows.filter(r => extractTrackerReportNumbers(r.report, r.notes).includes(num)),
      {
        notFound: `No tracker row links report #${num}. (Report IDs and tracker row IDs differ — ` +
          'use --row N to select by tracker #.)',
        ambiguous: (count, listing) =>
          `Report #${num} is linked by ${count} tracker rows — pass --role to disambiguate:\n${listing}`,
      },
    );
  }

  if (flags.row !== null || isBareNumericSelector) {
    const num = parseInt(flags.row !== null ? flags.row : selector, 10);
    return resolveCandidates(
      rows.filter(r => r.num === num),
      {
        notFound: `No tracker row with #${num}`,
        ambiguous: (count, listing) =>
          `#${num} is a duplicate tracker number shared by ${count} rows (see #1704) — ` +
          `pass --role to disambiguate, or use the company name instead:\n${listing}`,
      },
    );
  }

  const key = normalizeCompany(selector);
  if (!key) failUsage(`Selector "${selector}" is empty after normalization`);
  return resolveCandidates(
    rows.filter(r => normalizeCompany(r.company) === key),
    {
      notFound: `No tracker row with company matching "${selector}"`,
      ambiguous: (count, listing) =>
        `Company "${selector}" matches ${count} rows — pass the # or narrow with --role:\n${listing}`,
    },
  );
}

const lock = await acquireTrackerLockForCli(APPS_FILE, { dryRun: flags.dryRun, failWith });

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}
const lines = content.split('\n');
const parseOptions = { allowTabs: true, allowIndentation: true };
const colmap = resolveColumns(lines, parseOptions);

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap, parseOptions);
  if (row) rows.push({ ...row, lineIdx: i });
  else if (flags.reportLink !== null && colmap.report != null) {
    const report = splitTrackerCells(lines[i])[colmap.report] ?? '';
    if ([...String(report).matchAll(/\[(\d+)\]\(([^)]+)\)/g)].some(link => link[1] === flags.reportLink)) {
      failWith(EXIT_AMBIGUOUS, 'malformed-row', `Tracker row linking report #${flags.reportLink} has missing cells`);
    }
  }
}
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${APPS_FILE} has no data rows`);
}

const target = resolveRow(rows);

if (isBareNumericSelector && !flags.force) {
  const reportNums = extractTrackerReportNumbers(target.report, target.notes);
  const mismatched = reportNums.filter(num => num !== target.num);
  if (mismatched.length > 0) {
    failWith(
      EXIT_AMBIGUOUS,
      'report-number-mismatch',
      `Tracker #${target.num} points to report ID(s) ${reportNums.map(num => `#${num}`).join(', ')}. ` +
        `Say which you meant: --row ${target.num} (tracker row) or ` +
        `--report ${reportNums[0]} (report ID). ` +
        'The company selector also works; --force overrides the check instead of answering it.',
      { trackerNum: target.num, reportNums },
    );
  }

  if (reportNums.length === 0) {
    const num = parseInt(selector, 10);
    const linkers = rows.filter(r => r !== target && extractTrackerReportNumbers(r.report, r.notes).includes(num));
    if (linkers.length > 0) {
      const listing = linkers.map(r => `#${r.num}\t${r.company}\t${r.role}`).join('\n');
      failWith(
        EXIT_AMBIGUOUS,
        'report-number-ambiguous',
        `"${num}" is ambiguous: tracker row #${num} (${target.company} — ${target.role}) has no report, ` +
          `but report #${num} is linked by:\n${listing}\n` +
          `Say which you meant: --row ${num} (the row) or --report ${num} (the report).`,
        { trackerNum: target.num, reportNum: num, linkedBy: linkers.map(r => ({ num: r.num, company: r.company, role: r.role })) },
      );
    }
  }
}

const normalizeRoleText = s => normalizeTextKey(
  String(s ?? '')
    .normalize('NFKC')
    .replace(/\+\+/g, ' plusplus ')
    .replace(/#/g, ' sharp '),
  ' ',
);
const roleMatchesTarget = normalizeRoleText(target.role) === normalizeRoleText(flags.role)
  || roleFuzzyMatch(target.role, flags.role);

if (flags.role && !flags.force && !roleMatchesTarget) {
  failWith(
    EXIT_AMBIGUOUS,
    'role-mismatch',
    `Tracker #${target.num} (${target.company}) is "${target.role}", which does not match --role "${flags.role}". ` +
      'The row you meant may not be in the tracker. Re-run with --force to update this row anyway.',
    { trackerNum: target.num, rowRole: target.role, requestedRole: flags.role },
  );
}
const oldStatus = target.status;
if (flags.reportLink !== null && !resolveCanonicalState(oldStatus, states)) {
  failWith(EXIT_USAGE, 'invalid-current-state', `Tracker #${target.num} has an unrecognized current status: "${oldStatus}"`);
}
const rawLine = lines[target.lineIdx];
const separator = trackerRowSeparator(rawLine);
const note = flags.note != null
  ? cell(separator === '\t' ? flags.note.replace(/\t/g, ' ') : flags.note)
  : null;

let activityClaim = null;
if (!flags.dryRun) {
  const activityReportNums = extractTrackerReportNumbers(target.report, target.notes);
  const activityKey = activityReportNums.length
    ? `report:${activityReportNums[0]}`
    : `tracker-row:${normalizeCompany(target.company)}|${target.role}`;
  try {
    const claim = claimActivity(activityKey, {
      label: `set-status → ${newStatus}`,
      processBound: true,
    });
    if (claim.claimed) {
      activityClaim = { key: activityKey, token: claim.token };
    } else if (claim.owner) {
      console.warn(`⚠ ${describeActiveOwner(claim.owner)}`);
    }
  } catch (err) {
    console.warn(`⚠ session-activity claim failed (status change proceeding anyway): ${err.message}`);
  }
}

let statusChanged = false;
let noteChanged = false;
let statusLogged = false;
let statusLogRepaired = false;
let statusLogRepair = null;
const replacedNote = flags.replaceNote !== null ? cell(flags.replaceNote) : null;
try {
  const parts = splitTrackerCells(rawLine);
  while (parts.length <= Math.max(colmap.status, colmap.notes ?? 0)) parts.push('');

  const replaceCellValue = (index, value) => {
    const original = parts[index] ?? '';
    const trimmed = original.trim();
    if (trimmed) {
      const start = original.indexOf(trimmed);
      parts[index] = original.slice(0, start) + value + original.slice(start + trimmed.length);
    } else if (original.length >= 2) {
      const half = Math.floor(original.length / 2);
      parts[index] = original.slice(0, half) + value + original.slice(half);
    } else {
      parts[index] = ` ${value} `;
    }
  };

  statusChanged = parts[colmap.status].trim() !== newStatus;
  if (statusChanged) replaceCellValue(colmap.status, newStatus);

  if (note) {
    if (colmap.notes == null) {
      failWith(EXIT_USAGE, 'no-notes-column', 'Tracker has no Notes column — cannot apply --note');
    }
    const existing = (parts[colmap.notes] ?? '').trim();
    if (replacedNote !== null) {
      const alternatives = [note, replacedNote].sort((a, b) => b.length - a.length)
        .map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const wholeNotes = new RegExp(`(^|; )(${alternatives.join('|')})(?=; |$)`, 'g');
      let found = false;
      const updated = existing.replace(wholeNotes, (_match, prefix, entry) => {
        found = true;
        return prefix + (entry === replacedNote ? note : entry);
      });
      if (!found) {
        failWith(EXIT_USAGE, 'replace-note-not-found', 'Neither --replace-note nor --note matches a whole note in the Notes cell');
      }
      replaceCellValue(colmap.notes, updated);
      noteChanged = updated !== existing;
    } else {
      const hasNote = existing === note
        || existing.startsWith(`${note}; `)
        || existing.endsWith(`; ${note}`)
        || existing.includes(`; ${note}; `);
      if (!hasNote) {
        replaceCellValue(colmap.notes, existing && existing !== '—' && existing !== '-' ? `${existing}; ${note}` : note);
        noteChanged = true;
      }
    }
  }

  if ((statusChanged || noteChanged) && !flags.dryRun) {
    if (separator === '\t') {
      const closing = rawLine.trimEnd().endsWith('|');
      lines[target.lineIdx] = parts[0] + '|' + parts.slice(1, closing ? -1 : undefined).join('\t')
        + (closing ? '|' + parts.at(-1) : '');
    } else {
      lines[target.lineIdx] = parts.join('|');
    }
    try {
      writeFileAtomic(APPS_FILE, lines.join('\n'));
    } catch (err) {
      failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
    }
  }

  if (statusChanged && !flags.dryRun) {
    const logPath = join(dirname(APPS_FILE), 'status-log.tsv');
    const eventDate = flags.on ?? localToday();
    try {
      appendFileSync(logPath, `${target.num}\t${eventDate}\t${oldStatus}\t${newStatus}\t${flags.source ?? 'set-status'}\t\n`);
      statusLogged = true;
    } catch (err) {
      console.error(`⚠ status-log append failed (status change itself succeeded): ${err.message}`);
    }
  }
  if (flags.repairStatusLog && !statusChanged && newStatus === 'Applied' && !flags.dryRun) {
    const logPath = join(dirname(APPS_FILE), 'status-log.tsv');
    const timeline = [];
    let inspectionError = null;
    try {
      const log = readFileSync(logPath, 'utf-8');
      for (const line of log.split(/\r?\n/)) {
        const cells = line.trimEnd().split('\t');
        if (cells[0] !== String(target.num) || cells.length < 5) continue;
        const to = cells[3];
        const source = cells[4];
        if (to === '-') {
          timeline.pop();
        } else if (source === 'correction') {
          const index = timeline.map(entry => entry.to).lastIndexOf(to);
          if (index >= 0) timeline[index] = { to, date: cells[1] };
          else timeline.push({ to, date: cells[1] });
        } else {
          timeline.push({ to, date: cells[1] });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') inspectionError = err;
    }
    if (inspectionError) {
      const error = `status-log inspection failed: ${inspectionError.message}`;
      statusLogRepair = { attempted: true, repaired: false, error };
      console.error(`⚠ ${error}`);
    } else if (timeline.at(-1)?.to === 'Applied') {
      statusLogRepair = { attempted: true, repaired: false, reason: 'already-present' };
    } else if (timeline.length === 0) {
      statusLogRepair = { attempted: true, repaired: false, reason: 'no-history' };
    } else {
      const eventDate = flags.on ?? timeline.at(-1).date;
      if (!eventDate) {
        const error = 'status-log repair needs an event date (--on or a dated tracker row)';
        statusLogRepair = { attempted: true, repaired: false, error };
        console.error(`⚠ ${error}`);
      } else {
        try {
          appendFileSync(logPath, `${target.num}\t${eventDate}\t-\tApplied\tcorrection\t\n`);
          statusLogged = true;
          statusLogRepaired = true;
          statusLogRepair = { attempted: true, repaired: true };
        } catch (err) {
          const error = `status-log repair failed: ${err.message}`;
          statusLogRepair = { attempted: true, repaired: false, error };
          console.error(`⚠ ${error}`);
        }
      }
    }
  }
} finally {
  lock?.release();
  if (activityClaim) {
    try {
      releaseActivity(activityClaim.key, { token: activityClaim.token });
    } catch (err) {
      console.warn(`⚠ session-activity release failed (status change already committed): ${err.message}`);
    }
  }
}

const changed = statusChanged || noteChanged;

let followupSeeded = null;
if ((statusChanged || flags.repairFollowup) && newStatus === 'Applied') {
  try {
    const { seedFollowup } = await import('./followup-seed.mjs');
    const seed = await seedFollowup(target.num, {
      trackerPath: APPS_FILE,
      followupsPath: join(dirname(APPS_FILE), 'follow-ups.md'),
      date: flags.on,
      dryRun: flags.dryRun,
      ...(flags.dryRun ? { assumeApplied: true } : {}),
    });
    followupSeeded = { seeded: seed.seeded, nextDate: seed.nextDate ?? null, ...(seed.reason ? { reason: seed.reason } : {}) };
    if (!flags.json && seed.seeded) {
      console.log(`📅 Follow-up ${flags.dryRun ? 'would be seeded' : 'seeded'} for #${target.num}: next ${seed.nextDate}`);
    }
  } catch (err) {
    followupSeeded = { seeded: false, reason: 'error', error: err.message };
    console.error(`⚠ follow-up seeding failed (status change itself succeeded): ${err.message}`);
  }
}

let jdArchiveTriggered = null;
if (statusChanged && newStatus === 'Interview' && !flags.dryRun) {
  try {
    const workspaceRoot = resolveWorkspaceRoot(APPS_FILE);
    const reportsDir = join(workspaceRoot, 'reports');
    const jdsDir = join(workspaceRoot, 'jds');

    const reportCell = String(target.report ?? '').trim();
    const linkMatch = reportCell.match(/\]\(([^)]+)\)/);
    const rawReportPath = (linkMatch?.[1] ?? reportCell).trim().replace(/^<|>$/g, '');
    let reportPath = null;
    if (rawReportPath && rawReportPath !== '—' && rawReportPath !== '-') {
      const normalized = rawReportPath.replace(/\\/g, '/').replace(/^(\.\.\/)+/, '');
      const candidate = resolve(normalized.includes('/') ? workspaceRoot : reportsDir, normalized);
      if (candidate.startsWith(reportsDir + sep) && existsSync(candidate)) reportPath = candidate;
    }

    const reportPathNum = reportPath
      ? Number.parseInt(/^([0-9]+)-/.exec(basename(reportPath))?.[1] ?? '', 10)
      : NaN;
    const reportNums = extractTrackerReportNumbers(target.report, target.notes);
    const reportNum = Number.isInteger(reportPathNum) && reportPathNum > 0
      ? reportPathNum
      : (reportNums[0] ?? null);

    const alreadyEmbedded = reportPath ? hasEmbeddedJdArchive(readFileSync(reportPath, 'utf-8')) : false;
    const alreadyCaptured = !alreadyEmbedded && reportNum != null && existsSync(jdsDir)
      ? findCaptureForReport(jdsDir, reportNum, { companySlug: captureSlug(target.company) }) !== null
      : false;

    if (!alreadyEmbedded && !alreadyCaptured) {
      if (reportNum == null) {
        jdArchiveTriggered = { attempted: false, reason: 'no-report-number' };
      } else if (!target.url) {
        jdArchiveTriggered = { attempted: false, reason: 'no-url' };
      } else {
        if (!flags.json) console.log(`📄 No JD archived for #${target.num} yet — archiving report ${reportNum} now, before the posting can close:`);
        execFileSync(
          process.execPath,
          [
            join(CODE_ROOT, 'archive-posting.mjs'),
            `--report=${reportNum}`,
            `--company=${target.company}`,
            target.url,
          ],
          {
            stdio: flags.json ? ['ignore', 'pipe', 'inherit'] : 'inherit',
            timeout: JD_ARCHIVE_TIMEOUT_MS,
            env: { ...process.env, CAREER_OPS_ROOT: workspaceRoot },
          },
        );
        jdArchiveTriggered = { attempted: true };
      }
    } else {
      jdArchiveTriggered = { attempted: false, reason: alreadyEmbedded ? 'already-embedded' : 'already-captured' };
    }
  } catch (err) {
    const archiveTimedOut = err?.code === 'ETIMEDOUT'
      || err?.errno === 'ETIMEDOUT'
      || err?.signal === 'SIGTERM';
    const archiveError = archiveTimedOut
      ? `JD archive timed out after ${JD_ARCHIVE_TIMEOUT_MS}ms`
      : err.message;
    jdArchiveTriggered = { attempted: true, error: archiveError };
    console.warn(`⚠ JD archive trigger failed (status change itself succeeded): ${archiveError}`);
  }
}

const result = {
  changed,
  num: target.num,
  company: target.company,
  role: target.role,
  oldStatus,
  newStatus,
  ...(note != null ? { note } : {}),
  ...(replacedNote !== null ? { replacedNote } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  ...(statusChanged && newStatus === 'Applied' ? { followupSeedCandidate: true } : {}),
  ...(followupSeeded ? { followupSeeded } : {}),
  ...(jdArchiveTriggered ? { jdArchiveTriggered } : {}),
  ...(statusChanged && !flags.dryRun ? { statusLogged } : {}),
  ...(statusLogRepaired ? { statusLogRepaired } : {}),
  ...(statusLogRepair ? { statusLogRepair } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? 'would set' : changed ? 'set' : 'already';
  console.log(`✅ #${target.num} ${target.company} — ${target.role}: ${verb} ${oldStatus} → ${newStatus}${note ? ` (note: ${note})` : ''}`);
  if (statusChanged && !flags.dryRun && newStatus === 'Applied' && !followupSeeded?.seeded) {
    console.error('ℹ️  Status is Applied — consider seeding follow-ups in data/follow-ups.md (#1430: node followup-cadence.mjs)');
  }
}
process.exit(EXIT_OK);
