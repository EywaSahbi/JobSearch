#!/usr/bin/env node

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { normalizeUrl } from './url-key.mjs';
import {
  openTrackerTransaction, rebuildRow, normalizeCompany,
} from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

const KNOWN_FLAGS = ['--dry-run', '--help', '-h'];
const USAGE = `Usage: node dedup-tracker.mjs [--dry-run]`;

const cliArgs = process.argv.slice(2);

validateFlags(cliArgs, KNOWN_FLAGS, USAGE);
const DRY_RUN = process.argv.includes('--dry-run');

mkdirSync(dirname(APPS_FILE), { recursive: true });

const STATUS_RANK = {
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  'hired': 7,
  'accepted': 7,
  'accept': 7,
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
  'contratado': 7,
  'contratada': 7,
};

function normalizeStatus(status) {
  return String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] || 0;
}

function isAdvancedStatus(status) {
  return statusRank(status) >= STATUS_RANK.applied;
}

function extractReportNum(reportStr) {
  const m = String(reportStr ?? '').match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

function sameReportIdentity(a, b) {
  const reportA = extractReportNum(a.report);
  const reportB = extractReportNum(b.report);
  if (reportA !== null && reportA === reportB) return true;
  return a.num === b.num && normalizeRole(a.role) === normalizeRole(b.role);
}

function pairKey(a, b) {
  return [a.num, b.num].sort((x, y) => x - y).join(':');
}

const protectedTitlePairs = new Set();

function normalizeRole(role) {
  return String(role ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function urlsConflict(a, b) {
  const urlA = normalizeUrl(a.url);
  const urlB = normalizeUrl(b.url);
  return Boolean(urlA && urlB && urlA !== urlB);
}

function roleMatch(a, b) {
  if (urlsConflict(a, b)) return false;

  if (sameReportIdentity(a, b)) return true;
  if (normalizeRole(a.role) !== normalizeRole(b.role)) return false;

  if (isAdvancedStatus(a.status) || isAdvancedStatus(b.status)) {
    const key = pairKey(a, b);
    if (!protectedTitlePairs.has(key)) {
      protectedTitlePairs.add(key);
      console.warn(`⚠️  Keep #${a.num} and #${b.num}: exact-title match but advanced status requires exact report identity`);
    }
    return false;
  }

  return true;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAppLine(line) {
  return parseTrackerRow(line, COLMAP);
}

if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}

let trackerTransaction = null;
let COLMAP;
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
COLMAP = resolveColumns(lines);

const entries = [];

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    app.lineIdx = i;
    entries.push(app);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

const BLIND_KEY = '\u0000blind-via:';
const groups = new Map();
for (const entry of entries) {
  const key = String(entry.company).trim() === '?'
    ? BLIND_KEY + normalizeVia(entry.via || '')
    : normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

const BLIND_WINDOW_DAYS = 90;
function withinBlindWindow(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= BLIND_WINDOW_DAYS * 86400000;
}

let removed = 0;
const linesToRemove = new Set();

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;
  const isBlindGroup = company.startsWith(BLIND_KEY);

  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (roleMatch(companyEntries[i], companyEntries[j])
          && !cluster.some(member => urlsConflict(member, companyEntries[j]))
          && (!isBlindGroup || withinBlindWindow(companyEntries[i].date, companyEntries[j].date))) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    let bestStatusRank = statusRank(keeper.status);
    let bestStatus = keeper.status;
    for (let k = 1; k < cluster.length; k++) {
      const rank = statusRank(cluster[k].status);
      if (rank > bestStatusRank) {
        bestStatusRank = rank;
        bestStatus = cluster[k].status;
      }
    }

    if (bestStatus !== keeper.status) {
      const lineIdx = keeper.lineIdx;
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        parts[COLMAP.status] = bestStatus;
        lines[lineIdx] = rebuildRow(parts);
        console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
      }
    }

    let mergedNotes = String(keeper.notes || '').trim();
    const originalNotes = mergedNotes;
    for (let k = 1; k < cluster.length; k++) {
      const dupNotes = String(cluster[k].notes || '').trim();
      if (dupNotes && dupNotes !== 'N/A' && dupNotes !== '❌' && dupNotes !== 'pending' && dupNotes !== '-') {
        if (!mergedNotes.includes(dupNotes)) {
          mergedNotes = mergedNotes && mergedNotes !== 'N/A' && mergedNotes !== '-' ? `${mergedNotes}; ${dupNotes}` : dupNotes;
        }
      }
    }

    if (mergedNotes !== originalNotes) {
      const lineIdx = keeper.lineIdx;
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        parts[COLMAP.notes] = mergedNotes;
        lines[lineIdx] = rebuildRow(parts);
        keeper.notes = mergedNotes;
        console.log(`  📝 #${keeper.num}: notes merged`);
      }
    }

    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      const lineIdx = dup.lineIdx;
      if (lineIdx !== undefined) {
        linesToRemove.add(lineIdx);
        removed++;
        console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
      }
    }
  }
}

const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  const backupPath = `${APPS_FILE}.bak`;
  copyFileSync(APPS_FILE, backupPath);
  trackerTransaction.replace(lines.join('\n'));
  console.log(`✅ Written to ${APPS_FILE} (backup: ${backupPath})`);
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
} finally {
  trackerTransaction?.close();
}
