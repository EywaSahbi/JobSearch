#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolvePdfIndexPath } from './tracker-utils.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

const normNum = (s) => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

const cleanStatus = (s) =>
  String(s ?? '').replace(/\*\*/g, '').replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '').trim();

export function parseTrackerRows(text) {
  const lines = String(text ?? '').split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const link = row.report.match(/\[(\d+)\]\(([^)]+)\)/);
    rows.push({
      trackerNum: row.num,
      date: row.date,
      company: row.company,
      role: row.role,
      score: row.score,
      status: cleanStatus(row.status),
      reportNum: link ? normNum(link[1]) : null,
      reportPath: link ? link[2].replace(/^(\.\.\/)+/, '') : null,
    });
  }
  return rows;
}

export function parsePdfIndex(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (!fields[0]?.trim() || !fields[1]) continue;
    if ((fields[5] ?? '').trim() === 'cover') continue;
    map.set(normNum(fields[0]), fields[1]);
  }
  return map;
}

export function findMatches(rows, query, pdfIndex = new Map()) {
  const q = String(query ?? '').trim();
  if (!q) return [];

  let hits;
  if (/^\d+$/.test(q)) {
    const nq = normNum(q);
    hits = rows.filter(r => String(r.trackerNum) === nq || r.reportNum === nq);
  } else {
    const ql = q.toLowerCase();
    hits = rows.filter(r =>
      r.company.toLowerCase().includes(ql) ||
      r.role.toLowerCase().includes(ql) ||
      roleFuzzyMatch(r.company, q) ||
      roleFuzzyMatch(r.role, q));
  }
  return hits.map(r => ({
    ...r,
    pdfPath: (r.reportNum !== null && pdfIndex.get(r.reportNum)) || null,
  }));
}

const KNOWN_FLAGS = ['--json', '--help', '-h'];

const USAGE = `Usage:
  node find.mjs <report# | tracker# | company/role fragment> [--json]
  node find.mjs --help                            # print this usage block and exit`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  const json = args.includes('--json');
  const query = args.filter(a => a !== '--json').join(' ').trim();
  return { json, query };
}

function main() {
  const { json, query } = parseArgs(process.argv);
  if (!query) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const trackerPath = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(trackerPath)) {
    console.error(`Error: ${trackerPath} not found — nothing to search.`);
    process.exitCode = 1;
    return;
  }
  const rows = parseTrackerRows(readFileSync(trackerPath, 'utf-8'));

  const manifestPath = resolvePdfIndexPath(trackerPath);
  const pdfIndex = existsSync(manifestPath)
    ? parsePdfIndex(readFileSync(manifestPath, 'utf-8'))
    : new Map();

  const matches = findMatches(rows, query, pdfIndex);
  if (json) {
    console.log(JSON.stringify(matches, null, 2));
    if (matches.length === 0) process.exitCode = 1;
    return;
  }
  if (matches.length === 0) {
    console.log(`No application matches "${query}" — try a report #, tracker #, or company fragment.`);
    process.exitCode = 1;
    return;
  }

  const headers = ['Tracker#', 'Report#', 'Company', 'Role', 'Status', 'PDF', 'Report'];
  const table = matches.map(m => [
    String(m.trackerNum), m.reportNum ?? '—', m.company, m.role,
    m.status || '—', m.pdfPath ?? '—', m.reportPath ?? '—',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(fmt(headers));
  console.log(fmt(widths.map(w => '-'.repeat(w))));
  for (const r of table) console.log(fmt(r));
  console.error(`\n${matches.length} match(es)`);
}

if (isMainModule(import.meta.url)) {
  main();
}
