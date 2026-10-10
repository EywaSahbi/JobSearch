#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import * as yaml from 'js-yaml';

import { parseScanHistory, detectReposts, loadAggregatorCompanies, isKeyLookup } from './detect-reposts.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { normalizeCompany, resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { localToday } from './lib/local-today.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import {
  parseFollowups,
  parseAppliedDate,
  parseDate,
  daysBetween,
  addDays,
  normalizeStatus,
} from './followup-cadence.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(DATA_ROOT, 'config/profile.yml');
const PACKAGE_JSON = join(CAREER_OPS, 'package.json');

const DEFAULT_STALE_AFTER_DAYS = 365;
const DEFAULT_SILENCE_WINDOW_DAYS = 28;

const RESPONDED_STATUSES = new Set(['responded', 'interview', 'offer', 'hired', 'rejected']);
const OUTCOME_LABELS = { responded: 'Responded', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected' };

const EXPLANATION_LINE =
  'high-volume inboxes, evergreen requisitions, re-opened searches, and your own unlogged responses ' +
  'all produce these patterns — facts, not verdicts';

const AGGREGATOR_LINE =
  'marked `aggregator: true` in portals.yml — a multi-employer board, so the same title is a ' +
  'different employer\'s job; posting churn was not evaluated for this company, not found absent';

const companyCollator = new Intl.Collator('en');
const compareCompany = (a, b) => companyCollator.compare(String(a), String(b));

const KNOWN_FLAGS = ['--summary', '--self-test', '--company', '--silence-window', '--include-stale', '--scan-history', '--followups', '--emit-signal', '--help', '-h'];
const VALUE_FLAGS = ['--company', '--silence-window', '--scan-history', '--followups'];

const USAGE = `Usage:
  node company-history.mjs                       # full JSON evidence cards to stdout
  node company-history.mjs --summary              # human-readable cards
  node company-history.mjs --company "Acme"       # single-card lookup
  node company-history.mjs --silence-window 21    # override the default silence window (days)
  node company-history.mjs --include-stale        # include facts older than 365d in label computation
  node company-history.mjs --self-test            # run the in-memory test suite
  node company-history.mjs --summary --emit-signal  # human-readable cards, then RFC #1506 schema-v1 no-response-friction
                                                   # records as JSON Lines (one record per line) on stdout. --emit-signal
                                                   # REQUIRES --summary: without it, default/--company mode already prints
                                                   # a single parsable JSON document, and appending JSON Lines after it
                                                   # would make stdout un-parsable as one JSON value. --summary's output is
                                                   # not JSON to begin with, so appending JSON Lines after it stays clean —
                                                   # bare --emit-signal (no --summary) exits 1 with this same explanation.
  node company-history.mjs --help                 # print this usage block and exit`;

function parseArgs(argv) {
  const args = argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  for (let idx = 0; idx < args.length; idx += 1) {
    const flag = args[idx];
    if (VALUE_FLAGS.includes(flag) && args[idx + 1] === '') {
      console.error(`Error: ${flag} expects a value.`);
      console.error(USAGE);
      process.exit(1);
    }
    if (VALUE_FLAGS.some(valueFlag => flag === `${valueFlag}=`)) {
      console.error(`Error: ${flag.slice(0, -1)} expects a non-empty value.`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  const silenceWindowArg = flagValue(args, '--silence-window');
  if (silenceWindowArg !== undefined && !/^[1-9]\d*$/.test(silenceWindowArg)) {
    console.error(`Error: --silence-window expects a positive integer number of days, got "${silenceWindowArg}"`);
    console.error(USAGE);
    process.exit(1);
  }

  const summaryMode = args.includes('--summary');
  const company = flagValue(args, '--company');
  const emitSignal = args.includes('--emit-signal');

  if (emitSignal && (!summaryMode || company)) {
    console.error('Error: --emit-signal requires --summary and cannot be combined with --company (default and --company mode already print a single JSON document; appending JSON Lines after it would break JSON parsing of stdout). Use: node company-history.mjs --summary --emit-signal');
    console.error(USAGE);
    process.exit(1);
  }

  return {
    summaryMode,
    selfTestMode: args.includes('--self-test'),
    company,
    silenceWindowArg,
    includeStale: args.includes('--include-stale'),
    scanHistoryOverride: flagValue(args, '--scan-history'),
    followupsOverride: flagValue(args, '--followups'),
    emitSignal,
  };
}

export function resolveDefaultSilenceWindow(rootDir = CAREER_OPS) {
  try {
    const path = join(rootDir, 'templates/benchmarks.yml');
    if (!existsSync(path)) return DEFAULT_SILENCE_WINDOW_DAYS;
    const doc = yaml.load(readFileSync(path, 'utf-8'));
    const range = doc?.days_first_response?.range_days;
    const upper = Array.isArray(range) ? range[1] : undefined;
    if (typeof upper === 'number' && Number.isFinite(upper) && upper > 0) return upper * 2;
    return DEFAULT_SILENCE_WINDOW_DAYS;
  } catch {
    return DEFAULT_SILENCE_WINDOW_DAYS;
  }
}

export function today() {
  return new Date(localToday());
}

function resolveNow(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'string') return parseDate(now) || today();
  return today();
}

export function loadTrackerRows(rootDir = CAREER_OPS) {
  const path = resolveTrackerPath(rootDir);
  if (!existsSync(path)) return { rows: [], loaded: false };
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push(row);
  }
  return { rows, loaded: true };
}

export function loadFollowupRows(rootDir = CAREER_OPS, overridePath) {
  const path = overridePath || join(rootDir, 'data/follow-ups.md');
  if (!existsSync(path)) return { rows: [], loaded: false };
  return { rows: parseFollowups(readFileSync(path, 'utf-8')), loaded: true };
}

export function loadRepostClusters(rootDir = CAREER_OPS, overridePath, portalsPath) {
  const path = overridePath || join(rootDir, 'data/scan-history.tsv');
  const aggregators = loadAggregatorCompanies(
    portalsPath || process.env.CAREER_OPS_PORTALS || join(rootDir, 'portals.yml'),
  );
  if (!existsSync(path)) return { clusters: [], aggregators, loaded: false };
  const rows = parseScanHistory(readFileSync(path, 'utf-8'));
  return { clusters: detectReposts(rows, undefined, undefined, aggregators), aggregators, loaded: true };
}

export async function loadStatusLogSource() {
  let mod = null;
  try {
    mod = await import('./funnel-velocity.mjs');
  } catch {
    return { loaded: false, appliedDateByNum: new Map(), medianResponseDays: null };
  }
  if (!mod || typeof mod !== 'object') {
    return { loaded: false, appliedDateByNum: new Map(), medianResponseDays: null };
  }

  const hasAppliedHelper = typeof mod.getAppliedDateObservations === 'function';
  const hasMedianHelper = typeof mod.computeMedianResponseDays === 'function';
  if (!hasAppliedHelper && !hasMedianHelper) {
    return { loaded: false, appliedDateByNum: new Map(), medianResponseDays: null };
  }

  const appliedDateByNum = new Map();
  try {
    if (hasAppliedHelper) {
      const observations = mod.getAppliedDateObservations();
      if (Array.isArray(observations)) {
        for (const obs of observations) {
          if (obs && Number.isFinite(obs.num) && obs.appliedDate) {
            appliedDateByNum.set(obs.num, obs.appliedDate);
          }
        }
      }
    }
  } catch {
  }

  let medianResponseDays = null;
  try {
    if (hasMedianHelper) {
      const value = mod.computeMedianResponseDays();
      if (typeof value === 'number' && Number.isFinite(value)) medianResponseDays = value;
    }
  } catch {
  }

  return { loaded: true, appliedDateByNum, medianResponseDays };
}

export function buildFollowupCountsByAppNum(followupRows) {
  const counts = new Map();
  for (const fu of Array.isArray(followupRows) ? followupRows : []) {
    if (!fu || !Number.isFinite(fu.appNum)) continue;
    counts.set(fu.appNum, (counts.get(fu.appNum) || 0) + 1);
  }
  return counts;
}

export function resolveAppliedDate(row, statusLogAppliedByNum) {
  const fromLog = statusLogAppliedByNum instanceof Map ? statusLogAppliedByNum.get(row.num) : undefined;
  if (fromLog && parseDate(fromLog)) return { dateStr: fromLog, dateBasis: 'status-log' };

  const fromNotes = parseAppliedDate(row.notes);
  if (fromNotes) return { dateStr: fromNotes, dateBasis: 'notes' };

  return { dateStr: row.date, dateBasis: 'evaluation-date' };
}

export function computeResponsiveness(rows, followupCountsByAppNum, opts = {}) {
  const now = resolveNow(opts.now);
  const silenceWindowDays = Number.isFinite(opts.silenceWindowDays) ? opts.silenceWindowDays : DEFAULT_SILENCE_WINDOW_DAYS;
  const staleAfterDays = Number.isFinite(opts.staleAfterDays) ? opts.staleAfterDays : DEFAULT_STALE_AFTER_DAYS;
  const includeStale = !!opts.includeStale;
  const counts = followupCountsByAppNum instanceof Map ? followupCountsByAppNum : new Map();
  const statusLogAppliedByNum = opts.statusLogAppliedByNum instanceof Map ? opts.statusLogAppliedByNum : null;

  const facts = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const normalized = normalizeStatus(String(row.status || ''));

    if (normalized === 'applied') {
      const { dateStr, dateBasis } = resolveAppliedDate(row, statusLogAppliedByNum);
      const appliedDate = parseDate(dateStr);
      if (!appliedDate) continue;

      const silentDays = daysBetween(appliedDate, now);
      if (silentDays < silenceWindowDays) continue;

      const followupsSent = counts.get(row.num) || 0;
      facts.push({
        num: row.num,
        appliedDate: dateStr,
        status: row.status,
        silentDays,
        followupsSent,
        confidence: followupsSent >= 1 ? 'confirmed-by-followups' : 'unconfirmed',
        stale: silentDays > staleAfterDays,
        via: row.via ?? null,
        dateBasis,
        clearInstruction: `if they actually responded, node set-status.mjs --row ${row.num} <state> --on <response-date> clears this`,
      });
    } else if (RESPONDED_STATUSES.has(normalized)) {
      const evalDate = parseDate(row.date) ? row.date : undefined;
      const ageBasisDate = evalDate ? parseDate(evalDate) : null;
      const fact = {
        num: row.num,
        outcome: OUTCOME_LABELS[normalized] || row.status,
        stale: ageBasisDate ? daysBetween(ageBasisDate, now) > staleAfterDays : false,
      };
      if (evalDate) {
        fact.date = evalDate;
        fact.dateBasis = 'evaluation-date';
      }
      if (normalized === 'rejected') fact.note = 'a rejection is an answer';
      facts.push(fact);
    }
  }

  facts.sort((a, b) => a.num - b.num);

  const isSilent = f => 'silentDays' in f;
  const isResponded = f => 'outcome' in f;
  const activeFacts = includeStale ? facts : facts.filter(f => !f.stale);
  const hasSilent = activeFacts.some(isSilent);
  const hasResponded = activeFacts.some(isResponded);

  let label;
  if (hasSilent && hasResponded) label = 'mixed';
  else if (hasSilent) label = 'silent-on-you';
  else if (hasResponded) label = 'responded-before';
  else label = 'no-history';

  return {
    label,
    facts,
    medianResponseDays: Number.isFinite(opts.medianResponseDays) ? opts.medianResponseDays : null,
  };
}

export function computePostingChurn(clusters, scanHistoryLoaded, isAggregator = false) {
  if (!scanHistoryLoaded) return { label: 'no-scan-data', clusters: [] };
  if (isAggregator) return { label: 'aggregator-not-evaluated', clusters: [] };
  const mapped = (Array.isArray(clusters) ? clusters : []).map(c => ({
    role: c.role,
    repostCount: c.repostCount,
    daysSpan: c.daysSpan,
    lastSeen: c.lastSeen,
  }));
  return { label: mapped.length > 0 ? 'reposts-detected' : 'none-detected', clusters: mapped };
}

export function buildCompanyCards(sources, opts = {}) {
  const trackerRows = Array.isArray(sources.trackerRows) ? sources.trackerRows : [];
  const followupRows = Array.isArray(sources.followupRows) ? sources.followupRows : [];
  const repostClusters = Array.isArray(sources.repostClusters) ? sources.repostClusters : [];
  const sourcesLoaded = sources.sourcesLoaded || { tracker: false, followups: false, scanHistory: false, statusLog: false };

  const silenceWindowDays = Number.isFinite(opts.silenceWindowDays) ? opts.silenceWindowDays : DEFAULT_SILENCE_WINDOW_DAYS;
  const staleAfterDays = Number.isFinite(opts.staleAfterDays) ? opts.staleAfterDays : DEFAULT_STALE_AFTER_DAYS;

  let unjoinable = 0;

  const trackerByKey = new Map();
  for (const row of trackerRows) {
    const key = normalizeCompany(String(row?.company || ''));
    if (!key) { unjoinable += 1; continue; }
    if (!trackerByKey.has(key)) trackerByKey.set(key, { company: row.company, rows: [] });
    trackerByKey.get(key).rows.push(row);
  }

  for (const fu of followupRows) {
    const key = normalizeCompany(String(fu?.company || ''));
    if (!key) unjoinable += 1;
  }

  const clustersByKey = new Map();
  for (const cluster of repostClusters) {
    const key = normalizeCompany(String(cluster?.company || ''));
    if (!key) { unjoinable += 1; continue; }
    if (!clustersByKey.has(key)) clustersByKey.set(key, { company: cluster.company, clusters: [] });
    clustersByKey.get(key).clusters.push(cluster);
  }

  const followupCountsByAppNum = buildFollowupCountsByAppNum(followupRows);

  const keys = new Set([...trackerByKey.keys(), ...clustersByKey.keys()]);

  const aggregatorNameByCardKey = new Map();
  if (sources.aggregators instanceof Map) {
    for (const rawName of sources.aggregators.values()) {
      const cardKey = normalizeCompany(String(rawName || ''));
      if (!cardKey) continue;
      aggregatorNameByCardKey.set(cardKey, rawName);
      keys.add(cardKey);
    }
  }

  const cards = [];
  const hygieneAgedApplied = [];

  for (const key of keys) {
    const trackerGroup = trackerByKey.get(key);
    const clusterGroup = clustersByKey.get(key);
    const companyName = trackerGroup?.company || clusterGroup?.company || aggregatorNameByCardKey.get(key) || key;

    const responsiveness = computeResponsiveness(trackerGroup?.rows || [], followupCountsByAppNum, {
      now: opts.now,
      silenceWindowDays,
      staleAfterDays,
      includeStale: opts.includeStale,
      statusLogAppliedByNum: sources.statusLogAppliedByNum,
      medianResponseDays: sources.medianResponseDays,
    });

    const isAggregator = isAggregatorCompany(companyName, sources.aggregators);
    const postingChurn = computePostingChurn(clusterGroup?.clusters || [], sourcesLoaded.scanHistory, isAggregator);

    const hasAnySilent = responsiveness.facts.some(f => 'silentDays' in f);
    const explanations = hasAnySilent ? [EXPLANATION_LINE] : [];
    if (isAggregator && sourcesLoaded.scanHistory) explanations.push(AGGREGATOR_LINE);

    for (const f of responsiveness.facts) {
      if ('silentDays' in f) {
        hygieneAgedApplied.push({ num: f.num, company: companyName, silentDays: f.silentDays });
      }
    }

    cards.push({ company: companyName, key, responsiveness, postingChurn, explanations });
  }

  cards.sort((a, b) => compareCompany(a.company, b.company));
  hygieneAgedApplied.sort((a, b) => b.silentDays - a.silentDays);

  return {
    metadata: {
      silenceWindowDays,
      staleAfterDays,
      companies: cards.length,
      aggregatorCompanies: isKeyLookup(sources.aggregators) ? sources.aggregators.size : 0,
      sources: sourcesLoaded,
    },
    hygiene: { agedApplied: hygieneAgedApplied },
    companies: cards,
    aggregators: isKeyLookup(sources.aggregators) ? sources.aggregators : new Map(),
    dataQuality: { unjoinable },
  };
}

export function isAggregatorCompany(companyName, aggregators) {
  if (!isKeyLookup(aggregators) || aggregators.size === 0) return false;
  const raw = String(companyName || '').trim();
  if (!raw) return false;
  return aggregators.has(normalizeCompanyName(raw) || raw.toLowerCase());
}

export function getCompanyCard(result, companyName, aggregators) {
  const key = normalizeCompany(String(companyName || ''));
  const found = result.companies.find(c => c.key === key);
  if (found) return found;

  const scanHistoryLoaded = !!result.metadata?.sources?.scanHistory;
  const isAggregator = isAggregatorCompany(companyName, aggregators ?? result.aggregators);
  const churnLabel = !scanHistoryLoaded
    ? 'no-scan-data'
    : (isAggregator ? 'aggregator-not-evaluated' : 'none-detected');
  return {
    company: companyName,
    key,
    responsiveness: { label: 'no-history', facts: [] },
    postingChurn: { label: churnLabel, clusters: [] },
    explanations: isAggregator && scanHistoryLoaded ? [AGGREGATOR_LINE] : [],
  };
}

const COUNTRY_REGION_MAP = {
  canada: 'north-america/canada',
  'united states': 'north-america/united-states',
  'united states of america': 'north-america/united-states',
  usa: 'north-america/united-states',
  us: 'north-america/united-states',
  mexico: 'north-america/mexico',
  'united kingdom': 'europe/united-kingdom',
  uk: 'europe/united-kingdom',
  germany: 'europe/germany',
  austria: 'europe/austria',
  switzerland: 'europe/switzerland',
  france: 'europe/france',
  belgium: 'europe/belgium',
  luxembourg: 'europe/luxembourg',
  japan: 'asia/japan',
  india: 'asia/india',
  turkey: 'asia/turkey',
  china: 'asia/china',
  'saudi arabia': 'middle-east/saudi-arabia',
  uae: 'middle-east/united-arab-emirates',
  'united arab emirates': 'middle-east/united-arab-emirates',
  qatar: 'middle-east/qatar',
  australia: 'oceania/australia',
  'new zealand': 'oceania/new-zealand',
};

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveRegion(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return null;
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return null;
  }
  const country = raw?.location?.country;
  if (!country || typeof country !== 'string') return null;
  const mapped = COUNTRY_REGION_MAP[country.trim().toLowerCase()];
  if (mapped) return mapped;
  const slug = slugify(country);
  return slug ? `unmapped/${slug}` : null;
}

export function resolvePostingChannel(via) {
  if (typeof via !== 'string') return 'unknown';
  const trimmed = via.trim();
  if (!trimmed) return 'unknown';
  return trimmed === '—' ? 'direct-employer' : 'staffing-agency';
}

export function resolveEmittedBy(packagePath = PACKAGE_JSON) {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) {
      return `career-ops v${pkg.version}`;
    }
  } catch {
  }
  return 'career-ops';
}

export function computeSourceHash({ companyKey, observedAt }) {
  const raw = `no-response-friction|${companyKey}|${observedAt}`;
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function silentFactObservedAt(fact) {
  const appliedDate = parseDate(fact.appliedDate);
  const source = appliedDate ? fact.appliedDate.trim() : null;
  return typeof source === 'string' && source.length >= 7 ? source.slice(0, 7) : null;
}

export function buildNoResponseFrictionSignals(result, opts = {}) {
  const region = opts.region ?? resolveRegion(opts.profilePath);
  const emittedBy = opts.emittedBy ?? resolveEmittedBy(opts.packagePath);
  const includeStale = !!opts.includeStale;

  const records = [];
  const warnings = [];

  for (const card of Array.isArray(result?.companies) ? result.companies : []) {
    if (card?.responsiveness?.label !== 'silent-on-you') continue;

    if (!region) {
      warnings.push(`region could not be resolved from config/profile.yml — signal not emitted for ${card.key}.`);
      continue;
    }

    const activeFacts = includeStale ? card.responsiveness.facts : card.responsiveness.facts.filter(f => !f.stale);
    const silentFacts = activeFacts.filter(f => 'silentDays' in f && silentFactObservedAt(f) !== null);
    if (silentFacts.length === 0) continue;

    const anchorFact = silentFacts.reduce((a, b) => (
      String(b.appliedDate).trim() > String(a.appliedDate).trim() ? b : a
    ));
    const observedAt = silentFactObservedAt(anchorFact);
    if (!observedAt) continue;

    const severity = silentFacts.length >= 2 ? 'pattern' : 'single';
    const postingChannel = resolvePostingChannel(anchorFact.via);

    records.push({
      schemaVersion: 1,
      companyKey: card.key,
      region,
      signalType: 'no-response-friction',
      detail: null,
      severity,
      sourceDetector: 'company-history',
      sourceHash: computeSourceHash({ companyKey: card.key, observedAt }),
      observedAt,
      emittedBy,
      postingChannel,
    });
  }

  records.sort((a, b) => compareCompany(a.companyKey, b.companyKey));
  return { records, warnings };
}

const LABEL_ORDER = { 'silent-on-you': 0, mixed: 1, 'responded-before': 2, 'no-history': 3 };

export function renderSummary(result) {
  const lines = [];
  lines.push('');
  lines.push('='.repeat(78));
  lines.push('  Company History — career-ops');
  lines.push(`  companies: ${result.companies.length} | silence window: ${result.metadata.silenceWindowDays}d`);
  lines.push('='.repeat(78));
  lines.push('');

  const aged = result.hygiene?.agedApplied || [];
  if (aged.length > 0) {
    lines.push(`  ${aged.length} aged-Applied row(s) look silent — confirm real or update (node set-status.mjs --row <num> <state> --on <response-date>).`);
    lines.push('');
  }

  lines.push('  silence window: ' + result.metadata.silenceWindowDays + 'd — slow to reply is common; silence within the window is expected.');
  lines.push('');

  const sorted = [...result.companies].sort((a, b) => {
    const rank = (LABEL_ORDER[a.responsiveness.label] ?? 9) - (LABEL_ORDER[b.responsiveness.label] ?? 9);
    return rank !== 0 ? rank : compareCompany(a.company, b.company);
  });

  if (sorted.length === 0) {
    lines.push('  No company evidence available (no tracker, follow-up, or scan-history data found).');
    lines.push('');
  }

  for (const card of sorted) {
    lines.push(`  ${card.company} [${card.responsiveness.label}] — postings: ${card.postingChurn.label}`);
    for (const f of card.responsiveness.facts) {
      if ('silentDays' in f) {
        const staleTag = f.stale ? ' (stale)' : '';
        lines.push(`      #${f.num} silent ${f.silentDays}d since ${f.appliedDate} — ${f.followupsSent} follow-up(s), ${f.confidence}${staleTag}`);
      } else {
        const note = f.note ? ` (${f.note})` : '';
        lines.push(`      #${f.num} ${f.outcome}${f.date ? ` (evaluated ${f.date})` : ''}${note}`);
      }
    }
    for (const c of card.postingChurn.clusters) {
      lines.push(`      repost: "${c.role}" seen ${c.repostCount}x over ${c.daysSpan}d, last ${c.lastSeen}`);
    }
    for (const explanation of card.explanations) {
      lines.push(`      note: ${explanation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const NOW = new Date('2026-07-09T00:00:00Z');
  const row = (num, company, status, date, notes = '') => ({ num, date, company, role: 'Engineer', score: '4/5', status, pdf: '✅', report: `reports/${num}.md`, notes });

  {
    const rows = [
      row(1, 'Acme Inc.', 'Applied', '2026-01-01'),
      row(2, 'ACME, INC', 'Applied', '2026-01-02'),
      row(3, '?', 'Applied', '2026-01-03'),
    ];
    const result = buildCompanyCards(
      { trackerRows: rows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(result.companies.length === 1, 'case/punct company variants join under one key');
    check(result.companies[0].responsiveness.facts.length === 2, 'both joined rows contribute facts to the single card');
    check(result.dataQuality.unjoinable === 1, 'a punctuation-only company key is excluded and counted as unjoinable');
  }

  {
    const rows = [
      row(4, 'アクメ株式会社', 'Applied', '2026-01-01'),
      row(5, 'グロベックス合同会社', 'Applied', '2026-01-02'),
      row(6, 'Яндекс', 'Applied', '2026-01-03'),
    ];
    const result = buildCompanyCards(
      { trackerRows: rows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(result.companies.length === 3, 'three different non-Latin companies produce three cards, not one');
    check(result.dataQuality.unjoinable === 0, 'a non-Latin company name is joinable, not a data-quality defect');
  }

  {
    const silentOnly = buildCompanyCards(
      { trackerRows: [row(10, 'SilentCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(silentOnly.companies[0].responsiveness.label === 'silent-on-you', 'silent-only fixture labels silent-on-you');

    const respondedOnly = buildCompanyCards(
      { trackerRows: [row(11, 'RespondedCo', 'Rejected', '2026-06-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(respondedOnly.companies[0].responsiveness.label === 'responded-before', 'responded-only fixture labels responded-before');

    const mixed = buildCompanyCards(
      {
        trackerRows: [
          row(12, 'MixedCo', 'Applied', '2026-05-01'),
          row(13, 'MixedCo', 'Rejected', '2026-06-20'),
        ],
        followupRows: [], repostClusters: [],
        sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(mixed.companies[0].responsiveness.label === 'mixed', 'silent-old + responded-later fixture labels mixed (both retained in facts)');
    check(mixed.companies[0].responsiveness.facts.length === 2, 'mixed card retains both the silent and the responded fact');

    const noHistory = buildCompanyCards(
      { trackerRows: [row(14, 'NoHistoryCo', 'Evaluated', '2026-06-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(noHistory.companies[0].responsiveness.label === 'no-history', 'Evaluated-only fixture labels no-history');
    check(noHistory.companies[0].responsiveness.facts.length === 0, 'no-history card carries no facts');
  }

  {
    const pending = buildCompanyCards(
      { trackerRows: [row(20, 'PendingCo', 'Applied', '2026-07-05')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(pending.companies[0].responsiveness.facts.length === 0, 'Applied row younger than the window produces no fact (pending, right-censored)');
    check(pending.companies[0].responsiveness.label === 'no-history', 'a lone pending row labels no-history, not silent-on-you');
  }

  {
    const rejected = computeResponsiveness([row(30, 'RejCo', 'Rejected', '2026-06-01')], new Map(), { now: NOW, silenceWindowDays: 28 });
    check(rejected.facts.length === 1 && rejected.facts[0].outcome === 'Rejected', 'Rejected row produces a responded fact with outcome Rejected');
    check(rejected.facts[0].note === 'a rejection is an answer', 'Rejected fact carries the rejection-is-an-answer note');
  }

  {
    const hired = computeResponsiveness([row(31, 'HireCo', 'Hired', '2026-06-01')], new Map(), { now: NOW, silenceWindowDays: 28 });
    check(hired.facts.length === 1 && hired.facts[0].outcome === 'Hired', 'Hired row produces a responded fact with outcome Hired');
    check(hired.label === 'responded-before', 'a company that hired you labels responded-before, never no-history');
  }

  {
    const followupsMd = [
      '| # | App# | Date | Company | Role | Channel | Contact | Notes |',
      '|---|------|------|---------|------|---------|---------|-------|',
      '| 1 | 40 | 2026-06-01 | PinCo | Engineer | Email | jane@pinco.com | first nudge |',
      '- next #40 2026-07-15 (set 2026-07-01)',
    ].join('\n');
    const followupRows = parseFollowups(followupsMd);
    check(followupRows.length === 1, 'pin-directive line is not parsed as a sent follow-up row');
    check(followupRows[0].appNum === 40, 'the one real follow-up row parses with the expected appNum');
  }

  {
    const followupRows = [
      { num: 1, appNum: 50, date: '2026-06-01', company: 'ConfA', role: 'x', channel: 'Email', contact: 'a@a.com', notes: '' },
      { num: 2, appNum: 50, date: '2026-06-08', company: 'ConfA', role: 'x', channel: 'Email', contact: 'a@a.com', notes: '' },
    ];
    const result = buildCompanyCards(
      {
        trackerRows: [row(50, 'ConfA', 'Applied', '2026-05-01'), row(51, 'ConfB', 'Applied', '2026-05-01')],
        followupRows, repostClusters: [],
        sourcesLoaded: { tracker: true, followups: true, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    const confA = getCompanyCard(result, 'ConfA');
    const confB = getCompanyCard(result, 'ConfB');
    check(confA.responsiveness.label === 'silent-on-you' && confB.responsiveness.label === 'silent-on-you', 'both rows share the silent-on-you label regardless of follow-up count');
    check(confA.responsiveness.facts[0].confidence === 'confirmed-by-followups', '2 follow-ups sent -> confirmed-by-followups');
    check(confB.responsiveness.facts[0].confidence === 'unconfirmed', '0 follow-ups sent -> unconfirmed');
  }

  {
    const staleRows = [row(60, 'StaleCo', 'Applied', '2025-01-01')];
    const defaultResult = computeResponsiveness(staleRows, new Map(), { now: NOW, silenceWindowDays: 28 });
    check(defaultResult.facts[0].stale === true, 'a >365d-old Applied row is flagged stale');
    check(defaultResult.label === 'no-history', 'a stale-only fact is excluded from label computation by default');

    const includeStaleResult = computeResponsiveness(staleRows, new Map(), { now: NOW, silenceWindowDays: 28, includeStale: true });
    check(includeStaleResult.label === 'silent-on-you', '--include-stale includes the stale fact in label computation');
  }

  {
    const bogusRoot = join(CAREER_OPS, '__does-not-exist__');
    const tracker = loadTrackerRows(bogusRoot);
    check(tracker.loaded === false && tracker.rows.length === 0, 'loadTrackerRows against a nonexistent root degrades gracefully');

    const followups = loadFollowupRows(bogusRoot);
    check(followups.loaded === false && followups.rows.length === 0, 'loadFollowupRows against a nonexistent root degrades gracefully');

    const scanHistory = loadRepostClusters(bogusRoot);
    check(scanHistory.loaded === false && scanHistory.clusters.length === 0, 'loadRepostClusters against a nonexistent root degrades gracefully');

    const result = buildCompanyCards(
      {
        trackerRows: [row(70, 'AloneCo', 'Applied', '2026-05-01')],
        followupRows: [], repostClusters: [],
        sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(result.companies[0].responsiveness.label === 'silent-on-you', 'responsiveness axis still computes when other sources are absent');
    check(result.companies[0].postingChurn.label === 'no-scan-data', 'churn axis reports no-scan-data when scan-history is absent');
  }

  {
    const statusLog = await loadStatusLogSource();
    check(statusLog.loaded === false, 'loadStatusLogSource reports statusLog absent when the merged module exports no usable helper');
    check(statusLog.appliedDateByNum instanceof Map && statusLog.appliedDateByNum.size === 0, 'loadStatusLogSource yields an empty appliedDateByNum against the merged module');
    check(statusLog.medianResponseDays === null, 'loadStatusLogSource yields null medianResponseDays against the merged module');

    const result = computeResponsiveness([row(80, 'NoStatusLogCo', 'Applied', '2026-05-01')], new Map(), { now: NOW, silenceWindowDays: 28 });
    check(result.medianResponseDays === null, 'medianResponseDays is null when not supplied (statusLog absent)');
  }

  {
    const result = buildCompanyCards(
      { trackerRows: [row(90, 'KnownCo', 'Rejected', '2026-06-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const known = getCompanyCard(result, 'KnownCo');
    check(known.responsiveness.label === 'responded-before', 'known company lookup returns its real card');

    const unknown = getCompanyCard(result, 'NeverHeardOfThemCo');
    check(unknown.responsiveness.label === 'no-history' && unknown.responsiveness.facts.length === 0, 'unknown company lookup returns the minimal no-history shape');
    check(unknown.postingChurn.label === 'no-scan-data', 'unknown company lookup reports no-scan-data churn when scan-history never loaded');
  }

  {
    const rows = [
      row(100, 'RespondedA', 'Rejected', '2026-06-01'),
      row(101, 'RespondedB', 'Interview', '2026-06-10'),
      row(102, 'SilentC', 'Applied', '2026-05-01'),
      row(103, 'PendingOnlyD', 'Applied', '2026-07-05'),
      row(104, 'NoHistoryE', 'Evaluated', '2026-06-01'),
    ];
    const result = buildCompanyCards(
      { trackerRows: rows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const labels = result.companies.map(c => c.responsiveness.label);
    check(labels.filter(l => l === 'responded-before').length === 2, 'distribution fixture: 2 companies responded-before');
    check(labels.filter(l => l === 'silent-on-you').length === 1, 'distribution fixture: 1 company silent-on-you');
    check(labels.filter(l => l === 'no-history').length === 2, 'distribution fixture: 2 companies no-history (pending-only + evaluated-only)');
    check(!labels.every(l => l === 'silent-on-you'), 'distribution fixture: NOT everything is silent-on-you');
  }

  {
    const aggregators = new Set([normalizeCompanyName('joinup.ch')]);
    const sourcesLoaded = { tracker: true, followups: false, scanHistory: true, statusLog: false };

    const result = buildCompanyCards(
      {
        trackerRows: [row(200, 'joinup.ch', 'Evaluated', '2026-06-01'), row(201, 'RegularCo', 'Evaluated', '2026-06-01')],
        followupRows: [],
        repostClusters: [{ company: 'RegularCo', role: 'Engineer', repostCount: 2, daysSpan: 30, lastSeen: '2026-06-20' }],
        aggregators,
        sourcesLoaded,
      },
      { now: NOW, silenceWindowDays: 28 },
    );

    const board = getCompanyCard(result, 'joinup.ch');
    check(board.postingChurn.label === 'aggregator-not-evaluated', 'an aggregator reports aggregator-not-evaluated, never none-detected');
    check(board.postingChurn.clusters.length === 0, 'an aggregator card carries no clusters');
    check(
      board.explanations.some(e => /aggregator/i.test(e) && /not evaluated/i.test(e)),
      'the aggregator card says the axis was not evaluated rather than leaving it bare',
    );

    const regular = getCompanyCard(result, 'RegularCo');
    check(regular.postingChurn.label === 'reposts-detected', 'a non-aggregator company is unaffected');
    check(result.metadata.aggregatorCompanies === 1, 'metadata reports how many aggregators were configured');

    const boardOnly = buildCompanyCards(
      {
        trackerRows: [],
        followupRows: [],
        repostClusters: [],
        aggregators: new Map([[normalizeCompanyName('joinup.ch'), 'joinup.ch']]),
        sourcesLoaded,
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(boardOnly.companies.length === 1, 'a flagged board with no tracker rows and no clusters still gets a card');
    check(
      boardOnly.companies[0]?.company === 'joinup.ch',
      'that card is titled with the name from portals.yml, not the normalized key',
    );
    check(
      boardOnly.companies[0]?.postingChurn.label === 'aggregator-not-evaluated',
      'the card-less board still reports aggregator-not-evaluated',
    );
    check(/joinup\.ch/.test(renderSummary(boardOnly)), 'the flagged board appears in --summary rather than vanishing from it');

    const viaSet = buildCompanyCards(
      {
        trackerRows: [], followupRows: [], repostClusters: [],
        aggregators: new Set([normalizeCompanyName('joinup.ch')]), sourcesLoaded,
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(viaSet.metadata.aggregatorCompanies === 1, 'a Set of keys is still accepted alongside the loader\'s Map');

    const unflagged = buildCompanyCards(
      {
        trackerRows: [row(200, 'joinup.ch', 'Evaluated', '2026-06-01')],
        followupRows: [], repostClusters: [], aggregators: new Set(), sourcesLoaded,
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(getCompanyCard(unflagged, 'joinup.ch').postingChurn.label === 'none-detected', 'the same company unflagged reports none-detected');
    check(unflagged.metadata.aggregatorCompanies === 0, 'metadata reports zero when nothing is flagged');

    const unknownBoard = getCompanyCard(result, 'joinup.ch — Never Tracked', aggregators);
    check(
      unknownBoard.postingChurn.label === 'none-detected',
      'an unrelated unknown company still reports none-detected',
    );
    const unknownFlagged = getCompanyCard(
      { ...result, companies: [] },
      'joinup.ch',
    );
    check(
      unknownFlagged.postingChurn.label === 'aggregator-not-evaluated',
      'an aggregator with no card still reports aggregator-not-evaluated via result.aggregators',
    );

    const both = buildCompanyCards(
      {
        trackerRows: [row(202, 'joinup.ch', 'Applied', '2026-05-01')],
        followupRows: [], repostClusters: [], aggregators, sourcesLoaded,
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    const bothCard = getCompanyCard(both, 'joinup.ch');
    check(bothCard.explanations.length === 2, 'a silent aggregator keeps BOTH the silence note and the aggregator note');
    check(renderSummary(both).split('note:').length - 1 === 2, 'renderSummary prints every note, not only the first');
  }

  {
    const rows = [row(110, 'VocabCo', 'Applied', '2026-01-01')];
    const result = buildCompanyCards(
      { trackerRows: rows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const output = renderSummary(result);
    check(!/risk/i.test(output), 'rendered summary never contains the word "risk"');
    check(!/ghost/i.test(output), 'rendered summary never contains the word "ghost"');
  }

  {
    const result = computeResponsiveness([row(120, 'ClearCo', 'Applied', '2026-01-01')], new Map(), { now: NOW, silenceWindowDays: 28 });
    const fact = result.facts[0];
    check(!!fact.appliedDate, 'silent fact carries an appliedDate');
    check(typeof fact.clearInstruction === 'string' && fact.clearInstruction.includes('set-status'), 'silent fact clearInstruction references set-status.mjs');
    check(fact.clearInstruction.includes('--row'), 'silent fact clearInstruction selects the tracker row explicitly via --row');
    check(fact.clearInstruction.includes('--on'), 'silent fact clearInstruction records the response date via --on, not --note free text');
    check(!fact.clearInstruction.includes('--note'), 'silent fact clearInstruction does not smuggle the response date into --note free text');
  }

  {
    const fixedOpts = { region: 'north-america/canada', emittedBy: 'career-ops vTEST' };

    const singleResult = buildCompanyCards(
      { trackerRows: [row(200, 'SingleSilentCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: singleSignals, warnings: singleWarnings } = buildNoResponseFrictionSignals(singleResult, fixedOpts);
    check(singleWarnings.length === 0, 'resolvable region: no warnings emitted');
    check(singleSignals.length === 1, 'exactly one no-response-friction record emitted for a single silent-on-you card');
    check(singleSignals[0]?.severity === 'single', 'one silent fact on the card -> severity single');
    check(singleSignals[0]?.signalType === 'no-response-friction', 'emitted record carries signalType no-response-friction');
    check(singleSignals[0]?.companyKey === singleResult.companies[0].key, 'emitted companyKey reuses company-history.mjs\'s own normalized key, not a new format');
    check(singleSignals[0]?.region === 'north-america/canada', 'emitted region matches the resolved region');
    check(singleSignals[0]?.emittedBy === 'career-ops vTEST', 'emitted emittedBy matches the resolved version string');
    check(/^\d{4}-\d{2}$/.test(singleSignals[0]?.observedAt || ''), 'observedAt is strictly month-only (YYYY-MM, no day)');
    check(typeof singleSignals[0]?.sourceHash === 'string' && singleSignals[0].sourceHash.startsWith('sha256:'), 'sourceHash is present and sha256-prefixed');
    check(singleSignals[0]?.schemaVersion === 1, 'emitted record carries schemaVersion 1 (ratified RFC #1506 shape)');
    check(singleSignals[0]?.detail === null, 'emitted record carries detail: null — this signal is derived purely from dates, no free text');
    check(singleSignals[0]?.sourceDetector === 'company-history', 'emitted record carries sourceDetector: company-history (the producing tool, not the signal name — matches interview-redflag.mjs precedent)');

    const patternResult = buildCompanyCards(
      {
        trackerRows: [
          row(201, 'PatternSilentCo', 'Applied', '2026-01-01'),
          row(202, 'PatternSilentCo', 'Applied', '2026-02-01'),
        ],
        followupRows: [], repostClusters: [],
        sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(patternResult.companies[0].responsiveness.label === 'silent-on-you', 'two-application silent fixture still labels silent-on-you (precondition for the pattern check below)');
    const { records: patternSignals } = buildNoResponseFrictionSignals(patternResult, fixedOpts);
    check(patternSignals.length === 1, 'still exactly one record per company card, even with 2 silent facts');
    check(patternSignals[0]?.severity === 'pattern', 'two silent facts on the same card -> severity pattern');

    const sameMonthSingleResult = buildCompanyCards(
      { trackerRows: [row(240, 'SeverityHashCo', 'Applied', '2026-05-03')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const sameMonthPatternResult = buildCompanyCards(
      {
        trackerRows: [
          row(241, 'SeverityHashCo', 'Applied', '2026-05-03'),
          row(242, 'SeverityHashCo', 'Applied', '2026-05-10'),
        ],
        followupRows: [], repostClusters: [],
        sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: sameMonthSingleSignals } = buildNoResponseFrictionSignals(sameMonthSingleResult, fixedOpts);
    const { records: sameMonthPatternSignals } = buildNoResponseFrictionSignals(sameMonthPatternResult, fixedOpts);
    check(sameMonthSingleSignals[0]?.severity === 'single' && sameMonthPatternSignals[0]?.severity === 'pattern', 'severity/hash fixture: single vs pattern severity actually differs (precondition)');
    check(sameMonthSingleSignals[0]?.observedAt === sameMonthPatternSignals[0]?.observedAt, 'severity/hash fixture: both anchor to the same observedAt month (precondition)');
    check(sameMonthSingleSignals[0]?.sourceHash === sameMonthPatternSignals[0]?.sourceHash, 'sourceHash is identical for the same companyKey+observedAt despite different severity (single vs pattern) — fixes the dedup-breaking bug from PR #2788 review');

    const noSignalResult = buildCompanyCards(
      {
        trackerRows: [
          row(210, 'RespondedNoSignalCo', 'Rejected', '2026-06-01'),
          row(211, 'MixedNoSignalCo', 'Applied', '2026-01-01'),
          row(212, 'MixedNoSignalCo', 'Rejected', '2026-06-20'),
          row(213, 'NoHistoryNoSignalCo', 'Evaluated', '2026-06-01'),
        ],
        followupRows: [], repostClusters: [],
        sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false },
      },
      { now: NOW, silenceWindowDays: 28 },
    );
    const labelsPresent = noSignalResult.companies.map(c => c.responsiveness.label);
    check(labelsPresent.includes('responded-before') && labelsPresent.includes('mixed') && labelsPresent.includes('no-history'), 'no-signal fixture actually exercises responded-before, mixed, and no-history cards');
    const { records: noSignals } = buildNoResponseFrictionSignals(noSignalResult, fixedOpts);
    check(noSignals.length === 0, 'responded-before, mixed, and no-history cards emit zero no-response-friction records');

    const allEmitted = [...singleSignals, ...patternSignals];
    for (const record of allEmitted) {
      const keys = Object.keys(record).sort();
      check(
        JSON.stringify(keys) === JSON.stringify([
          'companyKey', 'detail', 'emittedBy', 'observedAt', 'postingChannel', 'region',
          'schemaVersion', 'severity', 'signalType', 'sourceDetector', 'sourceHash',
        ]),
        'emitted record carries the ratified schema-v1 10 fields plus the additive postingChannel field (#3010), nothing extra (no notes/name leakage), nothing missing',
      );
    }

    const { records: singleSignalsAgain } = buildNoResponseFrictionSignals(
      buildCompanyCards(
        { trackerRows: [row(200, 'SingleSilentCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
        { now: NOW, silenceWindowDays: 28 },
      ),
      fixedOpts,
    );
    check(singleSignalsAgain[0]?.sourceHash === singleSignals[0]?.sourceHash, 'sourceHash is deterministic across repeated runs against the same fact (dedup-safe)');

    const { records: differentCompanySignals } = buildNoResponseFrictionSignals(
      buildCompanyCards(
        { trackerRows: [row(203, 'DifferentCompanyCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
        { now: NOW, silenceWindowDays: 28 },
      ),
      fixedOpts,
    );
    check(differentCompanySignals[0]?.sourceHash !== singleSignals[0]?.sourceHash, 'sourceHash differs when companyKey differs (same observedAt month) — companyKey is a real hash input, not dropped');

    const { records: differentMonthSignals } = buildNoResponseFrictionSignals(
      buildCompanyCards(
        { trackerRows: [row(204, 'SingleSilentCo', 'Applied', '2026-06-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
        { now: NOW, silenceWindowDays: 28 },
      ),
      fixedOpts,
    );
    check(differentMonthSignals[0]?.sourceHash !== singleSignals[0]?.sourceHash, 'sourceHash differs when observedAt differs (same companyKey) — observedAt is a real hash input, not dropped');

    const staleRows = [
      row(220, 'ActivePlusStaleCo', 'Applied', '2026-06-01'),
      row(221, 'ActivePlusStaleCo', 'Applied', '2024-01-01'),
    ];
    const activePlusStaleResult = buildCompanyCards(
      { trackerRows: staleRows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(activePlusStaleResult.companies[0].responsiveness.label === 'silent-on-you', 'active+stale fixture: label is silent-on-you (only the active fact drives it)');
    const activePlusStaleFacts = activePlusStaleResult.companies[0].responsiveness.facts;
    check(activePlusStaleFacts.some(f => f.stale) && activePlusStaleFacts.some(f => !f.stale), 'active+stale fixture: card carries both a stale and an active silent fact');
    const { records: activePlusStaleSignals } = buildNoResponseFrictionSignals(activePlusStaleResult, fixedOpts);
    check(activePlusStaleSignals.length === 1, 'active+stale fixture: still exactly one record for the card');
    check(activePlusStaleSignals[0]?.severity === 'single', 'active+stale fixture: severity is single — the stale fact does not inflate it to pattern, matching the label');

    const activePlusStaleIncludeStaleResult = buildCompanyCards(
      { trackerRows: staleRows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28, includeStale: true },
    );
    const { records: activePlusStaleIncludeStaleSignals } = buildNoResponseFrictionSignals(
      activePlusStaleIncludeStaleResult,
      { ...fixedOpts, includeStale: true },
    );
    check(activePlusStaleIncludeStaleSignals[0]?.severity === 'pattern', 'active+stale fixture with includeStale:true: severity is pattern — the stale fact now counts');

    const unusableDateResult = {
      companies: [{
        key: 'unusable-date-co',
        responsiveness: {
          label: 'silent-on-you',
          facts: [{ num: 1, appliedDate: 'not-a-real-date', silentDays: 40, stale: false }],
        },
      }],
    };
    const { records: unusableDateSignals } = buildNoResponseFrictionSignals(unusableDateResult, fixedOpts);
    check(unusableDateSignals.length === 0, 'a card whose anchor fact has an unusable appliedDate is skipped entirely — no record emitted');

    const mixedValidityResult = {
      companies: [{
        key: 'mixed-validity-co',
        responsiveness: {
          label: 'silent-on-you',
          facts: [
            { num: 1, appliedDate: '2026-06-01', silentDays: 40, stale: false },
            { num: 2, appliedDate: 'not-a-real-date', silentDays: 40, stale: false },
          ],
        },
      }],
    };
    const { records: mixedValiditySignals } = buildNoResponseFrictionSignals(mixedValidityResult, fixedOpts);
    check(mixedValiditySignals.length === 1, 'mixed valid/invalid facts: still exactly one record — the invalid fact does not block emission');
    check(mixedValiditySignals[0]?.observedAt === '2026-06', 'mixed valid/invalid facts: observedAt anchors on the valid fact');
    check(mixedValiditySignals[0]?.severity === 'single', 'mixed valid/invalid facts: severity is single — the invalid fact does not count toward pattern');

    const paddedDateResult = {
      companies: [{
        key: 'padded-date-co',
        responsiveness: {
          label: 'silent-on-you',
          facts: [{ num: 1, appliedDate: ' 2026-06-01 ', silentDays: 40, stale: false }],
        },
      }],
    };
    const { records: paddedDateSignals } = buildNoResponseFrictionSignals(paddedDateResult, fixedOpts);
    check(paddedDateSignals[0]?.observedAt === '2026-06', 'a whitespace-padded appliedDate still produces a clean YYYY-MM observedAt');

    const outOfOrderRows = [
      row(230, 'OutOfOrderCo', 'Applied', '2026-06-01'),
      row(231, 'OutOfOrderCo', 'Applied', '2026-01-01'),
    ];
    const outOfOrderResult = buildCompanyCards(
      { trackerRows: outOfOrderRows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: outOfOrderSignals } = buildNoResponseFrictionSignals(outOfOrderResult, fixedOpts);
    check(outOfOrderSignals[0]?.observedAt === '2026-06', 'anchor fact is chosen by appliedDate (2026-06-01), not by the larger tracker row num (231, dated 2026-01-01)');

    const paddedAnchorRows = [
      row(240, 'PaddedAnchorCo', 'Applied', ' 2026-06-01 '),
      row(241, 'PaddedAnchorCo', 'Applied', '2026-05-01'),
    ];
    const paddedAnchorResult = buildCompanyCards(
      { trackerRows: paddedAnchorRows, followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: paddedAnchorSignals } = buildNoResponseFrictionSignals(paddedAnchorResult, fixedOpts);
    check(paddedAnchorSignals[0]?.observedAt === '2026-06', 'anchor selection trims before comparing, so a whitespace-padded but more-recent appliedDate still wins over a clean but older one');

    check(resolveRegion(join(CAREER_OPS, '__does-not-exist__.yml')) === null, 'resolveRegion degrades to null (not the string "unknown") when profile.yml is absent');
    check(resolveEmittedBy(join(CAREER_OPS, '__does-not-exist__.json')) === 'career-ops', 'resolveEmittedBy degrades to a version-less string when package.json is unreadable');

    const regionTmpDir = mkdtempSync(join(tmpdir(), 'company-history-region-test-'));
    try {
      const mappedProfilePath = join(regionTmpDir, 'mapped-profile.yml');
      writeFileSync(mappedProfilePath, 'location:\n  country: Canada\n');
      check(resolveRegion(mappedProfilePath) === 'north-america/canada', 'resolveRegion maps a known country via COUNTRY_REGION_MAP');

      const unmappedProfilePath = join(regionTmpDir, 'unmapped-profile.yml');
      writeFileSync(unmappedProfilePath, 'location:\n  country: Narnia\n');
      check(resolveRegion(unmappedProfilePath) === 'unmapped/narnia', 'resolveRegion degrades an unmapped country to unmapped/<slug>, not null');

      const noRegionProfilePath = join(regionTmpDir, 'no-region-profile.yml');
      writeFileSync(noRegionProfilePath, 'someOtherKey: true\n');
      const noRegionResult = buildCompanyCards(
        { trackerRows: [row(250, 'NoRegionCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
        { now: NOW, silenceWindowDays: 28 },
      );
      const { records: noRegionSignals, warnings: noRegionWarnings } = buildNoResponseFrictionSignals(
        noRegionResult,
        { profilePath: noRegionProfilePath, emittedBy: 'career-ops vTEST' },
      );
      check(noRegionSignals.length === 0, 'unresolvable region: no no-response-friction record emitted, no crash');
      check(noRegionWarnings.length === 1 && noRegionWarnings[0].includes(noRegionResult.companies[0].key), 'unresolvable region: exactly one warning naming the skipped companyKey');
    } finally {
      rmSync(regionTmpDir, { recursive: true, force: true });
    }
  }

  {
    const agencyResult = buildCompanyCards(
      { trackerRows: [{ ...row(260, 'AgencyPostedCo', 'Applied', '2026-05-01'), via: 'Hays' }], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    check(agencyResult.companies[0].responsiveness.facts[0].via === 'Hays', 'row.via survives onto the silent fact');
    const { records: agencySignals } = buildNoResponseFrictionSignals(agencyResult, { region: 'north-america/canada', emittedBy: 'career-ops vTEST' });
    check(agencySignals[0]?.postingChannel === 'staffing-agency', 'a tagged agency via value emits postingChannel: staffing-agency');

    const directResult = buildCompanyCards(
      { trackerRows: [{ ...row(261, 'DirectConfirmedCo', 'Applied', '2026-05-01'), via: '—' }], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: directSignals } = buildNoResponseFrictionSignals(directResult, { region: 'north-america/canada', emittedBy: 'career-ops vTEST' });
    check(directSignals[0]?.postingChannel === 'direct-employer', 'an em-dash via value (confirmed direct, no agency) emits postingChannel: direct-employer');

    const noDataResult = buildCompanyCards(
      { trackerRows: [row(262, 'NoViaDataCo', 'Applied', '2026-05-01')], followupRows: [], repostClusters: [], sourcesLoaded: { tracker: true, followups: false, scanHistory: false, statusLog: false } },
      { now: NOW, silenceWindowDays: 28 },
    );
    const { records: noDataSignals } = buildNoResponseFrictionSignals(noDataResult, { region: 'north-america/canada', emittedBy: 'career-ops vTEST' });
    check(noDataSignals[0]?.postingChannel === 'unknown', 'a row with no recorded via emits postingChannel: unknown, never a guessed direct-employer');

    check(resolvePostingChannel('  ') === 'unknown', 'resolvePostingChannel: whitespace-only via is unknown, not staffing-agency');
    check(resolvePostingChannel(null) === 'unknown', 'resolvePostingChannel: null via is unknown');
    check(resolvePostingChannel(undefined) === 'unknown', 'resolvePostingChannel: undefined via is unknown');
    check(resolvePostingChannel('Acme Staffing') === 'staffing-agency', 'resolvePostingChannel: any non-em-dash tagged agency name is staffing-agency');
    check(resolvePostingChannel('—') === 'direct-employer', 'resolvePostingChannel: exact em-dash is direct-employer');
  }

  console.log(`\n  company-history self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const { summaryMode, selfTestMode, company, silenceWindowArg, includeStale, scanHistoryOverride, followupsOverride, emitSignal } =
    parseArgs(process.argv);

  if (selfTestMode) {
    runSelfTest().catch(err => {
      console.error(`company-history.mjs: self-test error: ${err?.message || err}`);
      process.exit(1);
    });
  } else {
    const run = async () => {
      const tracker = loadTrackerRows(CAREER_OPS);
      const followups = loadFollowupRows(CAREER_OPS, followupsOverride);
      const scanHistory = loadRepostClusters(CAREER_OPS, scanHistoryOverride);
      const statusLog = await loadStatusLogSource();

      const silenceWindowDays = silenceWindowArg !== undefined
        ? parseInt(silenceWindowArg, 10)
        : resolveDefaultSilenceWindow(CAREER_OPS);

      const result = buildCompanyCards(
        {
          trackerRows: tracker.rows,
          followupRows: followups.rows,
          repostClusters: scanHistory.clusters,
          aggregators: scanHistory.aggregators,
          sourcesLoaded: {
            tracker: tracker.loaded,
            followups: followups.loaded,
            scanHistory: scanHistory.loaded,
            statusLog: statusLog.loaded,
          },
          statusLogAppliedByNum: statusLog.appliedDateByNum,
          medianResponseDays: statusLog.medianResponseDays,
        },
        { silenceWindowDays, includeStale },
      );

      if (company) {
        console.log(JSON.stringify(getCompanyCard(result, company), null, 2));
      } else if (summaryMode) {
        console.log(renderSummary(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }

      if (emitSignal) {
        const { records: signals, warnings } = buildNoResponseFrictionSignals(result, { includeStale });
        for (const warning of warnings) {
          console.error(`company-history.mjs: ${warning}`);
        }
        for (const record of signals) {
          console.log(JSON.stringify(record));
        }
      }
    };

    run().catch(err => {
      console.error(`company-history.mjs: unexpected error: ${err?.message || err}`);
      process.exit(1);
    });
  }
}
