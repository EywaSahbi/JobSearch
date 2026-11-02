#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { buildCompanyCanonicalizer } from './scan.mjs';
import { parseScanHistoryLine, scanHistoryLineHasColumn } from './lib/scan-history-columns.mjs';

const DATA_ROOT = getCareerOpsRoot();
const HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || join(DATA_ROOT, 'data', 'scan-history.tsv');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  if (i === -1) return d;
  if (args.indexOf(f, i + 1) !== -1) {
    console.error(`ERROR: ${f} may only be specified once`);
    process.exit(1);
  }
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
    console.error(`ERROR: ${f} requires a value`);
    process.exit(1);
  }
  return args[i + 1];
};

if (has('--help')) {
  console.log(`Usage: node discover-new-companies.mjs [options]

Reads data/scan-history.tsv, subtracts every company already tracked in
portals.yml, and emits the remainder as a discover-ats.mjs input file.

Options:
  --since <n>       Only companies first seen in the last N days (default: 30)
  --min-rows <n>    Only companies with >= N history rows (default: 2)
  --added-only      Only companies that produced at least one 'added' row
  --limit <n>       Cap the output list (default: 40)
  --out <file>      Write YAML here (default: stdout)
  --summary         Human-readable table instead of YAML
  --json            JSON envelope instead of YAML
  --help            This message

Typical loop:
  node discover-new-companies.mjs --out /tmp/new.yml
  node discover-ats.mjs --in /tmp/new.yml --summary     # preview, writes nothing
  node discover-ats.mjs --in /tmp/new.yml --write       # only after you review
`);
  process.exit(0);
}

const SINCE_DAYS = Number(val('--since', '30'));
const MIN_ROWS   = Number(val('--min-rows', '2'));
const LIMIT      = Number(val('--limit', '40'));
const ADDED_ONLY = has('--added-only');
const OUT_FILE   = val('--out');

for (const [flag, v] of [['--since', SINCE_DAYS], ['--min-rows', MIN_ROWS], ['--limit', LIMIT]]) {
  if (!Number.isFinite(v) || v < 0) {
    console.error(`ERROR: ${flag} must be a non-negative number; got ${JSON.stringify(val(flag))}`);
    process.exit(1);
  }
}

if (!existsSync(HISTORY_PATH)) {
  console.error(`ERROR: ${HISTORY_PATH} not found — run a scan first.`);
  process.exit(1);
}

const portalsRaw = existsSync(PORTALS_PATH)
  ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {})
  : {};
const canon = buildCompanyCanonicalizer(portalsRaw.company_aliases);

const tracked = new Set();
for (const entry of portalsRaw.tracked_companies || []) {
  if (entry && typeof entry.name === 'string') tracked.add(canon(entry.name));
}

const rows = readFileSync(HISTORY_PATH, 'utf-8').split('\n');
const hasHeader = /^\s*url\s*\t/i.test(rows[0] ?? '');

const cutoffMs = SINCE_DAYS > 0 ? Date.now() - SINCE_DAYS * 86_400_000 : null;

const found = new Map();

for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
  if (!scanHistoryLineHasColumn(rows[i], 'status')) continue;
  const row = parseScanHistoryLine(rows[i]);

  const rawName = row.company.trim();
  if (!rawName) continue;

  const seen = row.first_seen.trim();
  if (cutoffMs != null) {
    const t = Date.parse(seen);
    if (Number.isFinite(t) && t < cutoffMs) continue;
  }

  const key = canon(rawName);
  if (!key || tracked.has(key)) continue;

  if (!found.has(key)) {
    found.set(key, { name: rawName, rows: 0, added: 0, lastSeen: seen, titles: new Set(), hosts: new Set() });
  }
  const rec = found.get(key);
  rec.rows++;
  if (row.status.trim() === 'added') rec.added++;
  if (seen > rec.lastSeen) rec.lastSeen = seen;
  const title = row.title.trim();
  if (title && rec.titles.size < 3) rec.titles.add(title);
  try { rec.hosts.add(new URL(row.url).hostname); } catch { }
}

let candidates = [...found.values()]
  .filter((c) => c.rows >= MIN_ROWS)
  .filter((c) => (ADDED_ONLY ? c.added > 0 : true))
  .sort((a, b) => b.added - a.added || b.rows - a.rows || a.name.localeCompare(b.name));

const totalBeforeLimit = candidates.length;
candidates = candidates.slice(0, LIMIT);

if (has('--summary')) {
  console.log('='.repeat(78));
  console.log('  New companies seen by scanners but absent from portals.yml');
  console.log(`  candidates: ${totalBeforeLimit} | shown: ${candidates.length} | window: ${SINCE_DAYS}d`);
  console.log('='.repeat(78));
  for (const c of candidates) {
    console.log(`  ${c.name}`);
    console.log(`    rows: ${c.rows} | added: ${c.added} | last: ${c.lastSeen} | ${[...c.hosts][0] || 'n/a'}`);
    if (c.titles.size) console.log(`    e.g. ${[...c.titles][0]}`);
  }
  if (!candidates.length) console.log('  (nothing new — every scanned company is already tracked)');
  console.log('\nNext: node discover-new-companies.mjs --out /tmp/new.yml');
  console.log('      node discover-ats.mjs --in /tmp/new.yml --summary');
  process.exit(0);
}

if (has('--json')) {
  console.log(JSON.stringify({
    metadata: { candidates: totalBeforeLimit, emitted: candidates.length, sinceDays: SINCE_DAYS, minRows: MIN_ROWS, addedOnly: ADDED_ONLY },
    companies: candidates.map((c) => ({
      name: c.name, rows: c.rows, added: c.added, lastSeen: c.lastSeen,
      hosts: [...c.hosts], sampleTitles: [...c.titles],
    })),
  }, null, 2));
  process.exit(0);
}

const doc = yaml.dump({ companies: candidates.map((c) => ({ name: c.name })) });
const banner = `# Generated by discover-new-companies.mjs — ${new Date().toISOString().slice(0, 10)}\n`
  + `# ${totalBeforeLimit} candidate(s) found, ${candidates.length} emitted (window ${SINCE_DAYS}d, min-rows ${MIN_ROWS}).\n`
  + `# Feed to: node discover-ats.mjs --in <this file> --summary\n`;

if (OUT_FILE) {
  writeFileSync(OUT_FILE, banner + doc);
  console.error(`Wrote ${candidates.length} company/companies to ${OUT_FILE}`);
} else {
  process.stdout.write(banner + doc);
}
