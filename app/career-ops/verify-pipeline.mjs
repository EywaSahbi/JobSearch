#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import {
  looksLikeScoreCell, isSeparatorRow, isHeaderRow, resolveColumns,
  normalizeTextKey, normalizeVia,
} from './tracker-parse.mjs';
import { CONTROL_CHARS, findDeadReportLink } from './tracker-utils.mjs';
import { normalizeUrl } from './url-key.mjs';
import { checkTrackerSync } from './tracker-sync-check.mjs';
import { normalizeStatus } from './followup-cadence.mjs';
import { checkFollowupsSchema } from './stats.mjs';
import { loadCanonicalStates } from './tracker-utils.mjs';
import { checkJdArchive } from './check-jd-archive.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS
  ? resolve(CAREER_OPS, process.env.CAREER_OPS_REPORTS)
  : join(CAREER_OPS, 'reports');
const JDS_DIR = process.env.CAREER_OPS_JDS
  ? resolve(CAREER_OPS, process.env.CAREER_OPS_JDS)
  : join(CAREER_OPS, 'jds');
const STATES_FILE = existsSync(join(CODE_ROOT, 'templates/states.yml'))
  ? join(CODE_ROOT, 'templates/states.yml')
  : join(CODE_ROOT, 'states.yml');

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const _canonicalStates = loadCanonicalStates(STATES_FILE);
const CANONICAL_STATUSES = new Set(_canonicalStates.map(s => s.id));
const ALIASES = Object.fromEntries(
  _canonicalStates.flatMap(s => s.aliases.map(a => [a.toLowerCase(), s.id]))
);

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

const COLMAP = resolveColumns(lines);
const MAX_IDX = Math.max(...Object.values(COLMAP));

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= MAX_IDX) continue;
  const num = parseInt(parts[COLMAP.num]);
  if (isNaN(num)) continue;
  entries.push({
    num,
    date: parts[COLMAP.date],
    company: parts[COLMAP.company],
    via: COLMAP.via != null ? parts[COLMAP.via] : '',
    role: parts[COLMAP.role],
    location: COLMAP.location != null ? parts[COLMAP.location] : '',
    score: parts[COLMAP.score],
    status: parts[COLMAP.status],
    pdf: parts[COLMAP.pdf],
    report: parts[COLMAP.report],
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.has(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = normalizeTextKey(e.company) + '::' + normalizeTextKey(e.role);
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
for (const [key, group] of companyRoleMap) {
  if (group.length > 1) {
    warn(`Possible duplicates: ${group.map(e => `#${e.num}`).join(', ')} (${group[0].company} — ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

const TRACKER_DIR = dirname(APPS_FILE);
let brokenReports = 0;
let uninspectableReports = 0;
for (const e of entries) {
  let inspectionFailure = null;
  const link = findDeadReportLink(e.report, TRACKER_DIR, CAREER_OPS, {
    onInspectionError: (failure) => { inspectionFailure = failure; },
  });
  if (inspectionFailure) {
    const codes = [...new Set(inspectionFailure.errors.map(({ error: err }) => err?.code || 'unknown error'))].join(', ');
    warn(`#${e.num}: Report could not be inspected (${codes}), so it may exist: ${inspectionFailure.link}`);
    uninspectableReports++;
    continue;
  }
  if (link !== null) {
    error(`#${e.num}: Report not found: ${link}`);
    brokenReports++;
  }
}
if (brokenReports === 0 && uninspectableReports === 0) ok('All report links valid');

let badScores = 0;
for (const e of entries) {
  if (!looksLikeScoreCell(e.score)) {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (isSeparatorRow(line) || isHeaderRow(line)) continue;
  const parts = line.split('|');
  if (parts.length <= MAX_IDX) {
    error(`Row with too few columns (need ${MAX_IDX} data cols): ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
let staleSentinels = 0;
if (existsSync(REPORTS_DIR)) {
  const now = Date.now();
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > SENTINEL_MAX_AGE_MS) {
        unlinkSync(full);
        warn(`Removed stale reservation sentinel: ${name}`);
        staleSentinels++;
      }
    } catch {
    }
  }
}
if (staleSentinels === 0) ok('No stale reservation sentinels');

const REPORT_FILE_RE = /^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/;
const normalizeKey = normalizeTextKey;

function extractRole(reportContent) {
  const fence = reportContent.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const m = fence[1].match(/^role:\s*["']?(.+?)["']?\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  const title = reportContent.split('\n').find(l => l.startsWith('# '));
  if (title) {
    const parts = title.split(/[—–]/);
    if (parts.length >= 2 && parts[parts.length - 1].trim()) return parts[parts.length - 1].trim();
  }
  return null;
}

function extractReportUrlKey(reportContent) {
  const m = reportContent.match(/\*\*URL:\*\*[ \t]*(\S+)/);
  if (!m) return '';
  return normalizeUrl(m[1].replace(/^<|>$/g, '').replace(/[),.;]+$/, ''));
}

const reportFiles = existsSync(REPORTS_DIR)
  ? readdirSync(REPORTS_DIR).filter(f => REPORT_FILE_RE.test(f))
  : [];

let dupReports = 0;
const reportsByRole = new Map();
for (const name of reportFiles) {
  const companySlug = name.match(REPORT_FILE_RE)[2];
  let role = null;
  let urlKey = '';
  try {
    const content = readFileSync(join(REPORTS_DIR, name), 'utf-8');
    role = extractRole(content);
    urlKey = extractReportUrlKey(content);
  } catch {
  }
  if (!role) continue;
  const key = normalizeKey(companySlug) + '::' + normalizeKey(role);
  if (!reportsByRole.has(key)) reportsByRole.set(key, []);
  reportsByRole.get(key).push({ name, urlKey });
}
for (const group of reportsByRole.values()) {
  if (group.length < 2) continue;
  const keys = group.map(r => r.urlKey);
  if (keys.every(Boolean) && new Set(keys).size === keys.length) continue;
  warn(`Duplicate reports for same company+role: ${group.map(r => r.name).join(', ')}`);
  dupReports++;
}
if (dupReports === 0) ok('No duplicate reports for the same company+role');

const referencedNums = new Set();
for (const e of entries) {
  const linkTexts = [...e.report.matchAll(/\[(\d+)\]/g)];
  const linkTargets = [...e.report.matchAll(/\]\(([^)]+)\)/g)];
  if (linkTexts.length === 0 && linkTargets.length === 0) {
    referencedNums.add(e.num);
    continue;
  }
  for (const lt of linkTexts) referencedNums.add(parseInt(lt[1], 10));
  for (const lt of linkTargets) {
    const m = lt[1].split(/[\\/]/).pop().match(/^(\d+)-/);
    if (m) referencedNums.add(parseInt(m[1], 10));
  }
}

let orphanReports = 0;
for (const name of reportFiles) {
  const num = parseInt(name.match(REPORT_FILE_RE)[1], 10);
  if (!referencedNums.has(num)) {
    warn(`Orphan report — no tracker row references #${num}: reports/${name}`);
    orphanReports++;
  }
}
if (orphanReports === 0) ok('No orphan reports');

let viaIssues = 0;
const CONFIDENTIAL_WORD_RE = /^(confidential|vertraulich|confidentiel|confidencial|riservato|gizli|機密|سري)$/i;
for (const e of entries) {
  const company = String(e.company || '').trim();
  const via = String(e.via || '').trim();
  if (company === '?') {
    if (COLMAP.via == null) {
      warn(`#${e.num}: unknown employer (?) but the tracker has no Via column — add it with: node merge-tracker.mjs --migrate-via`);
      viaIssues++;
    } else if (!via || via === '—') {
      error(`#${e.num}: unknown employer (?) with no Via channel — record the agency/recruiter firm`);
      viaIssues++;
    }
  }
  if (CONFIDENTIAL_WORD_RE.test(company)) {
    warn(`#${e.num}: company "${company}" looks like a confidentiality placeholder — use the structural marker ? (locale-invariant, can't collide with a real firm)`);
    viaIssues++;
  }
}
const isNeverSubmitted = (status) => normalizeStatus(String(status || '')) === 'skip';
const normalizeChannel = (v) => normalizeVia(v ?? '') || 'direct';
const channelsByRole = new Map();
for (const e of entries) {
  const company = String(e.company || '').trim();
  if (!company || company === '?') continue;
  if (isNeverSubmitted(e.status)) continue;
  const key = `${company.toLowerCase()}::${String(e.role || '').trim().toLowerCase()}`;
  if (!channelsByRole.has(key)) channelsByRole.set(key, new Map());
  const channels = channelsByRole.get(key);
  const norm = normalizeChannel(e.via);
  if (!channels.has(norm)) channels.set(norm, { raw: String(e.via || '').trim() || '—', num: e.num });
}
for (const [key, vias] of channelsByRole) {
  if (vias.size > 1) {
    const list = [...vias.values()];
    warn(`Cross-channel duplicate — ${key.replace('::', ' / ')} reached via ${list.map(v => v.raw).join(' AND ')} (rows ${list.map(v => `#${v.num}`).join(', ')}) — double-submission risk, resolve by hand`);
    viaIssues++;
  }
}
if (viaIssues === 0) ok('Via channels consistent');
const numGroups = new Map();
for (const e of entries) {
  if (!numGroups.has(e.num)) numGroups.set(e.num, []);
  numGroups.get(e.num).push(e);
}
let dupeNums = 0;
for (const [num, group] of numGroups) {
  if (group.length > 1) {
    error(`Duplicate tracker number #${num} used by ${group.length} rows: ${group.map(e => `${e.company} — ${e.role}`).join(' | ')}`);
    dupeNums++;
  }
}
if (dupeNums === 0) ok('No duplicate tracker numbers');

let syncResult;
try {
  syncResult = checkTrackerSync({ appsFile: APPS_FILE });
} catch (err) {
  error(`Sync check could not run — the tracker was NOT verified: ${err.message}`);
}

if (syncResult) {
  const tier1Mismatches = syncResult.mismatches.filter(m => m.resolution === 'auto-tier1');
  const tier2Mismatches = syncResult.mismatches.filter(m => m.resolution === 'needs-review-tier2');
  const unmatchedRows = syncResult.mismatches.filter(m => m.resolution === 'unmatched');

  for (const m of tier1Mismatches) {
    warn(`Sync drift (auto-resolvable): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" vs active-interviews.md="${m.activeInterviewsStatus}" -> suggest "${m.suggestedStatus}" in ${m.staleIn} (run node tracker-sync-check.mjs for details)`);
  }
  for (const m of tier2Mismatches) {
    warn(`Sync drift (needs human review): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" (${m.applicationsLastModified || 'no blame info'}) vs active-interviews.md="${m.activeInterviewsStatus}" (${m.activeInterviewsLastModified || 'no blame info'})`);
  }
  for (const m of unmatchedRows) {
    warn(`Sync check: active-interviews.md row for "${m.company}" — "${m.role}" could not be matched to a tracker row (${m.note})`);
  }
  if (tier1Mismatches.length === 0 && tier2Mismatches.length === 0 && unmatchedRows.length === 0) {
    ok(syncResult.summary.total > 0
      ? 'applications.md and active-interviews.md are in sync'
      : 'No active-interviews.md rows to sync-check');
  }
}

const FOLLOWUPS_FILE = join(CAREER_OPS, 'data', 'follow-ups.md');
const FOLLOWUPS_COLUMNS = '| num | appNum | date | company | role | channel | contact | notes |';
if (!existsSync(FOLLOWUPS_FILE)) {
  ok('No follow-ups.md yet — nothing to schema-check');
} else {
  const fups = checkFollowupsSchema(readFileSync(FOLLOWUPS_FILE, 'utf-8'));
  if (fups.pipeLines === 0) {
    ok('follow-ups.md has no table rows yet');
  } else if (!fups.sawSeparator) {
    error(`follow-ups.md has table rows but no header delimiter row, so every row is skipped — expected ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.dataRows === 0) {
    ok('follow-ups.md has no logged follow-ups yet');
  } else if (fups.parsed === 0) {
    error(`follow-ups.md: none of its ${fups.dataRows} row(s) parse, so stats.mjs and followup-cadence.mjs will both report zero follow-ups — expected column order ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.unparsedLines.length > 0) {
    warn(`follow-ups.md: ${fups.unparsedLines.length} of ${fups.dataRows} rows will be skipped by stats.mjs and followup-cadence.mjs (line${fups.unparsedLines.length === 1 ? '' : 's'} ${fups.unparsedLines.join(', ')}) — expected ${FOLLOWUPS_COLUMNS}`);
  } else {
    ok(`follow-ups.md schema valid (${fups.parsed} logged follow-up${fups.parsed === 1 ? '' : 's'})`);
  }
}

const PORTALS_FILE = process.env.CAREER_OPS_PORTALS || join(CAREER_OPS, 'portals.yml');
if (!existsSync(PORTALS_FILE)) {
  ok('No portals.yml yet — nothing to coverage-check');
} else {
  try {
    const { findUnclaimedEntries } = await import('./audit-portals.mjs');
    const { loadProviders } = await import('./providers/_registry.mjs');
    const { mergeProviderPlugins } = await import('./plugins/_engine.mjs');
    const yaml = await import('js-yaml');

    const cfg = yaml.load(readFileSync(PORTALS_FILE, 'utf-8')) || {};
    const entries = [
      ...(Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : []),
      ...(Array.isArray(cfg.job_boards) ? cfg.job_boards : []),
    ];
    const providers = await loadProviders(join(CODE_ROOT, 'providers'));
    await mergeProviderPlugins(providers, { root: CODE_ROOT, dataRoot: CAREER_OPS });
    const { silent, handoff, unknownProvider } = findUnclaimedEntries(entries, providers);

    const malformed = entries.filter(e => e && e.enabled !== false && (typeof e.name !== 'string' || !e.name.trim()));
    for (const e of malformed) {
      warn(`portals.yml: an enabled entry has no name (careers_url: ${e.careers_url || 'none'}) — it cannot be provider-checked; give it a name`);
    }

    for (const e of unknownProvider) {
      error(`portals.yml: "${e.name}" sets an unknown provider — ${e.error}. The entry never scans (see providers/ for valid ids)`);
    }
    for (const e of silent) {
      warn(`portals.yml: "${e.name}" is enabled but no provider claims ${e.careers_url || 'its careers_url'} — scan.mjs skips it on every run without naming it (run node audit-portals.mjs)`);
    }
    if (silent.length === 0 && unknownProvider.length === 0 && malformed.length === 0) {
      const enabled = entries.filter(e => e && e.enabled !== false).length;
      ok(handoff.length > 0
        ? `All ${enabled - handoff.length} scannable portals.yml entries resolve to a provider (${handoff.length} on websearch handoff)`
        : `All ${enabled} enabled portals.yml entries resolve to a provider`);
    }
  } catch (err) {
    warn(`Portal coverage check could not run: ${err.message}`);
  }
}

let controlByteRows = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const found = lines[i].match(CONTROL_CHARS);
  if (!found) continue;
  const points = [...new Set(found.map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
  error(`applications.md line ${i + 1}: tracker row contains invisible control character(s) ${points.join(', ')} — delete them; they render as nothing in every view but shift the positional column parse`);
  controlByteRows++;
}
if (controlByteRows === 0) ok('No control characters in tracker cells');

const jdArchiveResult = checkJdArchive(REPORTS_DIR, JDS_DIR, { trackerPath: APPS_FILE, statesPath: STATES_FILE });
const jdArchiveMissing = jdArchiveResult.findings.filter(f => f.type === 'missing-jd-archive');
const jdArchiveReviewDue = jdArchiveResult.findings.filter(f => f.type === 'jd-archive-review-due');
for (const f of jdArchiveMissing) error(`${f.file}: ${f.detail}`);
for (const f of jdArchiveReviewDue) warn(`${f.file}: ${f.detail}`);
for (const w of jdArchiveResult.warnings) warn(`${w.file}: ${w.detail}`);
if (jdArchiveMissing.length === 0 && jdArchiveReviewDue.length === 0 && jdArchiveResult.warnings.length === 0) {
  ok(jdArchiveResult.reportsScanned === 0
    ? 'No reports yet — nothing to check for JD archives'
    : `All ${jdArchiveResult.reportsScanned} report(s) have an archived JD or a resolvable jds/ capture`);
}

console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
