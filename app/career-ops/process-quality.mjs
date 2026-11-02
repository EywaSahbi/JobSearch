#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { isPlaceholderCompany } from './lib/placeholder-cell.mjs';

const CAREER_OPS = getCareerOpsRoot();
const DEFAULT_ACTIVE_INTERVIEWS_PATH = existsSync(join(CAREER_OPS, 'data/active-interviews.md'))
  ? join(CAREER_OPS, 'data/active-interviews.md')
  : join(CAREER_OPS, 'active-interviews.md');

const FRICTION_TAG = /\[process-friction(?::\s*([^\]]+))?\]/i;

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const fileFlagValue = flagValue(args, '--file');
const ACTIVE_INTERVIEWS_PATH = fileFlagValue !== undefined
  ? fileFlagValue
  : DEFAULT_ACTIVE_INTERVIEWS_PATH;
const rawMinThreshold = safeIntFlag(flagValue(args, '--min-threshold'), 1);
const MIN_THRESHOLD = Number.isFinite(rawMinThreshold) && rawMinThreshold >= 0 ? rawMinThreshold : 1;

function findColumn(row, name) {
  const key = Object.keys(row || {}).find(k => k.trim().toLowerCase() === name);
  return key ? String(row[key] ?? '') : '';
}

export function parseActiveInterviews(content) {
  if (typeof content !== 'string' || !content.trim()) return [];

  const lines = content.split('\n');
  const isTableLine = line => /^\s*\|.*\|\s*$/.test(line);

  const startIdx = lines.findIndex(isTableLine);
  if (startIdx === -1) return [];

  const tableLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (!isTableLine(lines[i])) break;
    tableLines.push(lines[i]);
  }
  if (tableLines.length < 2) return [];

  const splitRow = line =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());

  const isSeparatorRow = cells => cells.every(cell => /^:?-+:?$/.test(cell));

  const header = splitRow(tableLines[0]);
  const colCount = header.length;
  if (colCount === 0) return [];

  const rows = [];
  for (const line of tableLines.slice(1)) {
    const cells = splitRow(line);
    if (isSeparatorRow(cells)) continue;
    if (cells.length !== colCount) continue;

    const row = {};
    header.forEach((col, i) => {
      row[col] = cells[i];
    });
    rows.push(row);
  }
  return rows;
}

export function extractFriction(row) {
  if (!row || typeof row !== 'object') return { hasFriction: false, reason: '' };
  const notes = findColumn(row, 'notes');
  const match = notes.match(FRICTION_TAG);
  if (!match) return { hasFriction: false, reason: '' };
  return { hasFriction: true, reason: (match[1] || '').trim() };
}

const isPlaceholder = isPlaceholderCompany;

export function aggregateProcessQuality(rows, minThreshold = 1) {
  if (!Array.isArray(rows)) return [];
  const threshold = Number.isFinite(minThreshold) && minThreshold >= 0 ? minThreshold : 1;

  const companyKey = row => findColumn(row, 'company').trim();

  const byCompany = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const company = companyKey(row);

    let label = company;
    if (isPlaceholder(company)) {
      const via = findColumn(row, 'via').trim();
      if (!via || isPlaceholder(via)) continue;
      label = `? (via ${via})`;
    }

    const dedupeKey = label.toLowerCase();
    if (!byCompany.has(dedupeKey)) {
      byCompany.set(dedupeKey, { company: label, total: 0, frictionCount: 0, reasons: [] });
    }
    const entry = byCompany.get(dedupeKey);
    entry.total += 1;

    const { hasFriction, reason } = extractFriction(row);
    if (hasFriction) {
      entry.frictionCount += 1;
      if (reason) entry.reasons.push(reason);
    }
  }

  const results = [...byCompany.values()]
    .filter(entry => entry.total >= threshold)
    .map(entry => ({
      company: entry.company,
      totalInterviews: entry.total,
      frictionCount: entry.frictionCount,
      frictionRate: entry.total > 0 ? Math.round((entry.frictionCount / entry.total) * 100) / 100 : 0,
      reasons: entry.reasons,
    }));

  results.sort((a, b) => {
    if (b.frictionCount !== a.frictionCount) return b.frictionCount - a.frictionCount;
    if (b.frictionRate !== a.frictionRate) return b.frictionRate - a.frictionRate;
    return a.company.localeCompare(b.company);
  });

  return results;
}

function loadActiveInterviews(path = ACTIVE_INTERVIEWS_PATH) {
  if (!existsSync(path)) return [];
  return parseActiveInterviews(readFileSync(path, 'utf-8'));
}

function printSummary(signals) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Process Quality Signal — career-ops');
  console.log(`  min threshold: ${MIN_THRESHOLD} interview(s) | companies: ${signals.length}`);
  console.log(`${'='.repeat(78)}\n`);

  if (signals.length === 0) {
    console.log('  No process-friction signal found (or no companies met the threshold).\n');
    return;
  }

  const header =
    '  ' +
    'Company'.padEnd(26) +
    'Interviews'.padEnd(12) +
    'Friction'.padEnd(10) +
    'Rate';
  console.log(header);
  console.log('  ' + '-'.repeat(70));

  for (const s of signals) {
    const company = (s.company || '').substring(0, 24).padEnd(26);
    const total = String(s.totalInterviews).padEnd(12);
    const friction = String(s.frictionCount).padEnd(10);
    const rate = `${Math.round(s.frictionRate * 100)}%`;
    console.log('  ' + company + total + friction + rate);
    for (const reason of s.reasons) {
      console.log(`      ↳ ${reason}`);
    }
  }
  console.log('');
}

function runSelfTest() {
  const md = [
    '# Active Interviews',
    '',
    '| Company | Role | Round | Date/Time | Interviewer | Status | Notes |',
    '|---------|------|-------|-----------|-------------|--------|-------|',
    '| Acme | Backend Engineer | Prescreen | 2026-06-01 | Jane (recruiter) | Scheduled | Clean process, no issues |',
    '| Acme | Backend Engineer | Round 1 | 2026-06-08 | Panel | Scheduled | Confirmed quickly, no friction |',
    '| Beta Corp | Coordinator | Prescreen | 2026-06-10 | Sasha (bot) | Scheduled | [process-friction: stated availability overridden twice before confirming] |',
    '| Beta Corp | Coordinator | Round 1 | 2026-06-17 | HM | Scheduled | Went smoothly this round |',
    '| Gamma Inc | Analyst | Prescreen | 2026-06-12 | Recruiter | Rejected | [process-friction] |',
    '| Malformed row with too few cells |',
  ].join('\n');

  const rows = parseActiveInterviews(md);
  const signals = aggregateProcessQuality(rows, 1);

  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  check(rows.length === 5, 'parses 5 well-formed rows, drops the malformed one');

  const beta = signals.find(s => s.company === 'Beta Corp');
  check(!!beta, 'Beta Corp appears in aggregated signals');
  if (beta) {
    check(beta.totalInterviews === 2, 'Beta Corp has 2 total interview rows');
    check(beta.frictionCount === 1, 'Beta Corp has 1 friction-tagged row');
    check(beta.frictionRate === 0.5, 'Beta Corp friction rate is 0.5');
    check(beta.reasons.length === 1 && beta.reasons[0].includes('overridden'), 'Beta Corp friction reason captured');
  }

  const gamma = signals.find(s => s.company === 'Gamma Inc');
  check(!!gamma, 'Gamma Inc appears in aggregated signals');
  if (gamma) {
    check(gamma.frictionCount === 1, 'Gamma Inc has 1 friction-tagged row (bare tag, no reason)');
    check(gamma.reasons.length === 0, 'bare [process-friction] tag produces no reason string');
  }

  const acme = signals.find(s => s.company === 'Acme');
  check(!!acme, 'Acme appears in aggregated signals');
  if (acme) {
    check(acme.frictionCount === 0, 'Acme has 0 friction (no tags present)');
    check(acme.frictionRate === 0, 'Acme friction rate is 0');
  }

  check(aggregateProcessQuality([]).length === 0, 'empty input returns no signals');
  check(aggregateProcessQuality(null).length === 0, 'null input returns no signals (no crash)');
  check(parseActiveInterviews('').length === 0, 'empty markdown returns no rows');
  check(parseActiveInterviews(null).length === 0, 'non-string input returns no rows (no crash)');

  const twoTablesMd = md + '\n\nSome other section.\n\n' +
    '| Foo | Bar |\n|-----|-----|\n| unrelated | table |\n';
  const twoTablesRows = parseActiveInterviews(twoTablesMd);
  check(twoTablesRows.length === 5, 'a second markdown table later in the document is not merged in');
  check(!twoTablesRows.some(r => r.Company === undefined && 'Foo' in r), 'second-table columns (Foo/Bar) never appear in the result');

  const highThreshold = aggregateProcessQuality(rows, 2);
  check(highThreshold.some(s => s.company === 'Beta Corp'), 'threshold=2: Beta Corp (2 rows) included');
  check(highThreshold.some(s => s.company === 'Acme'), 'threshold=2: Acme (2 rows) included');
  check(!highThreshold.some(s => s.company === 'Gamma Inc'), 'threshold=2: Gamma Inc (1 row) excluded');

  console.log(`\n  process-quality self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

const KNOWN_FLAGS = ['--file', '--min-threshold', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--file', '--min-threshold'];

const USAGE = `Usage:
  node process-quality.mjs                        # JSON report
  node process-quality.mjs --summary              # human-readable table
  node process-quality.mjs --file <path>          # a different active-interviews.md
  node process-quality.mjs --min-threshold <N>    # minimum rounds before a company is reported (default 1)
  node process-quality.mjs --self-test            # run the built-in fixtures
  node process-quality.mjs --help                 # show this message`;

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (selfTestMode) {
    runSelfTest();
  }

  const rows = loadActiveInterviews();
  const signals = aggregateProcessQuality(rows, MIN_THRESHOLD);

  if (summaryMode) {
    printSummary(signals);
  } else {
    console.log(JSON.stringify({
      metadata: {
        minThreshold: MIN_THRESHOLD,
        totalRows: rows.length,
        companies: signals.length,
      },
      signals,
    }, null, 2));
  }
}
