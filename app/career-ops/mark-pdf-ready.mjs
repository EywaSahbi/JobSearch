#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { extractTrackerReportNumbers, resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import {
  rebuildRow, resolveTrackerPath, writeFileAtomic, CLI_EXIT, makeCliFailWith, acquireTrackerLockForCli,
} from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();

const { OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND, AMBIGUOUS: EXIT_AMBIGUOUS } = CLI_EXIT;

const USAGE = `Usage: node mark-pdf-ready.mjs <report#> [--dry-run] [--json]

  <report#>    The NNN from reports/NNN-{slug}-{date}.md (NOT the tracker # column)
  --dry-run    Resolve and validate, but write nothing
  --json       Machine-readable output on stdout (errors included)`;

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = { dryRun: false, json: false };

for (const a of rawArgs) {
  if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (positional.length !== 1) {
  failUsage(positional.length === 0 ? null : `Expected 1 argument (report#), got ${positional.length}`);
}

const [reportSelector] = positional;

const failWith = makeCliFailWith(flags.json);

function failUsage(message) {
  const msg = message ?? 'Expected 1 argument: <report#>';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

if (!/^\d+$/.test(reportSelector)) {
  failUsage(`"${reportSelector}" is not a valid report number`);
}
const targetReportNum = parseInt(reportSelector, 10);

const APPS_FILE = resolveTrackerPath(DATA_ROOT);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

const lock = await acquireTrackerLockForCli(APPS_FILE, { dryRun: flags.dryRun, failWith });

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}
const lines = content.split('\n');
const colmap = resolveColumns(lines);
if (colmap.pdf == null) {
  failWith(EXIT_USAGE, 'no-pdf-column', 'Tracker has no PDF column — cannot mark a PDF ready');
}

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row) rows.push({ ...row, lineIdx: i });
}
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${APPS_FILE} has no data rows`);
}

const matches = rows.filter(r => extractTrackerReportNumbers(r.report).includes(targetReportNum));
if (matches.length === 0) {
  failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row links report #${targetReportNum}`);
}
if (matches.length > 1) {
  const candidates = matches.map(r => ({ num: r.num, company: r.company, role: r.role }));
  const listing = candidates.map(c => `#${c.num}\t${c.company}\t${c.role}`).join('\n');
  failWith(EXIT_AMBIGUOUS, 'ambiguous',
    `Report #${targetReportNum} is linked by ${matches.length} tracker rows — repair the Report cells:\n${listing}`,
    { candidates });
}
const target = matches[0];

const alreadyReady = target.pdf.trim() === '✅';
const changed = !alreadyReady;

if (changed && !flags.dryRun) {
  const parts = lines[target.lineIdx].split('|').map(s => s.trim());
  while (parts.length <= colmap.pdf) parts.push('');
  parts[colmap.pdf] = '✅';
  lines[target.lineIdx] = rebuildRow(parts);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}
lock?.release();

const result = {
  changed,
  num: target.num,
  company: target.company,
  role: target.role,
  reportNum: targetReportNum,
  ...(flags.dryRun ? { dryRun: true } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? (alreadyReady ? 'already' : 'would mark') : changed ? 'marked' : 'already';
  console.log(`✅ #${target.num} ${target.company} — ${target.role}: ${verb} PDF ready`);
}
process.exit(EXIT_OK);
