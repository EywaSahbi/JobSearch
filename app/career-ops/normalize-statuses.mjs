#!/usr/bin/env node

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import {
  openTrackerTransaction, rebuildRow,
  loadCanonicalStates, resolveCanonicalState,
} from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODEBASE_ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

let statesCache = null;
function canonicalStates() {
  if (statesCache) return statesCache;
  const statesFile = join(CODEBASE_ROOT, 'templates', 'states.yml');
  try {
    statesCache = loadCanonicalStates(statesFile);
  } catch (err) {
    console.error(`[normalize-statuses] cannot read canonical states from ${statesFile}: ${err.message}`);
    console.error('[normalize-statuses] every status will be reported as unknown until this is fixed.');
    statesCache = [];
  }
  return statesCache;
}

function normalizeStatus(raw) {
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }

  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };
  if (/^descartado$/i.test(s)) return { status: 'Discarded' };

  if (/^rechazad[oa]$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };

  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };

  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };

  if (/^monitor$/i.test(s)) return { status: 'SKIP' };

  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };

  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: raw.trim() };

  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  const fromStates = resolveCanonicalState(lower, canonicalStates());
  if (fromStates) return { status: fromStates };

  return { status: null, unknown: true };
}

export { normalizeStatus };

const KNOWN_FLAGS = ['--help', '-h', '--dry-run'];
const USAGE = `Usage: node normalize-statuses.mjs [options]

  Options:
  --dry-run        Report what would change without writing applications.md
  -h, --help       Show this help and exit
  `;

const IS_CLI = isMainModule(import.meta.url);

if (IS_CLI) {
const args = process.argv.slice(2);

validateFlags(args, KNOWN_FLAGS, USAGE);

if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
let trackerTransaction = null;
if (!DRY_RUN) {
  try {
    trackerTransaction = await openTrackerTransaction(APPS_FILE);
  } catch (err) {
    console.error(`Cannot acquire tracker lock: ${err.message}`);
    process.exit(1);
  }
  process.once('exit', () => {
    try { trackerTransaction.close(); } catch {}
  });
}
try {
const content = trackerTransaction ? trackerTransaction.read() : readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let changes = 0;
let unknowns = [];

const COLS = resolveColumns(lines);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const row = parseTrackerRow(line, COLS);
  if (!row) continue;

  const parts = line.split('|').map(s => s.trim());
  const num = row.num;
  const rawStatus = row.status;
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: i + 1 });
    continue;
  }

  if (result.status === rawStatus) continue;

  const oldStatus = rawStatus;
  parts[COLS.status] = result.status;

  if (result.moveToNotes && COLS.notes != null) {
    const existing = parts[COLS.notes] || '';
    if (!existing.includes(result.moveToNotes)) {
      parts[COLS.notes] = result.moveToNotes + (existing ? '. ' + existing : '');
    }
  }

  if (parts[COLS.score]) {
    parts[COLS.score] = parts[COLS.score].replace(/\*\*/g, '');
  }

  const newLine = rebuildRow(parts);
  lines[i] = newLine;
  changes++;

  console.log(`#${num}: "${oldStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  const backupPath = `${APPS_FILE}.bak`;
  copyFileSync(APPS_FILE, backupPath);
  trackerTransaction.replace(lines.join('\n'));
  console.log(`✅ Written to ${APPS_FILE} (backup: ${backupPath})`);
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No changes needed');
}
} finally {
  trackerTransaction?.close();
}
}
