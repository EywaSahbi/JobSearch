#!/usr/bin/env node
import { validateFlags } from './lib/cli-flags.mjs';

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { localToday } from './lib/local-today.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { normalizeStatus, analyzeFromContent } from './followup-cadence.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { parseStatusLogStages, recoverFunnelStages } from './funnel-stages.mjs';
export { parseStatusLogStages } from './funnel-stages.mjs';
import { parseScanHistoryLine } from './lib/scan-history-columns.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(DATA_ROOT);
const SCAN_HISTORY_FILE = join(DATA_ROOT, 'data', 'scan-history.tsv');
const FOLLOWUPS_FILE = join(DATA_ROOT, 'data', 'follow-ups.md');
const SCAN_RUNS_FILE = join(DATA_ROOT, 'data', 'scan-runs.tsv');
const STATUS_LOG_FILE = join(DATA_ROOT, 'data', 'status-log.tsv');
const PORTALS_FILE = join(DATA_ROOT, 'portals.yml');
const PORTAL_HEALTH_FILE = join(DATA_ROOT, 'data', 'portal-health.tsv');

const CANONICAL_STATUSES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];

const ACTIVE_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer']);

const PURSUED_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, total) => (total > 0 ? round1((part / total) * 100) : 0);

function canonicalStatus(raw) {
  const norm = normalizeStatus(String(raw ?? ''));
  if (norm === 'skip') return 'SKIP';
  const cased = norm.charAt(0).toUpperCase() + norm.slice(1);
  return CANONICAL_STATUSES.includes(cased) ? cased : 'Unknown';
}

export function computeTrackerStats(content) {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const byStatus = Object.fromEntries(CANONICAL_STATUSES.map((s) => [s, 0]));
  let total = 0, scoreSum = 0, scoreCount = 0, topScore = 0, withPdf = 0, withReport = 0, activeApps = 0;
  let pursuedSum = 0, pursuedCount = 0;
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    total++;
    const status = canonicalStatus(row.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (ACTIVE_STATUSES.has(status)) activeApps++;
    const score = parseFloat(String(row.score || '').replace(/\*/g, ''));
    if (!Number.isNaN(score) && score > 0) {
      scoreSum += score;
      scoreCount++;
      if (score > topScore) topScore = score;
      if (PURSUED_STATUSES.has(status)) { pursuedSum += score; pursuedCount++; }
    }
    if ((row.pdf || '').includes('✅')) withPdf++;
    if (/\[.*\]\(.*\)/.test(row.report || '')) withReport++;
  }
  return {
    total,
    byStatus,
    avgScore: scoreCount > 0 ? round1(scoreSum / scoreCount) : null,
    avgScoreApplied: pursuedCount > 0 ? round1(pursuedSum / pursuedCount) : null,
    topScore: topScore > 0 ? topScore : null,
    pdfPct: pct(withPdf, total),
    reportPct: pct(withReport, total),
    activeApps,
  };
}

export function trackerStatusByNum(content) {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const byNum = new Map();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) byNum.set(row.num, canonicalStatus(row.status));
  }
  return byNum;
}

export function computeColdAppNums(trackerContent, followupsContent) {
  const result = analyzeFromContent(trackerContent, followupsContent || '');
  if (result.error) return new Set();
  return new Set(result.entries.filter((e) => e.urgency === 'cold').map((e) => e.num));
}

export function computeFunnel(byStatus) {
  const n = (k) => byStatus[k] || 0;
  const everApplied = n('Applied') + n('Responded') + n('Interview') + n('Offer') + n('Hired') + n('Rejected');
  const everResponded = n('Responded') + n('Interview') + n('Offer') + n('Hired') + n('Rejected');
  const everInterview = n('Interview') + n('Offer') + n('Hired');
  const everOffer = n('Offer') + n('Hired');
  return {
    everApplied,
    everResponded,
    everInterview,
    everOffer,
    responseRate: pct(everResponded, everApplied),
    interviewRate: pct(everInterview, everApplied),
    offerRate: pct(everOffer, everApplied),
    smallSample: everApplied < 10,
  };
}

export function computeFunnelWithHistory(statusByNum, ledger) {
  const reached = recoverFunnelStages(statusByNum, ledger);
  let everApplied = 0, everResponded = 0, everInterview = 0, everOffer = 0;
  for (const rank of reached.values()) {
    if (rank >= 1) everApplied++;
    if (rank >= 2) everResponded++;
    if (rank >= 3) everInterview++;
    if (rank >= 4) everOffer++;
  }
  return {
    everApplied,
    everResponded,
    everInterview,
    everOffer,
    responseRate: pct(everResponded, everApplied),
    interviewRate: pct(everInterview, everApplied),
    offerRate: pct(everOffer, everApplied),
    smallSample: everApplied < 10,
    basis: 'ledger',
  };
}

export function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeScanStats(content, { weeks = 8 } = {}) {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const byPortal = {}, byStatus = {};
  const companies = new Set();
  const weekCounts = new Map();
  let totalRecorded = 0, added = 0, firstSeen = null, lastSeen = null;
  for (const line of lines) {
    const { url, first_seen: date, portal, company, status: statusRaw } = parseScanHistoryLine(line);
    if (url === 'url') continue;
    if (!/^https?:\/\//.test(url)) continue;
    totalRecorded++;
    const status = (statusRaw || 'added').trim() || 'added';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (portal) byPortal[portal] = (byPortal[portal] || 0) + 1;
    if (company) companies.add(company.toLowerCase());
    if (status === 'added') {
      added++;
      const wk = isoWeek(date);
      if (wk) weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1);
    }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (!firstSeen || date < firstSeen) firstSeen = date;
      if (!lastSeen || date > lastSeen) lastSeen = date;
    }
  }
  const addedPerWeek = [...weekCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-weeks)
    .map(([week, count]) => ({ week, count }));
  return { totalRecorded, added, byStatus, byPortal, distinctCompanies: companies.size, firstSeen, lastSeen, addedPerWeek };
}

export function scanCompanyNames(content) {
  const names = new Set();
  for (const line of String(content ?? '').replace(/\r/g, '').split('\n')) {
    const row = parseScanHistoryLine(line);
    if (!/^https?:\/\//.test(row.url)) continue;
    const company = row.company.trim();
    if (company) names.add(company.toLowerCase());
  }
  return [...names];
}

export function computePortalStats(portalsYmlContent, scanStats, producingCompanyNames = [], portalHealthContent = null) {
  let cfg;
  try {
    cfg = yaml.load(String(portalsYmlContent ?? '')) || {};
  } catch {
    return null;
  }
  const companies = Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : [];
  const boards = Array.isArray(cfg.job_boards) ? cfg.job_boards : [];
  const configuredNames = new Set(
    companies.map((c) => String(c?.name || '').toLowerCase()).filter(Boolean),
  );
  const producing = new Set(producingCompanyNames.map((n) => String(n).toLowerCase()));
  let producingCompanies = 0;
  for (const name of configuredNames) if (producing.has(name)) producingCompanies++;

  let persistentlyDead = 0;
  if (portalHealthContent) {
    const lines = portalHealthContent.split('\n');
    const healthRecords = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        healthRecords.push({ ts: Date.parse(parts[0]), company: parts[1], status: parts[2] });
      }
    }
    const streaks = new Map();
    const lastProbed = new Map();
    let newestProbe = 0;
    for (const r of healthRecords) {
      if (r.status === 'reachable' || r.status === 'empty') {
        streaks.set(r.company, 0);
      } else {
        streaks.set(r.company, (streaks.get(r.company) || 0) + 1);
      }
      if (Number.isFinite(r.ts)) {
        if (r.ts > (lastProbed.get(r.company) || 0)) lastProbed.set(r.company, r.ts);
        if (r.ts > newestProbe) newestProbe = r.ts;
      }
    }
    const staleMs = (cfg.portal_health_stale_days || 14) * 86400000;
    const threshold = cfg.portal_health_threshold || 3;
    for (const [company, streak] of streaks.entries()) {
      if (streak < threshold) continue;
      if (!configuredNames.has(String(company).toLowerCase())) continue;
      const seen = lastProbed.get(company);
      if (newestProbe && seen && newestProbe - seen > staleMs) continue;
      persistentlyDead++;
    }
  }

  return {
    configuredCompanies: companies.length,
    configuredBoards: boards.length,
    activePortals: Object.keys(scanStats?.byPortal || {}).length,
    producingCompanies,
    producingPct: pct(producingCompanies, configuredNames.size),
    persistentlyDead,
  };
}

export function computePortalRecommendations(portalsContent, scanContent, healthContent, now = Date.now()) {
  let cfg;
  try { cfg = yaml.load(String(portalsContent ?? '')) || {}; } catch { return null; }
  const positive = (n, fallback) => Number.isInteger(n) && n > 0 ? n : fallback;
  const days = positive(cfg.portal_prune_quiet_days, 30);
  const threshold = positive(cfg.portal_health_threshold, 3);
  const cutoff = now - days * 86400000;
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(s || '') && Number.isFinite(Date.parse(s)) && Date.parse(s) <= now;
  const produced = new Set(scanCompanyNames(scanContent));
  const lastMatch = new Map();
  for (const line of String(scanContent ?? '').split('\n')) {
    const c = line.trimEnd().split('\t');
    if (!/^https?:\/\//.test(c[0]) || !validDate(c[1]) || !c[4]) continue;
    const key = c[4].trim().toLowerCase();
    if (!lastMatch.has(key) || c[1] > lastMatch.get(key)) lastMatch.set(key, c[1]);
  }
  const health = new Map();
  const healthRows = [];
  for (const line of String(healthContent ?? '').split('\n')) {
    const [date, company, status] = line.trimEnd().split('\t');
    if (!validDate(date) || !company || !['reachable', 'empty', 'slug_gone', 'network', 'auth', 'server', 'unknown'].includes(status)) continue;
    healthRows.push({ date, company, status });
  }
  healthRows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const { date, company, status } of healthRows) {
    const key = company.toLowerCase();
    const h = health.get(key) || { firstObserved: date, lastObserved: date, streak: 0, status };
    h.firstObserved = date < h.firstObserved ? date : h.firstObserved;
    h.lastObserved = date;
    h.status = status;
    h.streak = status === 'reachable' || status === 'empty' ? 0 : h.streak + 1;
    health.set(key, h);
  }
  const buckets = { neverProduced: [], rotted: [], healthyButQuiet: [] };
  if (scanContent == null) return { quietDays: days, failureThreshold: threshold, ...buckets };
  const seen = new Set();
  for (const company of Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : []) {
    if (!company?.name || company.enabled === false || company.scan_method === 'websearch') continue;
    const key = String(company.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const h = health.get(key);
    if (!h || Date.parse(h.lastObserved) < cutoff) continue;
    const lastProduced = lastMatch.get(key) || null;
    const row = { company: company.name, ...h, lastProduced };
    if (produced.has(key) && h.streak >= threshold) {
      buckets.rotted.push({ ...row, recommendation: 'Verify reachability and find the current ATS slug before considering removal; failures do not prove closure.' });
    } else if (!produced.has(key) && Date.parse(h.firstObserved) <= cutoff) {
      buckets.neverProduced.push({ ...row, recommendation: 'Review title_filter and company-name matching before considering removal; no recorded matches does not prove a dead board.' });
    } else if (produced.has(key) && lastProduced && Date.parse(lastProduced) <= cutoff && h.streak === 0) {
      buckets.healthyButQuiet.push({ ...row, recommendation: 'Keep monitoring: recently reachable, with no recent recorded matches.' });
    }
  }
  return { quietDays: days, failureThreshold: threshold, ...buckets };
}

export function computeFollowupStats(followupsContent, trackerByNum) {
  const byApp = new Map();
  let totalFollowups = 0;
  for (const line of String(followupsContent ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (Number.isNaN(num) || Number.isNaN(appNum)) continue;
    totalFollowups++;
    byApp.set(appNum, (byApp.get(appNum) || 0) + 1);
  }
  let appliedWithoutFollowup = 0;
  for (const [num, status] of trackerByNum) {
    if (status === 'Applied' && !byApp.has(num)) appliedWithoutFollowup++;
  }
  return {
    totalFollowups,
    appsWithFollowups: byApp.size,
    appliedWithoutFollowup,
    avgPerApp: byApp.size > 0 ? round1(totalFollowups / byApp.size) : 0,
  };
}

export function checkFollowupsSchema(followupsContent) {
  const empty = { present: false, sawSeparator: false, pipeLines: 0, dataRows: 0, parsed: 0, unparsedLines: [] };
  if (followupsContent == null) return empty;
  const lines = String(followupsContent).replace(/\r/g, '').split('\n');
  const SEPARATOR_RE = /^\|[\s|:-]+\|?\s*$/;
  let sawSeparator = false;
  let pipeLines = 0;
  let dataRows = 0;
  let parsed = 0;
  const unparsedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    pipeLines++;
    if (SEPARATOR_RE.test(line)) { sawSeparator = true; continue; }
    if (!sawSeparator) continue;
    dataRows++;
    const parts = line.split('|').map((s) => s.trim());
    const readable = parts.length >= 8
      && !Number.isNaN(parseInt(parts[1], 10))
      && !Number.isNaN(parseInt(parts[2], 10));
    if (readable) parsed++;
    else unparsedLines.push(i + 1);
  }
  return { present: true, sawSeparator, pipeLines, dataRows, parsed, unparsedLines };
}

export function computeRunStats(content) {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split('\t');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  if (idx.timestamp == null || idx.found == null) return null;
  const filterCols = header.filter((h) => h.startsWith('filtered_'));
  const rows = [];
  let driftedRows = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    if (cols.length > header.length) { driftedRows++; continue; }
    if (cols.length < header.length) continue;
    if (!/^\d{4}-\d{2}-\d{2}/.test(cols[idx.timestamp] || '')) continue;
    const num = (name) => { const v = Number(cols[idx[name]]); return Number.isNaN(v) ? 0 : v; };
    rows.push({
      date: cols[idx.timestamp].slice(0, 10),
      status: idx.status != null ? cols[idx.status] : 'completed',
      found: num('found'),
      filtered: filterCols.reduce((a, h) => a + num(h), 0),
      newAdded: num('new_added'),
    });
  }
  if (rows.length === 0) {
    return driftedRows > 0
      ? { totalRuns: 0, driftedRows, failedRuns: 0, lastRunDate: null, avgFoundPerRun: 0, avgNewPerRun: 0, filterRemovalPct: 0 }
      : null;
  }
  const completed = rows.filter((r) => r.status === 'completed');
  const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
  return {
    totalRuns: rows.length,
    driftedRows,
    failedRuns: rows.length - completed.length,
    lastRunDate: rows.map((r) => r.date).sort().at(-1),
    avgFoundPerRun: completed.length ? round1(sum(completed, 'found') / completed.length) : 0,
    avgNewPerRun: completed.length ? round1(sum(completed, 'newAdded') / completed.length) : 0,
    filterRemovalPct: pct(sum(completed, 'filtered'), sum(completed, 'found')),
  };
}

export function computeAllStats({
  appsFile = APPS_FILE,
  scanHistoryFile = SCAN_HISTORY_FILE,
  followupsFile = FOLLOWUPS_FILE,
  scanRunsFile = SCAN_RUNS_FILE,
  portalsFile = PORTALS_FILE,
  portalHealthFile = PORTAL_HEALTH_FILE,
  statusLogFile = STATUS_LOG_FILE,
  prune = false,
} = {}) {
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf-8') : null);
  const apps = read(appsFile);
  const scanHist = read(scanHistoryFile);
  const fups = read(followupsFile);
  const portals = read(portalsFile);
  const runs = read(scanRunsFile);
  const portalHealth = read(portalHealthFile);
  const statusLog = read(statusLogFile);
  const trackerBase = apps ? computeTrackerStats(apps) : null;
  const scan = scanHist ? computeScanStats(scanHist) : null;

  let tracker = trackerBase;
  if (trackerBase) {
    const coldNums = computeColdAppNums(apps, fups);
    let activeAppsCold = 0;
    if (coldNums.size > 0) {
      const byNum = trackerStatusByNum(apps);
      for (const [num, status] of byNum) {
        if (ACTIVE_STATUSES.has(status) && coldNums.has(num)) activeAppsCold++;
      }
    }
    tracker = {
      ...trackerBase,
      activeAppsLive: trackerBase.activeApps - activeAppsCold,
      activeAppsCold,
    };
  }

  return {
    metadata: {
      generatedAt: localToday(),
      sources: {
        tracker: !!apps,
        scanHistory: !!scanHist,
        followups: !!fups,
        portals: !!portals,
        scanRuns: !!runs,
        portalHealth: !!portalHealth,
        statusLog: !!statusLog,
      },
    },
    tracker,
    funnel: !tracker
      ? null
      : statusLog
        ? computeFunnelWithHistory(trackerStatusByNum(apps), parseStatusLogStages(statusLog))
        : computeFunnel(tracker.byStatus),
    scan,
    portals: portals ? computePortalStats(portals, scan, scanHist ? scanCompanyNames(scanHist) : [], portalHealth) : null,
    ...(prune ? { portalRecommendations: portals ? computePortalRecommendations(portals, scanHist, portalHealth) : null } : {}),
    followups: fups && apps ? computeFollowupStats(fups, trackerStatusByNum(apps)) : null,
    runs: runs ? computeRunStats(runs) : null,
  };
}

function printSummary(stats) {
  const line = '━'.repeat(45);
  console.log(`\n${line}`);
  console.log(`Pipeline Stats — ${stats.metadata.generatedAt}`);
  console.log(line);
  const t = stats.tracker;
  if (t) {
    const fit = t.avgScore != null
      ? ` | avg fit ${t.avgScore}/5${t.avgScoreApplied != null ? ` (pursued roles ${t.avgScoreApplied}/5)` : ''} | top ${t.topScore}`
      : '';
    const liveInfo = t.activeAppsCold > 0 ? ` (${t.activeAppsLive} live, ${t.activeAppsCold} cold)` : '';
    console.log(`Tracker:    ${t.total} total | ${t.activeApps} active${liveInfo}${fit}`);
    const statusLine = Object.entries(t.byStatus).filter(([, c]) => c > 0).map(([s, c]) => `${s} ${c}`).join(' · ');
    if (statusLine) console.log(`Status:     ${statusLine}`);
  } else {
    console.log('Tracker:    — no data (data/applications.md missing)');
  }
  const f = stats.funnel;
  if (f) {
    const small = f.smallSample ? ' (small sample — rates indicative only)' : '';
    const basis = f.basis === 'ledger' ? ' · ledger-adjusted (folds status-log history)' : '';
    console.log(`Funnel:     ever applied ${f.everApplied} → responded ${f.everResponded} (${f.responseRate}%) → interview ${f.everInterview} (${f.interviewRate}%) → offer ${f.everOffer} (${f.offerRate}%)${small}${basis}`);
  }
  const s = stats.scan;
  if (s) {
    const portalsLine = Object.entries(s.byPortal).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, c]) => `${p} ${c}`).join(' · ');
    console.log(`Scanner:    ${s.totalRecorded} jobs recorded${s.firstSeen ? ` since ${s.firstSeen}` : ''} | ${s.added} added | ${s.distinctCompanies} companies${portalsLine ? ` | ${portalsLine}` : ''}`);
  } else {
    console.log('Scanner:    — no data (data/scan-history.tsv missing)');
  }
  const p = stats.portals;
  if (p) {
    const deadPart = p.persistentlyDead > 0 ? ` | 🚨 ${p.persistentlyDead} persistently dead (run verify-portals.mjs)` : '';
    console.log(`Portals:    ${p.configuredCompanies} companies + ${p.configuredBoards} boards configured | ${p.producingCompanies} have produced a match (${p.producingPct}%)${deadPart} — low ≠ broken, may just be no openings`);
  } else {
    console.log('Portals:    — no data (portals.yml missing)');
  }
  const fu = stats.followups;
  if (fu) {
    console.log(`Follow-ups: ${fu.totalFollowups} sent across ${fu.appsWithFollowups} apps | ${fu.appliedWithoutFollowup} Applied apps with none | avg ${fu.avgPerApp}/app`);
  } else {
    console.log('Follow-ups: — no data (data/follow-ups.md missing)');
  }
  const r = stats.runs;
  if (r && r.totalRuns === 0 && r.driftedRows > 0) {
    console.log(`Runs:       none readable — all ${r.driftedRows} row(s) in scan-runs.tsv are wider than its header, so their columns cannot be read by name.`);
    console.log('            Recover by moving scan-runs.tsv aside; the next scan writes a fresh file with a current header.');
  } else if (r) {
    const failed = r.failedRuns > 0 ? ` | ${r.failedRuns} failed` : '';
    console.log(`Runs:       ${r.totalRuns} recorded (last ${r.lastRunDate})${failed} | avg ${r.avgFoundPerRun} found / ${r.avgNewPerRun} new per run | filters remove ${r.filterRemovalPct}%`);
    if (r.driftedRows > 0) {
      console.log(`            ${r.driftedRows} row(s) excluded — wider than scan-runs.tsv's header, so their columns cannot be read by name. Move the file aside to start a fresh one.`);
    }
  } else {
    console.log('Runs:       — no data (data/scan-runs.tsv missing; created by the next scan)');
  }
  console.log('');
  if (stats.portalRecommendations) {
    console.log('Portal recommendations (read-only; exact-lowercase company matching):');
    for (const [key, label] of [['neverProduced', 'Never produced'], ['rotted', 'Previously producing, failing now'], ['healthyButQuiet', 'Healthy but quiet']]) {
      const rows = stats.portalRecommendations[key];
      console.log(`  ${label}: ${rows.length}`);
      for (const row of rows) console.log(`    ${row.company}: ${row.recommendation}`);
    }
    console.log('No suggestion means insufficient evidence or no current concern, not verified health.');
  }
}

const KNOWN_FLAGS = ['--summary', '--prune', '--help', '-h'];

const USAGE = `Usage:
  node stats.mjs             # full JSON stats to stdout
  node stats.mjs --summary   # human-readable table
  node stats.mjs --prune     # include read-only portal recommendations (also with --summary)
  node stats.mjs --help|-h   # print this usage block and exit`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE);

  const stats = computeAllStats({ prune: args.includes('--prune') });
  if (args.includes('--summary')) printSummary(stats);
  else console.log(JSON.stringify(stats, null, 2));
}
