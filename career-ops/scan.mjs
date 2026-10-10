#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import * as yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { buildTrustValidator } from './providers/_trust-validator.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { mergeProviderPlugins } from './plugins/_engine.mjs';
import { classifyFetchError } from './verify-portals.mjs';
import { fingerprintText, findCrossListings } from './fingerprint-core.mjs';
import { resolveColumns, parseTrackerRow, normalizeTextKey, extractReqNumber, REQ_NUMBER_RE } from './tracker-parse.mjs';
import { workdayDedupKey, stripWorkdayRepostSuffix, isWorkdayJobUrl } from './providers/workday.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { compileKeyword, compilePositiveKeyword, compileContentKeyword, buildTitleFilter, foldAccents } from './title-keywords.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { withPortalHealthLock } from './portal-health-lock.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { SCAN_HISTORY_COLUMNS, parseScanHistoryLine } from './lib/scan-history-columns.mjs';
import { escapeFormulaCell } from './lib/tsv-formula-escape.mjs';
import { promoteKnownFragmentIdentity } from './url-key.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

try {
  const { config } = await import('dotenv');
  config({ path: path.join(DATA_ROOT, '.env'), quiet: true });
} catch {
}

const parseYaml = yaml.load;

import { resolveTrackerPath } from './path-resolver.mjs';

export const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(DATA_ROOT, 'portals.yml');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || path.join(DATA_ROOT, 'config/profile.yml');
export const SCAN_HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || path.join(DATA_ROOT, 'data/scan-history.tsv');
export const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || path.join(DATA_ROOT, 'data/pipeline.md');

export const APPLICATIONS_PATH = resolveTrackerPath(DATA_ROOT);
const PROVIDERS_DIR = path.resolve(CODE_ROOT, 'providers');

const CONCURRENCY = 10;

export function isIgnorableDirectoryFsyncError(err, platform = process.platform) {
  return ['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(err?.code)
    || (platform === 'win32' && ['EACCES', 'EPERM'].includes(err?.code));
}

export function atomicWriteFile(filePath, text) {
  const fileStat = lstatSync(filePath, { throwIfNoEntry: false });
  const targetPath = fileStat?.isSymbolicLink() ? realpathSync(filePath) : filePath;
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  let directoryFd = null;
  try {
    const existingMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o7777 : null;
    fd = openSync(tempPath, 'wx', 0o600);
    if (existingMode !== null) fchmodSync(fd, existingMode);
    writeFileSync(fd, text, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, targetPath);
    try {
      directoryFd = openSync(path.dirname(targetPath), 'r');
      fsyncSync(directoryFd);
    } catch (err) {
      if (!isIgnorableDirectoryFsyncError(err)) throw err;
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
      directoryFd = null;
    }
  } catch (err) {
    if (fd !== null) closeSync(fd);
    if (directoryFd !== null) closeSync(directoryFd);
    try { unlinkSync(tempPath); } catch { }
    throw err;
  }
}

export function emitJsonReceipt(receipt, exitCode) {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = exitCode;
}

export { compileKeyword, compilePositiveKeyword, compileContentKeyword, buildTitleFilter };

export function normalizeFilterOn(value) {
  const list = (Array.isArray(value) ? value : [value])
    .filter(f => typeof f === 'string')
    .map(f => f.trim())
    .filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : ['title'];
}

export function declaredFieldKey(targetId, field) {
  return JSON.stringify([targetId, field]);
}

export function isFieldAbsent(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

export function declaredFieldValue(job, field) {
  const value = Object.hasOwn(job, field) ? job[field] : undefined;
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

export function buildTitleFilterOverrides(overrides) {
  const map = new Map();
  if (!Array.isArray(overrides)) return map;
  for (const entry of overrides) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const companies = Array.isArray(entry.companies) ? entry.companies : [];
    const extraRaw = Array.isArray(entry.positive_extra) ? entry.positive_extra : [];
    const matchers = extraRaw
      .filter(k => typeof k === 'string')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0)
      .map(compilePositiveKeyword);
    if (matchers.length === 0) continue;
    for (const slug of companies) {
      if (typeof slug !== 'string' || !slug.trim()) continue;
      const key = slug.trim().toLowerCase();
      map.set(key, (map.get(key) || []).concat(matchers));
    }
  }
  return map;
}

export function buildTitleFilterWithOverrides(titleFilter, overridesMap) {
  const base = buildTitleFilter(titleFilter);
  const overrides = overridesMap instanceof Map ? overridesMap : new Map();
  if (overrides.size === 0) return (title) => base(title);

  const normalize = (arr) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0)
    .map(compileKeyword);
  const negative = normalize(titleFilter?.negative);

  return (title, companySlug) => {
    if (base(title)) return true;
    const extra = overrides.get(String(companySlug ?? '').trim().toLowerCase());
    if (!extra || extra.length === 0) return false;
    const lower = String(title ?? '').toLowerCase();
    if (negative.some(m => m(lower))) return false;
    return extra.some(m => m(lower));
  };
}

const compiledPositiveCache = new WeakMap();

function compiledPositiveMatchers(positiveList) {
  if (compiledPositiveCache.has(positiveList)) return compiledPositiveCache.get(positiveList);
  const compiled = positiveList
    .filter(k => typeof k === 'string' && k.trim().length > 0)
    .map(k => ({ raw: k, match: compilePositiveKeyword(foldAccents(k.trim().toLowerCase())) }));
  compiledPositiveCache.set(positiveList, compiled);
  return compiled;
}

export function matchedTitleKeywords(title, titleFilter) {
  const raw = Array.isArray(titleFilter?.positive) ? titleFilter.positive : [];
  const lower = foldAccents((title || '').toLowerCase());
  return compiledPositiveMatchers(raw)
    .filter(({ match }) => match(lower))
    .map(({ raw: kw }) => kw);
}

function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

const LOCATION_WORD_CP = /^[\p{L}\p{M}\p{N}]$/u;

function compileLocationKeyword(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codePoints = [...keyword];
  const startsWord = LOCATION_WORD_CP.test(codePoints[0] ?? '');
  const endsWord = LOCATION_WORD_CP.test(codePoints.at(-1) ?? '');
  const prefix = startsWord ? '(?<![\\p{L}\\p{M}\\p{N}])' : '';
  const suffix = endsWord ? '(?![\\p{L}\\p{M}\\p{N}])' : '';
  const re = new RegExp(`${prefix}${escaped}${suffix}`, 'u');
  return (lower) => re.test(lower);
}

function compileLocationKeywordList(value) {
  return normalizeKeywordList(value).map(compileLocationKeyword);
}

const US_COUNTRY_ALWAYS_ALLOW = new Set(['united states', 'usa', 'u.s.', 'u.s.a.']);
const USPS_STATES = Object.freeze([
  Object.freeze(['alabama', 'al']),
  Object.freeze(['alaska', 'ak']),
  Object.freeze(['arizona', 'az']),
  Object.freeze(['arkansas', 'ar']),
  Object.freeze(['california', 'ca']),
  Object.freeze(['colorado', 'co']),
  Object.freeze(['connecticut', 'ct']),
  Object.freeze(['delaware', 'de']),
  Object.freeze(['florida', 'fl']),
  Object.freeze(['georgia', 'ga']),
  Object.freeze(['hawaii', 'hi']),
  Object.freeze(['idaho', 'id']),
  Object.freeze(['illinois', 'il']),
  Object.freeze(['indiana', 'in']),
  Object.freeze(['iowa', 'ia']),
  Object.freeze(['kansas', 'ks']),
  Object.freeze(['kentucky', 'ky']),
  Object.freeze(['louisiana', 'la']),
  Object.freeze(['maine', 'me']),
  Object.freeze(['maryland', 'md']),
  Object.freeze(['massachusetts', 'ma']),
  Object.freeze(['michigan', 'mi']),
  Object.freeze(['minnesota', 'mn']),
  Object.freeze(['mississippi', 'ms']),
  Object.freeze(['missouri', 'mo']),
  Object.freeze(['montana', 'mt']),
  Object.freeze(['nebraska', 'ne']),
  Object.freeze(['nevada', 'nv']),
  Object.freeze(['new hampshire', 'nh']),
  Object.freeze(['new jersey', 'nj']),
  Object.freeze(['new mexico', 'nm']),
  Object.freeze(['new york', 'ny']),
  Object.freeze(['north carolina', 'nc']),
  Object.freeze(['north dakota', 'nd']),
  Object.freeze(['ohio', 'oh']),
  Object.freeze(['oklahoma', 'ok']),
  Object.freeze(['oregon', 'or']),
  Object.freeze(['pennsylvania', 'pa']),
  Object.freeze(['rhode island', 'ri']),
  Object.freeze(['south carolina', 'sc']),
  Object.freeze(['south dakota', 'sd']),
  Object.freeze(['tennessee', 'tn']),
  Object.freeze(['texas', 'tx']),
  Object.freeze(['utah', 'ut']),
  Object.freeze(['vermont', 'vt']),
  Object.freeze(['virginia', 'va']),
  Object.freeze(['washington', 'wa']),
  Object.freeze(['west virginia', 'wv']),
  Object.freeze(['wisconsin', 'wi']),
  Object.freeze(['wyoming', 'wy']),
]);

function compileUsStateAbbrev(abbr) {
  const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:,\\s*${escaped}(?![\\p{L}\\p{M}\\p{N}])|(?:^|[^\\p{L}\\p{M}\\p{N}])${escaped}[^\\p{L}\\p{M}\\p{N}]*$)`, 'u');
  return (lower) => re.test(lower);
}

const US_STATE_ALWAYS_ALLOW_MATCHERS = USPS_STATES.flatMap(([name, abbr]) => [
  compileLocationKeyword(name),
  compileUsStateAbbrev(abbr),
]);

export function locationHintFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (!parsed.hostname.toLowerCase().endsWith('.myworkdayjobs.com')) return '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIdx = segments.lastIndexOf('job');
  if (jobIdx === -1 || segments.length - jobIdx - 1 < 2) return '';
  let segment = segments[jobIdx + 1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
  }
  return segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;

export const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

export function titleSignalsRemote(title) {
  if (typeof title !== 'string' || title.trim() === '') return false;
  const lower = title.toLowerCase();
  if (REMOTE_NEGATED_RE.test(lower)) return false;
  return REMOTE_TITLE_RE.test(lower);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllowKeywords = normalizeKeywordList(locationFilter.always_allow);
  const alwaysAllow = alwaysAllowKeywords.map(compileLocationKeyword);
  if (alwaysAllowKeywords.some(k => US_COUNTRY_ALWAYS_ALLOW.has(k))) {
    alwaysAllow.push(...US_STATE_ALWAYS_ALLOW_MATCHERS);
  }
  const allow = compileLocationKeywordList(locationFilter.allow);
  const block = compileLocationKeywordList(locationFilter.block);
  const blockHard = compileLocationKeywordList(locationFilter.block_hard);
  const strict = locationFilter.strict === true
    && (allow.length > 0 || block.length > 0 || blockHard.length > 0);

  return (location, url, title) => {
    const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const hint = locationHintFromUrl(url);
    if (lower === '' && hint === '') return !strict;
    const matches = (m) => (lower !== '' && m(lower)) || (hint !== '' && m(hint));
    if (blockHard.length > 0 && blockHard.some(matches)) return false;
    if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
    if (block.length > 0 && block.some(matches)) return false;
    if (allow.length === 0) return true;
    if (allow.some(matches)) return true;
    return titleSignalsRemote(title);
  };
}

export function buildPostingAgeFilter(maxAgeDays, now = Date.now()) {
  const max = Number(maxAgeDays);
  if (!Number.isInteger(max) || max <= 0) return () => true;
  const cutoff = now - max * 24 * 60 * 60 * 1000;
  return (postedAt) => {
    if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return true;
    return postedAt >= cutoff;
  };
}

export function parseSinceDays(args) {
  const occurrences = args.filter((a) => a === '--since' || a.startsWith('--since='));
  if (occurrences.length > 1) {
    return { days: null, error: `--since given ${occurrences.length} times; pass it once` };
  }
  if (occurrences.length === 0) return { days: null, error: null };
  const occ = occurrences[0];
  const next = args[args.indexOf('--since') + 1];
  const raw = occ.startsWith('--since=')
    ? occ.slice('--since='.length)
    : (next != null && !next.startsWith('--') ? next : null);
  const n = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { days: null, error: `--since expects a positive number of days, got ${raw == null || raw === '' ? '(no value)' : `"${raw}"`}` };
  }
  if (Number.isNaN(new Date(Date.now() - n * 86_400_000).getTime())) {
    return { days: null, error: `--since ${raw} is too large to express as a date` };
  }
  return { days: n, error: null };
}

export function resolveEffectiveAfter(postedAfter, sinceDays, now = Date.now()) {
  const cutoff = Number.isFinite(sinceDays) && sinceDays > 0 ? new Date(now - sinceDays * 86_400_000) : null;
  const sinceIso = cutoff && !Number.isNaN(cutoff.getTime())
    ? cutoff.toISOString().slice(0, 10)
    : null;
  return [postedAfter, sinceIso].filter(Boolean).reduce((a, b) => (a > b ? a : b), null);
}

export function resolveEarlyStopMs(effectiveAfter, maxAgeDays, now = Date.now()) {
  if (!effectiveAfter) return null;
  const max = Number(maxAgeDays);
  const ageFloor = Number.isInteger(max) && max > 0 ? now - max * 86_400_000 : -Infinity;
  return Math.max(Date.parse(`${effectiveAfter}T00:00:00Z`), ageFloor);
}

export function buildPostedDateFilter(afterIso, beforeIso) {
  const afterMs = afterIso ? Date.parse(afterIso) : NaN;
  const beforeMs = beforeIso ? Date.parse(`${beforeIso}T23:59:59.999Z`) : NaN;
  const hasAfter = Number.isFinite(afterMs);
  const hasBefore = Number.isFinite(beforeMs);
  if (!hasAfter && !hasBefore) return () => true;
  return (postedAt) => {
    if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return true;
    if (hasAfter && postedAt < afterMs) return false;
    if (hasBefore && postedAt > beforeMs) return false;
    return true;
  };
}

function compileContentKeywordList(value) {
  return normalizeKeywordList(value).map(compileContentKeyword);
}

export function buildContentFilter(contentFilter) {
  if (!contentFilter) return () => true;
  const positive = compileContentKeywordList(contentFilter.positive);
  const negative = compileContentKeywordList(contentFilter.negative);

  const byTitleKeyword = new Map();
  if (contentFilter.by_title_keyword && typeof contentFilter.by_title_keyword === 'object' && !Array.isArray(contentFilter.by_title_keyword)) {
    for (const [kw, rule] of Object.entries(contentFilter.by_title_keyword)) {
      if (typeof kw !== 'string' || !kw.trim()) continue;
      byTitleKeyword.set(kw.trim().toLowerCase(), {
        positive: compileContentKeywordList(rule?.positive),
        negative: compileContentKeywordList(rule?.negative),
      });
    }
  }

  return (description, matchedKeywords = []) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();

    const overrides = matchedKeywords
      .filter(k => typeof k === 'string')
      .map(k => byTitleKeyword.get(k.trim().toLowerCase()))
      .filter(Boolean);

    if (overrides.length > 0) {
      return overrides.some(rule => {
        if (rule.negative.length > 0 && rule.negative.some(m => m(lower))) return false;
        if (rule.positive.length === 0) return true;
        return rule.positive.some(m => m(lower));
      });
    }

    if (negative.length > 0 && negative.some(m => m(lower))) return false;
    if (positive.length === 0) return true;
    return positive.some(m => m(lower));
  };
}

export function buildCountryEligibilityFilter(countryEligibilityFilter, candidateCountry) {
  if (!countryEligibilityFilter) return () => true;

  const candidateCountryLower = typeof candidateCountry === 'string'
    ? candidateCountry.toLowerCase().trim()
    : '';

  if (candidateCountryLower === 'united states') return () => true;

  const exclusionary = normalizeKeywordList(countryEligibilityFilter.exclusionary);
  const inclusive = normalizeKeywordList(countryEligibilityFilter.inclusive);

  return (description) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();

    if (exclusionary.length === 0) return true;
    if (!exclusionary.some(k => lower.includes(k))) return true;
    if (inclusive.length > 0 && inclusive.some(k => lower.includes(k))) return true;
    if (candidateCountryLower && lower.includes(candidateCountryLower)) return true;

    return false;
  };
}

export const DEFAULT_VISA_POSITIVE = [
  'visa sponsorship',
  'sponsor a visa',
  'sponsor visas',
  'will sponsor',
  'sponsorship available',
  'sponsorship is available',
  'eligible for sponsorship',
  'provide sponsorship',
  'offer sponsorship',
  'immigration support',
  'h-1b',
  'h1b',
  'h-1b1',
  'h1b1',
  'o-1 visa',
  'employment pass',
  's pass sponsorship',
  's pass application',
  's pass holder',
  'one pass scheme',
  'one pass application',
  'one pass holder',
  'work pass sponsorship',
  'work pass application',
  'eu blue card',
  'blue card',
  'skilled worker visa',
  'skilled worker sponsorship',
];

export const DEFAULT_VISA_NEGATIVE = [
  'no visa sponsorship',
  'no sponsorship',
  'without sponsorship',
  'unable to sponsor',
  'not able to sponsor',
  'cannot sponsor',
  'do not sponsor',
  'does not sponsor',
  'not offer sponsorship',
  'not provide sponsorship',
  'sponsorship is not available',
  'sponsorship not available',
  'not offer visa sponsorship',
  'citizens and permanent residents only',
  'permanent residents only',
];

export function buildVisaFilter(visaFilter) {
  if (!visaFilter || visaFilter.enabled === false) return () => true;
  const positive = visaFilter.positive != null
    ? normalizeKeywordList(visaFilter.positive)
    : DEFAULT_VISA_POSITIVE.slice();
  const negative = visaFilter.negative != null
    ? normalizeKeywordList(visaFilter.negative)
    : DEFAULT_VISA_NEGATIVE.slice();
  const requireMention = visaFilter.require_mention === true;

  return (description) => {
    const hasText = typeof description === 'string' && description.trim() !== '';
    if (!hasText) return !requireMention;
    const lower = description.toLowerCase();
    if (negative.length > 0 && negative.some(k => lower.includes(k))) return false;
    if (!requireMention) return true;
    if (positive.length === 0) return true;
    return positive.some(k => lower.includes(k));
  };
}

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter) return () => true;

  const min = Number(salaryFilter.min ?? 0);
  const max = Number(salaryFilter.max ?? 0);
  const filterCurrency = (salaryFilter.currency || '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    console.error('Warning: salary_filter.min/max must be non-negative numbers — salary filter disabled');
    return () => true;
  }
  if (max > 0 && min > max) {
    console.error('Warning: salary_filter.min cannot exceed salary_filter.max — salary filter disabled');
    return () => true;
  }

  if (min === 0 && max === 0) return () => true;

  return (salary) => {
    if (!salary) return true;

    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;

    if (jobMin == null && jobMax == null) return true;

    const jobCurrency = (salary.currency || '').trim().toUpperCase();
    if (filterCurrency && jobCurrency && filterCurrency !== jobCurrency) {
      return false;
    }

    if (min > 0 && jobMax != null && jobMax < min) {
      return false;
    }
    if (max > 0 && jobMin != null && jobMin > max) {
      return false;
    }

    return true;
  };
}

const CORPORATE_FORMS = [
  '株式会社', '合同会社', '有限会社',
  '合名会社', '合資会社', '一般社団法人',
  '股份有限公司',
  '有限责任公司', '有限責任公司',
  '有限公司',
  '주식회사', '유한회사',
];

function stripCorporateForm(key) {
  const forms = [];
  let rest = key;
  const prefix = CORPORATE_FORMS.find((form) => rest.startsWith(form));
  if (prefix) {
    forms.push(prefix);
    rest = rest.slice(prefix.length);
  }
  const suffix = CORPORATE_FORMS.find((form) => rest.endsWith(form));
  if (suffix) {
    forms.push(suffix);
    rest = rest.slice(0, -suffix.length);
  }
  return [forms.length ? forms.join('|') : null, rest];
}

function stripFormPair(rawA, rawB) {
  const [formsA, restA] = stripCorporateForm(rawA);
  const [formsB, restB] = stripCorporateForm(rawB);
  if (formsA && formsB && formsA !== formsB) return null;
  if (Boolean(formsA && !restA) !== Boolean(formsB && !restB)) return null;
  return [restA || rawA, restB || rawB];
}

export function companyMatch(jobCompany, windowCompany) {
  const noSpaces = stripFormPair(
    normalizeTextKey(jobCompany),
    normalizeTextKey(windowCompany),
  );
  if (!noSpaces) return false;
  const [c1NoSpaces, c2NoSpaces] = noSpaces;
  if (c1NoSpaces && c1NoSpaces === c2NoSpaces) return true;

  const withSpaces = stripFormPair(
    normalizeTextKey(jobCompany, ' '),
    normalizeTextKey(windowCompany, ' '),
  );
  if (!withSpaces) return false;
  const [c1WithSpaces, c2WithSpaces] = withSpaces;
  if (!c1WithSpaces || !c2WithSpaces) return false;

  const bounded = (name) => new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}])`,
    'u',
  );
  return bounded(c2WithSpaces).test(c1WithSpaces) || bounded(c1WithSpaces).test(c2WithSpaces);
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function loadCandidateCountry(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return '';
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const country = raw?.location?.country;
    return typeof country === 'string' ? country.trim() : '';
  } catch {
    return '';
  }
}

export function loadReApplyWindows(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return {};
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const windows = raw.re_apply_windows || {};
    const validWindows = {};
    for (const [company, win] of Object.entries(windows)) {
      if (!win || typeof win !== 'object') continue;
      const lastApplyDate = win.last_apply_date;
      if (typeof lastApplyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastApplyDate)) continue;
      if (isNaN(Date.parse(lastApplyDate))) continue;

      const sameRoleDays = win.same_role_days;
      if (sameRoleDays !== undefined && (!Number.isInteger(sameRoleDays) || sameRoleDays < 0)) continue;

      if (win.applied_to !== undefined && !Array.isArray(win.applied_to)) continue;
      if (win.applied_to !== undefined && win.applied_to.some(x => typeof x !== 'string')) continue;

      if (win.cross_role_bucket !== undefined && typeof win.cross_role_bucket !== 'string') continue;

      validWindows[company] = win;
    }
    return validWindows;
  } catch {
    return {};
  }
}

export function buildCooldownFilter(windows, today) {
  if (!windows || Object.keys(windows).length === 0) {
    return () => ({ skip: false });
  }

  const genericKeywords = new Set(['all', 'roles', 'role', 'family', 'bucket', 'group', 'team']);

  return (job) => {
    const jobCompany = job.company || '';
    const jobTitleLower = (job.title || '').toLowerCase();

    for (const [windowCompany, window] of Object.entries(windows)) {
      if (companyMatch(jobCompany, windowCompany)) {
        const lastApplyDate = window.last_apply_date;
        const sameRoleDays = Number(window.same_role_days || 0);
        if (!lastApplyDate) continue;

        const cooldownUntil = addDays(lastApplyDate, sameRoleDays);
        if (today >= cooldownUntil) {
          continue;
        }

        if (Array.isArray(window.applied_to)) {
          const matchesApplied = window.applied_to.some(role => {
            const roleLower = role.toLowerCase();
            return jobTitleLower.includes(roleLower);
          });
          if (matchesApplied) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }

        if (window.cross_role_bucket) {
          const bucketKeywords = window.cross_role_bucket
            .toLowerCase()
            .split('_')
            .filter(kw => kw && !genericKeywords.has(kw));

          const matchesBucket = bucketKeywords.some(kw => {
            if (kw === 'em') {
              return /\bem\b/i.test(jobTitleLower) || jobTitleLower.includes('engineering manager');
            }
            return jobTitleLower.includes(kw);
          });

          if (matchesBucket) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }
      }
    }

    return { skip: false };
  };
}


export function extractCareersUrlDomain(careersUrl) {
  if (!careersUrl) return null;
  try {
    return new URL(careersUrl).hostname;
  } catch {
    return null;
  }
}

function resolveSearchHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
  }
  return href;
}

export function pickRediscoveredUrl(hrefs, domain) {
  if (!domain || !Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const href = resolveSearchHref(raw);
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (host === domain) return href;
  }
  return null;
}

const REDISCOVER_TIMEOUT_MS = 10_000;

async function searchForNewUrl(page, offer) {
  const domain = offer.careersUrlDomain;
  if (!domain) return null;
  const query = `"${offer.title}" "${offer.company}" site:${domain}`;
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: REDISCOVER_TIMEOUT_MS },
    );
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a'))
        .map((a) => a.getAttribute('href'))
        .filter(Boolean),
    );
    return pickRediscoveredUrl(hrefs, domain);
  } catch {
    return null;
  } finally {
    try {
      await page.goto('about:blank');
    } catch {
    }
  }
}

const PERMANENT_SCAN_HISTORY_STATUSES = new Set([
  'skipped_invalid_url',
  'skipped_blocked_host',
]);

const RECHECKABLE_SCAN_HISTORY_STATUSES = new Set(['added', 'skipped_expired']);

const OBSERVATIONAL_SCAN_HISTORY_STATUSES = new Set([
  'skipped_location',
  'skipped_age',
]);

export function unrecordedOffers(offers, status, scanHistoryText = '') {
  const recorded = new Set();
  for (const line of scanHistoryText.split('\n').slice(1)) {
    const [url, , , , , rowStatus] = line.split('\t');
    if (url && rowStatus === status) recorded.add(normalizeUrlForDedup(url));
  }
  return offers.filter((offer) => {
    const key = normalizeUrlForDedup(offer.url);
    if (recorded.has(key)) return false;
    recorded.add(key);
    return true;
  });
}

function daysBetweenIsoDates(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) return null;
  return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
}

export function shouldDedupScanHistoryRow({ firstSeen, status = 'added' }, { recheckAfterDays = null, today = localToday() } = {}) {
  if (PERMANENT_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (status.startsWith('cooldown:')) {
    const parts = status.split(':');
    const cooldownUntil = parts[parts.length - 1];
    return today < cooldownUntil;
  }
  if (!RECHECKABLE_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (recheckAfterDays == null) return true;
  const ageDays = daysBetweenIsoDates(firstSeen, today);
  if (ageDays == null) return true;
  return ageDays < recheckAfterDays;
}

function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

export function resolveDedupIncludeLocation(config = {}) {
  return config.scan_history?.dedup_include_location === true;
}

export function resolveDedupIncludeLanguage(config = {}) {
  return config.scan_history?.dedup_include_language === true;
}

const DEDUP_STRIP_PARAMS = new Set([
  'language', 'lang', 'locale',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'src', 'source', 'gh_src', 'lever-origin', 'lever-source',
  'rltr',
]);

export function normalizeUrlForDedup(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const param of Array.from(parsed.searchParams.keys())) {
    if (DEDUP_STRIP_PARAMS.has(param.toLowerCase())) {
      parsed.searchParams.delete(param);
    }
  }
  promoteKnownFragmentIdentity(parsed);
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  return parsed.toString();
}

const PIPELINE_CHECKBOX_RE = /^\s*- \[[ x]\]\s+/;

const PIPELINE_CHECKBOX_STRICT_RE = /^- \[[ x]\]\s+/;

const PIPELINE_LABELED_SEGMENT_RE = /^(?:posted|trust|note|rank):\s/iu;

const PIPELINE_STRIKETHROUGH_RE = /^~~([\s\S]*?)~~/;

const PIPELINE_URL_RE = /https?:\/\/[^\s|]+/;

function pipelineEntry(line, checkboxRe) {
  const checkbox = line.match(checkboxRe);
  if (!checkbox) return null;

  const rest = line.slice(checkbox[0].length);
  if (!rest.startsWith('~~')) return { body: rest, expired: false };

  const closed = rest.match(PIPELINE_STRIKETHROUGH_RE);
  return { body: closed ? closed[1] : rest.slice(2), expired: true };
}

function extractPipelineUrl(line) {
  const entry = pipelineEntry(line, PIPELINE_CHECKBOX_RE);
  if (!entry) return null;

  const match = entry.body.match(PIPELINE_URL_RE);
  return match ? match[0] : null;
}

function extractPipelineCompanyRole(line) {
  const entry = pipelineEntry(line, PIPELINE_CHECKBOX_STRICT_RE);
  if (!entry || entry.expired) return null;

  const cells = entry.body.split('|').map(cell => cell.trim());
  if (cells[0].startsWith('#--')) return null;

  const urlIndex = cells.findIndex(cell => PIPELINE_URL_RE.test(cell));
  if (urlIndex === -1) return null;

  const [company = '', role = '', third = ''] = cells.slice(urlIndex + 1);
  const location = urlIndex === 0 && !PIPELINE_LABELED_SEGMENT_RE.test(third) ? third : '';
  return { company, role, location, url: cells[urlIndex] };
}

export function collectSeenUrls(sources = {}, policy = {}, { extraTokensFor } = {}) {
  const { scanHistoryText = '', pipelineText = '', applicationsText = '' } = sources;
  const seen = new Set();
  const recheckCandidates = new Set();

  const historyLines = scanHistoryText.split('\n');
  if (historyLines[0].startsWith('url\t')) historyLines.shift();
  for (const line of historyLines) {
    const { url, first_seen: firstSeen, portal, status: rawStatus } = parseScanHistoryLine(line);
    const status = rawStatus || 'added';
    if (!url) continue;
    if (OBSERVATIONAL_SCAN_HISTORY_STATUSES.has(status)) continue;
    if (shouldDedupScanHistoryRow({ firstSeen, status }, policy)) {
      seen.add(normalizeUrlForDedup(url));
      if (extraTokensFor) {
        for (const token of [].concat(extraTokensFor(url, portal) || [])) {
          if (token) seen.add(token);
        }
      }
    } else recheckCandidates.add(normalizeUrlForDedup(url));
  }

  const SECTION_LEVEL = 2;
  let inProcessed = false;
  for (const line of pipelineText.split('\n')) {
    const heading = line.match(/^(#+)\s+(.*)$/);
    if (heading && heading[1].length <= SECTION_LEVEL) {
      inProcessed = heading[1].length === SECTION_LEVEL
        && /^processed\b/i.test(heading[2].trim());
    }
    const url = extractPipelineUrl(line);
    if (!url) continue;
    const key = normalizeUrlForDedup(url);
    const done = /^\s*- \[x\]/i.test(line);
    if ((done || inProcessed) && recheckCandidates.has(key)) continue;
    seen.add(key);
  }

  for (const match of applicationsText.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(normalizeUrlForDedup(match[0]));
  }

  let recheckEligible = 0;
  for (const key of recheckCandidates) if (!seen.has(key)) recheckEligible++;

  return { seen, recheckEligible };
}

export function loadSeenUrls(policy = {}, {
  scanHistoryPath = SCAN_HISTORY_PATH,
  pipelinePath = PIPELINE_PATH,
  applicationsPath = APPLICATIONS_PATH,
  extraTokensFor,
} = {}) {
  return collectSeenUrls({
    scanHistoryText: readIfExists(scanHistoryPath),
    pipelineText: readIfExists(pipelinePath),
    applicationsText: readIfExists(applicationsPath),
  }, policy, { extraTokensFor });
}

function defaultCompanyNormalizer(name) {
  return String(name ?? '').trim().toLowerCase();
}

export function buildCompanyCanonicalizer(aliases) {
  const map = new Map();
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    const entries = Object.entries(aliases);
    const canonicalKeys = new Set();

    for (const [canonical] of entries) {
      const canon = defaultCompanyNormalizer(canonical);
      if (!canon) continue;
      map.set(canon, canon);
      canonicalKeys.add(canon);
    }

    const aliasTargets = new Map();
    for (const [canonical, list] of entries) {
      const canon = defaultCompanyNormalizer(canonical);
      if (!canon) continue;
      const arr = Array.isArray(list) ? list : [list];
      for (const a of arr) {
        const alias = defaultCompanyNormalizer(a);
        if (!alias || canonicalKeys.has(alias)) continue;
        if (!aliasTargets.has(alias)) aliasTargets.set(alias, new Set());
        aliasTargets.get(alias).add(canon);
      }
    }

    for (const [alias, targets] of aliasTargets) {
      if (targets.size === 1) map.set(alias, targets.values().next().value);
    }
  }

  return function canonicalizeCompany(name) {
    const key = defaultCompanyNormalizer(name);
    return map.get(key) ?? key;
  };
}

const ROLE_LOCATION_SUFFIXES = new Set([
  'amer',
  'americas',
  'amsterdam',
  'apac',
  'austin',
  'barcelona',
  'bay area',
  'belgium',
  'berlin',
  'boston',
  'brussels',
  'budapest',
  'canada',
  'chicago',
  'copenhagen',
  'dublin',
  'emea',
  'eu',
  'europe',
  'finland',
  'france',
  'frankfurt',
  'germany',
  'hamburg',
  'helsinki',
  'india',
  'ireland',
  'italy',
  'la',
  'latin america',
  'lisbon',
  'london',
  'los angeles',
  'madrid',
  'melbourne',
  'milan',
  'montreal',
  'munich',
  'netherlands',
  'new york',
  'north america',
  'nyc',
  'on site',
  'onsite',
  'oslo',
  'paris',
  'poland',
  'porto',
  'prague',
  'remote',
  'rome',
  'san francisco',
  'seattle',
  'sf',
  'singapore',
  'spain',
  'stockholm',
  'sydney',
  'tokyo',
  'toronto',
  'uk',
  'united kingdom',
  'united states',
  'us',
  'usa',
  'vancouver',
  'vienna',
  'warsaw',
  'zurich',
]);

const ROLE_REMOTE_SUFFIXES = new Set([
  'distributed',
  'hybrid',
  'on site',
  'onsite',
  'remote',
  'wfh',
  'work from home',
]);

function normalizeRoleSuffixTag(tag) {
  return String(tag ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isRoleLocationSuffix(tag) {
  const normalized = normalizeRoleSuffixTag(tag);
  if (!normalized) return false;
  if (ROLE_LOCATION_SUFFIXES.has(normalized)) return true;

  const raw = String(tag ?? '').toLowerCase();
  const parts = raw
    .split(/[,/|;]+|\s+(?:and|or)\s+/g)
    .map(normalizeRoleSuffixTag)
    .filter(Boolean);
  if (parts.length > 1 && parts.every(part => ROLE_LOCATION_SUFFIXES.has(part))) return true;

  for (const remote of ROLE_REMOTE_SUFFIXES) {
    const prefix = `${remote} `;
    if (normalized.startsWith(prefix) && ROLE_LOCATION_SUFFIXES.has(normalized.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

export function normalizeRoleForDedup(role) {
  let title = String(role ?? '').normalize('NFKC').toLowerCase();
  while (true) {
    const bracketed = title.match(/\s*[\[(]([^[\]()]+)[\])]\s*$/);
    if (bracketed && isRoleLocationSuffix(bracketed[1])) {
      title = title.slice(0, bracketed.index).trimEnd();
      continue;
    }
    const piped = title.match(/\s*\|\s*([^|]+?)\s*$/);
    if (piped && isRoleLocationSuffix(piped[1])) {
      title = title.slice(0, piped.index).trimEnd();
      continue;
    }
    break;
  }
  return normalizeTextKey(title, ' ');
}

const LOCATION_LIST_SEPARATOR_RE = /\s*(?:[;|\u00b7/]|\bor\b)\s*/iu;

export function normalizeLocationForDedup(location) {
  if (typeof location !== 'string') return '';
  const places = new Set();
  for (const segment of location.split(LOCATION_LIST_SEPARATOR_RE)) {
    const place = normalizeTextKey(segment, ' ');
    if (place) places.add(place);
  }
  return [...places].sort().join('+');
}

export function companyRoleDedupKey(company, role, canonicalize = defaultCompanyNormalizer, location = undefined) {
  const base = `${canonicalize(company)}::${normalizeRoleForDedup(role)}`;
  const places = normalizeLocationForDedup(location);
  return places ? `${base}@@${places}` : base;
}

export const ANY_REQUISITION = '*';

export function requisitionIdsForDedup({ url, text, requisitionId } = {}) {
  const suppliedId = typeof requisitionId === 'string' ? requisitionId.trim() : '';
  const workdayKey = !suppliedId && typeof url === 'string' ? workdayDedupKey({ url }) : null;
  if (suppliedId) return [normalizeScanScalar(suppliedId).toUpperCase()];
  let raws;
  if (workdayKey) {
    raws = [workdayKey.split(':').slice(2).join(':')];
  } else {
    const match = String(text ?? '').match(REQ_NUMBER_RE);
    const separatedPrefix = match?.[0].match(/^(JR|R_)[\s:#]+/i);
    const labelled = match && /^(?:JR[-_]?|R_)\d/i.test(match[0])
      ? match[0].toUpperCase()
      : separatedPrefix && /^\d/.test(match[1])
        ? `${separatedPrefix[1]}${match[1]}`.toUpperCase()
        : extractReqNumber(text);
    if (!labelled) return [];
    if (/^[\d-]+$/.test(labelled)) return [];
    const workdayUrl = isWorkdayJobUrl(url);
    raws = workdayUrl === true
      ? [stripWorkdayRepostSuffix(labelled)]
      : workdayUrl === false ? [labelled] : [labelled, stripWorkdayRepostSuffix(labelled)];
  }
  const forms = [];
  for (const raw of raws) {
    const id = String(raw ?? '').toUpperCase();
    if (/\d/.test(id) && !forms.includes(id)) forms.push(id);
  }
  return forms;
}

export function requisitionIdForDedup(source) {
  return requisitionIdsForDedup(source)[0] ?? null;
}

export function isDistinctRequisition(seededRequisitions, candidateRequisitions) {
  return unseenOnEveryRow(seededRequisitions, candidateRequisitions);
}

export function languageFormsForDedup(language) {
  if (typeof language !== 'string') return [];
  const value = language.trim();
  if (!value) return [];
  try {
    return [new Intl.Locale(value.replace(/_/g, '-')).language];
  } catch {
    return [value.toLowerCase()];
  }
}

export function isDistinctLanguage(seededLanguages, candidateLanguages, candidateRequisitions = []) {
  if (!(seededLanguages instanceof Map)) return false;
  const requisitions = toRequisitionForms(candidateRequisitions);
  const overlapping = [...seededLanguages]
    .filter(([requisition]) => requisitions.length === 0
      || requisition === ANY_REQUISITION
      || requisitions.includes(requisition))
    .map(([, languages]) => languages);
  return overlapping.length > 0
    && overlapping.every(languages => unseenOnEveryRow(languages, candidateLanguages));
}

function unseenOnEveryRow(seeded, candidate) {
  const forms = toRequisitionForms(candidate);
  return forms.length > 0
    && seeded instanceof Set
    && seeded.size > 0
    && !seeded.has(ANY_REQUISITION)
    && forms.every(form => !seeded.has(form));
}

function toRequisitionForms(requisitions) {
  if (Array.isArray(requisitions)) return requisitions.filter(Boolean);
  return requisitions ? [requisitions] : [];
}

export function matchesSeenCompanyRole({ key, baseKey, seen, requisitions, locatedRequisitions, languages = new Map(), locatedLanguages = new Map() }, candidate, candidateLanguages = []) {
  if (key === null) return false;
  const distinct = (requisitionSets, languageSets, k) =>
    isDistinctRequisition(requisitionSets.get(k), candidate)
    || isDistinctLanguage(languageSets.get(k), candidateLanguages, candidate);
  if (seen.has(key) && !distinct(requisitions, languages, key)) return true;
  if (key !== baseKey && seen.has(baseKey)
    && !distinct(requisitions, languages, baseKey)) return true;
  return key === baseKey && locatedRequisitions.has(baseKey)
    && !distinct(locatedRequisitions, locatedLanguages, baseKey);
}

function recordForms(formsByKey, key, forms) {
  let seen = formsByKey.get(key);
  if (!seen) formsByKey.set(key, (seen = new Set()));
  const list = toRequisitionForms(forms);
  if (list.length === 0) seen.add(ANY_REQUISITION);
  for (const form of list) seen.add(form);
}

function recordLanguages(languagesByKey, key, requisitions, languages) {
  let byRequisition = languagesByKey.get(key);
  if (!byRequisition) languagesByKey.set(key, (byRequisition = new Map()));
  const list = toRequisitionForms(requisitions);
  for (const requisition of list.length > 0 ? list : [ANY_REQUISITION]) {
    recordForms(byRequisition, requisition, languages);
  }
}

export function collectSeenCompanyRoles(sources = {}, policy = {}, canonicalize = defaultCompanyNormalizer, { includeLocation = false, locatedBases = null, requisitionsByBase = null, locatedRequisitionsByBase = null, languagesByBase = null, locatedLanguagesByBase = null } = {}) {
  const { applicationsText = '', scanHistoryText = '', pipelineText = '' } = sources;
  const seen = new Set();
  const postingAttributes = collectPostingAttributes(scanHistoryText);
  const attributesFor = (url) => (typeof url === 'string' && url
    ? postingAttributes.get(normalizeUrlForDedup(url.trim())) ?? {}
    : {});
  const add = (company, role, location, requisition = null, language = null) => {
    const c = String(company ?? '').trim();
    const r = String(role ?? '').trim();
    if (!c || !r) return;
    if (c.toLowerCase() === 'company') return;
    if (/^[-:]+$/.test(c) || /^[-:]+$/.test(r)) return;
    const key = companyRoleDedupKey(c, r, canonicalize, includeLocation ? location : undefined);
    seen.add(key);
    if (locatedBases && includeLocation) {
      const base = companyRoleDedupKey(c, r, canonicalize);
      if (key !== base) locatedBases.add(base);
    }
    if (requisitionsByBase) {
      recordForms(requisitionsByBase, key, requisition);
    }
    if (languagesByBase) {
      recordLanguages(languagesByBase, key, requisition, language);
    }
    const base = companyRoleDedupKey(c, r, canonicalize);
    if (locatedRequisitionsByBase && key !== base) {
      recordForms(locatedRequisitionsByBase, base, requisition);
    }
    if (locatedLanguagesByBase && key !== base) {
      recordLanguages(locatedLanguagesByBase, base, requisition, language);
    }
  };

  if (applicationsText) {
    const lines = applicationsText.split('\n');
    const colmap = resolveColumns(lines);
    for (const line of lines) {
      const row = parseTrackerRow(line, colmap);
      if (!row) continue;
      const attributes = attributesFor(row.url);
      add(row.company, row.role, row.location,
        requisitionIdsForDedup({ url: row.url, text: row.notes, requisitionId: attributes.requisitionId }),
        languageFormsForDedup(attributes.language));
    }
  }

  for (const line of scanHistoryText.split('\n').slice(1)) {
    const row = parseScanHistoryLine(line);
    const status = row.status || 'added';
    if (!row.url) continue;
    if (status !== 'added') continue;
    if (!shouldDedupScanHistoryRow({ firstSeen: row.first_seen, status }, policy)) continue;
    add(row.company, row.title, row.location,
      requisitionIdsForDedup({ url: row.url, requisitionId: row.requisition_id }),
      languageFormsForDedup(row.language));
  }

  for (const line of pipelineText.split('\n')) {
    const pair = extractPipelineCompanyRole(line);
    if (!pair) continue;
    const attributes = attributesFor(pair.url);
    add(pair.company, pair.role, pair.location,
      requisitionIdsForDedup({ url: pair.url, requisitionId: attributes.requisitionId }),
      languageFormsForDedup(attributes.language));
  }

  return seen;
}

export function collectPostingAttributes(scanHistoryText) {
  const attributes = new Map();
  for (const line of scanHistoryText.split('\n').slice(1)) {
    const row = parseScanHistoryLine(line);
    const requisitionId = row.requisition_id.trim();
    const language = row.language.trim();
    if (!row.url || (!requisitionId && !language)) continue;
    const key = normalizeUrlForDedup(row.url.trim());
    attributes.set(key, {
      ...attributes.get(key),
      ...(requisitionId ? { requisitionId } : {}),
      ...(language ? { language } : {}),
    });
  }
  return attributes;
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

export function loadSeenCompanyRoles(
  appsPath = APPLICATIONS_PATH,
  canonicalize = defaultCompanyNormalizer,
  { policy = {}, scanHistoryPath = SCAN_HISTORY_PATH, pipelinePath = PIPELINE_PATH, includeLocation = false, locatedBases = null } = {},
) {
  return collectSeenCompanyRoles({
    applicationsText: readIfExists(appsPath),
    scanHistoryText: readIfExists(scanHistoryPath),
    pipelineText: readIfExists(pipelinePath),
  }, policy, canonicalize, { includeLocation, locatedBases });
}

function normalizeScanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeScanUrl(value) {
  return String(value ?? '').trim().split(/\s+/)[0] || '';
}

const MARKDOWN_ESCAPE_CHARS = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
};

export function sanitizeMarkdownField(value) {
  return normalizeScanScalar(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '/');
}

function sanitizePipelineUrl(value) {
  return normalizeScanUrl(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '%7C');
}

export function sanitizeTsvField(value) {
  return escapeFormulaCell(normalizeScanScalar(value));
}

export function formatCompensation(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const num = (n) => (Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null);
  const lo = num(salary.min);
  const hi = num(salary.max);
  const range = lo && hi && lo !== hi ? `${lo}-${hi}` : (lo || hi || '');
  if (!range) return '';
  const currency = typeof salary.currency === 'string' ? salary.currency.trim() : '';
  return sanitizeMarkdownField(currency ? `${range} ${currency}` : range);
}

export function trustIsFlagged(offer) {
  return typeof offer.trustScore === 'number' && Number.isFinite(offer.trustScore) && offer.trustScore < 100;
}

function trustFlagList(offer) {
  return Array.isArray(offer.trustFlags)
    ? offer.trustFlags.filter((f) => typeof f === 'string' && f.trim())
    : [];
}

export function formatTrustSegment(offer) {
  if (!trustIsFlagged(offer)) return '';
  const flags = trustFlagList(offer);
  const body = flags.length ? `${offer.trustScore} ${flags.join(',')}` : String(offer.trustScore);
  return sanitizeMarkdownField(`trust: ${body}`);
}

export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  let line = base;
  if (compensation) line = `${base} | ${location} | ${compensation}`;
  else if (location) line = `${base} | ${location}`;
  const posted = postedAtIsoDate(offer.postedAt);
  if (posted) line = `${line} | posted: ${posted}`;
  const trust = formatTrustSegment(offer);
  if (trust) line = `${line} | ${trust}`;
  const note = typeof offer.note === 'string' ? sanitizeMarkdownField(offer.note) : '';
  return note ? `${line} | note: ${note}` : line;
}

function postedAtIsoDate(postedAt) {
  if (typeof postedAt !== 'number' || !Number.isFinite(postedAt) || postedAt <= 0) return '';
  return new Date(postedAt).toISOString().slice(0, 10);
}
export function formatScanHistoryRow(offer, date, status = 'added') {
  const record = {
    url: normalizeScanUrl(offer.url),
    first_seen: date,
    portal: offer.source,
    title: offer.title,
    company: offer.company,
    status,
    location: offer.location || '',
    fingerprint: offer.fingerprint ?? fingerprintText(offer.description),
    posted_at: postedAtIsoDate(offer.postedAt),
    trust_score: trustIsFlagged(offer) ? String(offer.trustScore) : '',
    trust_flags: trustIsFlagged(offer) ? trustFlagList(offer).join(',') : '',
    normalized_company: normalizeCompanyName(offer.company || ''),
    requisition_id: typeof offer.requisitionId === 'string' ? offer.requisitionId : '',
    language: typeof offer.language === 'string' ? offer.language : '',
  };
  return SCAN_HISTORY_COLUMNS.map((name) => sanitizeTsvField(record[name])).join('\t');
}

export function collectFingerprintHistory(scanHistoryText = '') {
  const rows = [];
  for (const line of scanHistoryText.split('\n')) {
    const row = parseScanHistoryLine(line);
    if (row.url === 'url') continue;
    if (!row.fingerprint.trim()) continue;
    rows.push({
      url: row.url.trim(),
      dateStr: row.first_seen.trim(),
      title: row.title.trim(),
      company: row.company.trim(),
      fingerprint: row.fingerprint.trim(),
    });
  }
  return rows;
}

export function loadFingerprintHistory(historyPath = SCAN_HISTORY_PATH) {
  return collectFingerprintHistory(readIfExists(historyPath));
}

export function loadDedupSnapshot(policy = {}, canonicalize = defaultCompanyNormalizer, {
  scanHistoryPath = SCAN_HISTORY_PATH,
  pipelinePath = PIPELINE_PATH,
  applicationsPath = APPLICATIONS_PATH,
  includeLocation = false,
} = {}) {
  const scanHistoryText = readIfExists(scanHistoryPath);
  const pipelineText = readIfExists(pipelinePath);
  const applicationsText = readIfExists(applicationsPath);
  const { seen, recheckEligible } = collectSeenUrls({ scanHistoryText, pipelineText, applicationsText }, policy);
  const seenCompanyRoleBases = new Set();
  const seenCompanyRoleRequisitions = new Map();
  const locatedRequisitionsByBase = new Map();
  const seenCompanyRoleLanguages = new Map();
  const locatedLanguagesByBase = new Map();
  const seenCompanyRoles = collectSeenCompanyRoles({ applicationsText, scanHistoryText, pipelineText }, policy, canonicalize, {
    includeLocation,
    locatedBases: seenCompanyRoleBases,
    requisitionsByBase: seenCompanyRoleRequisitions,
    locatedRequisitionsByBase,
    languagesByBase: seenCompanyRoleLanguages,
    locatedLanguagesByBase,
  });
  const fingerprintHistory = collectFingerprintHistory(scanHistoryText);
  return { seen, recheckEligible, seenCompanyRoles, seenCompanyRoleBases, seenCompanyRoleRequisitions, locatedRequisitionsByBase, seenCompanyRoleLanguages, locatedLanguagesByBase, fingerprintHistory };
}

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

const PENDING_MARKERS = ['## Pending', '## Pendientes'];
const PROCESSED_MARKERS = ['## Processed', '## Procesadas'];

export async function appendToPipeline(offers, { pipelinePath = PIPELINE_PATH } = {}) {
  if (offers.length === 0) return;

  await withPipelineLock(pipelinePath, async () => {
    let text = existsSync(pipelinePath)
      ? readFileSync(pipelinePath, 'utf-8')
      : PIPELINE_SKELETON;

    const marker = PENDING_MARKERS.find(m => text.includes(m)) ?? null;
    const idx = marker !== null ? text.indexOf(marker) : -1;

    if (idx === -1) {
      const procIdx = PROCESSED_MARKERS.reduce((found, m) => {
        const i = text.indexOf(m);
        return (found === -1 || (i !== -1 && i < found)) ? i : found;
      }, -1);
      const insertAt = procIdx === -1 ? text.length : procIdx;
      const block = `\n## Pending\n\n` + offers.map(formatPipelineOffer).join('\n') + '\n\n';
      text = text.slice(0, insertAt) + block + text.slice(insertAt);
    } else {
      const afterMarker = idx + marker.length;
      const nextSection = text.indexOf('\n## ', afterMarker);
      const insertAt = nextSection === -1 ? text.length : nextSection;

      const block = '\n' + offers.map(formatPipelineOffer).join('\n') + '\n';
      text = text.slice(0, insertAt) + block + text.slice(insertAt);
    }

    atomicWriteFile(pipelinePath, text);
  });
}

export async function appendToScanHistory(offers, date, status = 'added', { alreadyLocked = false } = {}) {
  const write = () => {
    if (!existsSync(SCAN_HISTORY_PATH)) {
      mkdirSync(path.dirname(SCAN_HISTORY_PATH), { recursive: true });
      atomicWriteFile(SCAN_HISTORY_PATH, `${SCAN_HISTORY_COLUMNS.join('\t')}\n`);
    }

    const lines = offers.map(o => formatScanHistoryRow(o, date, status)).join('\n') + '\n';

    appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
  };

  if (alreadyLocked) write();
  else await withPipelineLock(SCAN_HISTORY_PATH, write);
}

const BLACKLIST_PATH = path.join(DATA_ROOT, 'data/blacklist.md');

function normalizeBlacklistDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue;
    if (company.toLowerCase() === 'company') continue;
    const scope = (cells[3] || 'company').toLowerCase();
    const value = scope === 'domain' ? normalizeBlacklistDomain(company) : normalizeCompany(company);
    const key = scope === 'domain' ? `domain:${value}` : value;
    if (!value || entries.has(key)) continue;
    entries.set(key, {
      company,
      since: cells[2] || '',
      scope: scope === 'domain' ? 'domain' : 'company',
      reason: cells[4] || '',
    });
  }
  return entries;
}

export function findBlacklistEntry(blacklist, company, url) {
  if (!blacklist || blacklist.size === 0) return null;

  const companyEntry = blacklist.get(normalizeCompany(company || ''));
  if (companyEntry && companyEntry.scope !== 'domain') return companyEntry;

  let hostname;
  try {
    hostname = normalizeBlacklistDomain(new URL(url).hostname);
  } catch {
    return null;
  }

  for (const entry of blacklist.values()) {
    if (entry.scope !== 'domain') continue;
    const suffix = normalizeBlacklistDomain(entry.company);
    if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) return entry;
  }
  return null;
}

export function loadBlacklist(filePath = BLACKLIST_PATH) {
  if (!existsSync(filePath)) return new Map();
  return parseBlacklist(readFileSync(filePath, 'utf-8'));
}

export function parseAggregatorDomains(text) {
  const entries = new Map();
  for (let line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const hashIdx = line.indexOf('#');
    let domain = line;
    let reason = '';
    if (hashIdx !== -1) {
      domain = line.slice(0, hashIdx);
      reason = line.slice(hashIdx + 1);
    }
    domain = domain.trim().toLowerCase();
    reason = reason.trim();
    if (!domain) continue;
    entries.set(domain, { domain, reason });
  }
  return entries;
}

export const AGGREGATOR_DOMAINS_PATH = process.env.CAREER_OPS_AGGREGATOR_DOMAINS || path.join(CODE_ROOT, 'data-static/aggregator-domains.txt');

export function loadAggregatorDomains(filePath = AGGREGATOR_DOMAINS_PATH) {
  if (!existsSync(filePath)) return new Map();
  return parseAggregatorDomains(readFileSync(filePath, 'utf-8'));
}

export function checkAggregatorRepost(offer, domainsMap = loadAggregatorDomains()) {
  if (!offer || !offer.url || !domainsMap || domainsMap.size === 0) return null;
  let hostname;
  try {
    hostname = new URL(offer.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  if (!hostname) return null;
  for (const [domain, entry] of domainsMap) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return entry;
    }
  }
  return null;
}

const SCAN_RUNS_PATH = path.join(DATA_ROOT, 'data/scan-runs.tsv');

export const SCAN_RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_posting_age\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\tfiltered_blacklist\tfiltered_visa\tfiltered_posted_date\tfiltered_country_eligibility\n';

let runFailureSnapshot = null;

export function registerRunFailureSnapshot(fn) {
  runFailureSnapshot = typeof fn === 'function' ? fn : null;
}

export function writeRunFailureRow(status = 'failed', filePath = SCAN_RUNS_PATH) {
  const snapshot = runFailureSnapshot;
  runFailureSnapshot = null;
  if (!snapshot) return false;
  try {
    appendScanRunSummary({ ...snapshot(), status }, filePath);
    return true;
  } catch {
    return false;
  }
}

export function appendScanRunSummary(c, filePath = SCAN_RUNS_PATH) {

  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) writeFileSync(filePath, SCAN_RUNS_HEADER, 'utf-8');
  if (!existsSync(filePath)) {
    atomicWriteFile(filePath, SCAN_RUNS_HEADER);
  } else {
    const onDisk = (readFileSync(filePath, 'utf-8').split('\n', 1)[0] || '') + '\n';
    if (onDisk !== SCAN_RUNS_HEADER) {
      console.error(
        `Warning: ${filePath} header has ${onDisk.trim().split('\t').length} columns but this build writes `
        + `${SCAN_RUNS_HEADER.trim().split('\t').length}. Rows below the header are positionally offset and `
        + `stats.mjs will exclude them. Move ${filePath} aside to start a fresh file — deleting only the header does NOT recover it, because the file still exists and the next run would read the first data row as the header.`,
      );
    }
  }
  const row = [
    c.timestamp, c.status ?? 'completed', c.companies, c.boards, c.found,
    c.filteredTitle, c.filteredTier, c.filteredLocation, c.filteredPostingAge,
    c.filteredSalary, c.filteredContent, c.filteredCooldown, c.dupes, c.newAdded, c.errors,
    c.filteredBlacklist ?? 0,
    c.filteredVisa ?? 0,
    c.filteredPostedDate ?? 0,
    c.filteredCountryEligibility ?? 0,
  ].join('\t') + '\n';
  appendFileSync(filePath, row, 'utf-8');
}

const PORTAL_HEALTH_PATH = path.join(DATA_ROOT, 'data/portal-health.tsv');
export const PORTAL_HEALTH_HEADER = 'timestamp\tcompany\tstatus\n';

export async function appendPortalHealth(healthRecords, filePath = PORTAL_HEALTH_PATH) {
  await withPortalHealthLock(filePath, async () => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) atomicWriteFile(filePath, PORTAL_HEALTH_HEADER);
    let lines = '';
    for (const r of healthRecords) {
      lines += [r.timestamp, r.company, r.status].join('\t') + '\n';
    }
    if (lines) appendFileSync(filePath, lines, 'utf-8');
  });
}

export function loadPortalHealth(filePath = PORTAL_HEALTH_PATH) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      records.push({ timestamp: parts[0], company: parts[1], status: parts[2] });
    }
  }
  return records;
}

export function computeConsecutiveFailures(healthRecords) {
  const streaks = new Map();
  for (const r of healthRecords) {
    if (r.status === 'reachable' || r.status === 'empty') {
      streaks.set(r.company, 0);
    } else {
      streaks.set(r.company, (streaks.get(r.company) || 0) + 1);
    }
  }
  return streaks;
}

export function emptyTargetStatus(observation) {
  return observation.requests > 0 && observation.successfulResponses === 0
    ? 'unverified_zero' : 'empty';
}

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export async function verifyOffers(offers, { headedFallback = false, throttleBaseMs = 0, rediscover = false } = {}, {
  checkApi = checkLivenessViaApi,
  loadPlaywright = () => import('playwright'),
} = {}) {
  const {
    rejectPrivateOrInvalid, checkUrlLiveness, checkUrlLivenessWithFallback,
    createHeadedPageProvider, newLivenessPage, installLivenessRouteGuard, jitteredDelayMs, sleep,
  } = await import('./liveness-browser.mjs');

  const verdicts = new Array(offers.length);
  await parallelFetch(offers.map((offer, i) => async () => {
    const guard = rejectPrivateOrInvalid(offer.url);
    if (guard) {
      verdicts[i] = { result: 'uncertain', ...guard };
      return;
    }
    try {
      verdicts[i] = await checkApi(offer.url);
    } catch (err) {
      console.warn(`  ⚠️ API verification failed for ${offer.url}; falling back to Playwright: ${err.message}`);
      verdicts[i] = null;
    }
  }), CONCURRENCY);

  let browser = null, page = null, headed = null;
  let hadBrowserOffer = false;
  async function browserForOffer() {
    if (!browser) {
      let chromium;
      try {
        ({ chromium } = await loadPlaywright());
      } catch (err) {
        throw new Error(
          `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
          { cause: err },
        );
      }
      try {
        browser = await chromium.launch({ headless: true });
      } catch (err) {
        throw new Error(
          `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
          { cause: err },
        );
      }
      page = await newLivenessPage(browser);
      await installLivenessRouteGuard(page);
      headed = headedFallback ? createHeadedPageProvider(chromium) : null;
    }
    const wait = hadBrowserOffer ? jitteredDelayMs(throttleBaseMs) : 0;
    if (wait) await sleep(wait);
    hadBrowserOffer = true;
    return page;
  }
  const checkPage = (page, url) => headed
    ? checkUrlLivenessWithFallback(page, url, { getHeadedPage: () => headed.get() })
    : checkUrlLiveness(page, url);

  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];
  const migrated = [];

  try {
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      let offerPage = null;
      let verdict = verdicts[i];
      if (!verdict) {
        offerPage = await browserForOffer();
        verdict = await checkPage(offerPage, offer.url);
      }
      const { result, code, reason } = verdict;
      if (result === 'expired') {
        const httpGone = code === 'http_gone' || /^[a-z][a-z0-9-]*_api_gone$/.test(code);
        if (rediscover && httpGone && offer.tracked && offer.careersUrlDomain) {
          offerPage ??= await browserForOffer();
          const newUrl = await searchForNewUrl(offerPage, offer);
          if (newUrl) {
            const recheck = await checkPage(offerPage, newUrl);
            if (recheck.result === 'active') {
              migrated.push({ ...offer, url: newUrl, previousUrl: offer.url });
              console.log(`  🔄 migrated  ${offer.company} | ${offer.title} → ${newUrl}`);
              continue;
            }
          }
        }
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }
    }
  } finally {
    try {
      if (headed) await headed.close();
    } finally {
      if (browser) await browser.close();
    }
  }

  return { verified, expired, dropped, invalid, migrated };
}

const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  return 'skipped_invalid_url';
}

const KNOWN_FLAGS = [
  '--dry-run', '--verify', '--headed-fallback', '--throttle', '--rediscover-404',
  '--include-blacklisted', '--company', '--posted-after', '--posted-before',
  '--since', '--quiet', '--json', '--help', '-h',
];

const VALUE_FLAGS = ['--company', '--posted-after', '--posted-before', '--since'];

const USAGE = `Usage:
  node scan.mjs                              # scan all enabled companies
  node scan.mjs --dry-run                    # preview without writing files
  node scan.mjs --company Cohere             # scan a single company
  node scan.mjs --verify                     # API-first liveness check; use Playwright when inconclusive
  node scan.mjs --verify --headed-fallback   # retry anti-bot-blocked URLs in a headed browser (needs a display)
  node scan.mjs --verify --throttle          # jittered ~5-10s gap between browser checks
  node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
  node scan.mjs --rediscover-404             # re-verify tracked URLs that 404/410 (rides on --verify)
  node scan.mjs --include-blacklisted        # let data/blacklist.md matches through (annotated)
  node scan.mjs --since 7                    # postings from the last 7 days
  node scan.mjs --posted-after 2026-07-01    # absolute lower bound on posting date
  node scan.mjs --posted-before 2026-08-01   # absolute upper bound on posting date
  node scan.mjs --json                       # emit one machine-readable receipt on stdout
  node scan.mjs --quiet                      # suppress the manifesto footer
  node scan.mjs --help                       # print this usage block and exit`;

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');
  if (jsonMode) console.log = console.error.bind(console);
  const verify = args.includes('--verify');
  const headedFallback = args.includes('--headed-fallback');
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  const rediscover = args.includes('--rediscover-404');
  const includeBlacklisted = args.includes('--include-blacklisted');
  const requireValue = (flag) => {
    const value = flagValue(args, flag);
    if (value === undefined || value === '') {
      if (hasFlag(args, flag)) {
        console.error(`Error: ${flag} requires a value`);
        process.exit(1);
      }
      return null;
    }
    return value;
  };
  const filterCompany = requireValue('--company')?.toLowerCase() ?? null;
  const isValidIsoDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  const postedAfter = requireValue('--posted-after');
  const postedBefore = requireValue('--posted-before');
  if (postedAfter != null && !isValidIsoDate(postedAfter)) {
    console.error(`Error: --posted-after expects YYYY-MM-DD, got "${postedAfter}"`);
    process.exit(1);
  }
  if (postedBefore != null && !isValidIsoDate(postedBefore)) {
    console.error(`Error: --posted-before expects YYYY-MM-DD, got "${postedBefore}"`);
    process.exit(1);
  }

  const since = parseSinceDays(args);
  if (since.error) {
    console.error(`Error: ${since.error}`);
    process.exit(1);
  }
  const sinceDays = since.days;

  const effectiveAfter = resolveEffectiveAfter(postedAfter, sinceDays);

  const providers = await loadProviders(PROVIDERS_DIR);
  await mergeProviderPlugins(providers, { root: path.dirname(PROVIDERS_DIR), dataRoot: DATA_ROOT });
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  let rawConfig;
  try {
    rawConfig = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ${PORTALS_PATH}: ${err.message}`);
    process.exit(1);
  }
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const boards = Array.isArray(config.job_boards) ? config.job_boards : [];
  const titleFilter = buildTitleFilter(config.title_filter);

  let classifyTier = null;
  const skipTiers = Array.isArray(config.skip_tiers)
    ? config.skip_tiers.filter(t => typeof t === 'string').map(t => t.toLowerCase())
    : [];
  if (skipTiers.length > 0) {
    const mod = await import('./classify-tier.mjs');
    classifyTier = mod.classifyTier || mod.default;
  }

  const locationFilter = buildLocationFilter(config.location_filter);
  const postingAgeFilter = buildPostingAgeFilter(config.max_posting_age_days);
  const postedDateFilter = buildPostedDateFilter(effectiveAfter, postedBefore);

  const earlyStopSinceMs = resolveEarlyStopMs(effectiveAfter, config.max_posting_age_days);
  const salaryFilter = buildSalaryFilter(config.salary_filter);
  const trustValidator = buildTrustValidator(config.trust_filter);
  const contentFilter = buildContentFilter(config.content_filter);
  const candidateCountry = loadCandidateCountry();
  const countryEligibilityFilter = buildCountryEligibilityFilter(config.country_eligibility_filter, candidateCountry);
  const visaFilter = buildVisaFilter(config.visa_filter);
  const visaEnabled = Boolean(config.visa_filter) && config.visa_filter.enabled !== false;

  const targets = [];
  let skippedCount = 0;
  let boardCount = 0;
  const resolveErrors = [];
  const agentHandoff = [];

  function resolveEntries(entries, { isBoard = false } = {}) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(entry)}`);
        continue;
      }
      if (filterCompany && !entry.name.toLowerCase().includes(filterCompany)) continue;

      const resolved = resolveProvider(entry, providers);
      if (!resolved) {
        skippedCount++;
        if (entry.scan_method === 'websearch') {
          agentHandoff.push({
            company: entry.name,
            method: 'websearch',
            query: entry.scan_query || entry.search_query || entry.careers_url || '',
          });
        }
        continue;
      }

      if (resolved.error) {
        resolveErrors.push({ company: entry.name, error: resolved.error });
        continue;
      }

      targets.push({ ...entry, _provider: resolved.provider, _isBoard: isBoard, _targetId: targets.length });
      if (isBoard) boardCount++;
    }
  }

  resolveEntries(companies);
  resolveEntries(boards, { isBoard: true });

  const exitOnConfigError = (message) => {
    console.error(`Error: ${message}`);
    process.exit(1);
  };
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const FIELD_FILTER_KEYS = ['positive', 'negative'];
  if (config.field_filters !== undefined && !isPlainObject(config.field_filters)) {
    exitOnConfigError('field_filters must be an object keyed by field name');
  }
  for (const [name, block] of Object.entries(config.field_filters ?? {})) {
    if (name === 'title') {
      exitOnConfigError('field_filters.title is never read - filter_on "title" uses the top-level title_filter. Move these keywords there.');
    }
    if (!isPlainObject(block)) {
      exitOnConfigError(`field_filters.${name} must be an object with positive and/or negative lists`);
    }
    for (const key of Object.keys(block)) {
      if (!FIELD_FILTER_KEYS.includes(key)) {
        exitOnConfigError(`field_filters.${name}.${key} is not a recognized key - expected one of ${FIELD_FILTER_KEYS.join(', ')}`);
      }
    }
    let keywordCount = 0;
    for (const key of FIELD_FILTER_KEYS) {
      const list = block[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) {
        exitOnConfigError(`field_filters.${name}.${key} must be a list of strings - a bare string is ignored`);
      }
      if (list.some(k => typeof k !== 'string' || k.trim() === '')) {
        exitOnConfigError(`field_filters.${name}.${key} entries must be non-empty strings`);
      }
      keywordCount += list.length;
    }
    if (keywordCount === 0) {
      exitOnConfigError(`field_filters.${name} has no usable keyword in positive or negative - it would match every posting`);
    }
  }
  const fieldFilters = new Map(
    Object.entries(config.field_filters ?? {}).map(([name, block]) => [name, buildTitleFilter(block)]),
  );
  for (const target of targets) {
    if (target.filter_on !== undefined) {
      const declared = Array.isArray(target.filter_on) ? target.filter_on : [target.filter_on];
      if (declared.length === 0) {
        exitOnConfigError(`${target.name}: filter_on must not be an empty list - omit the key to gate on title`);
      }
      if (declared.some(f => typeof f !== 'string' || f.trim() === '')) {
        exitOnConfigError(`${target.name}: filter_on must be a non-empty string or a list of them`);
      }
    }
    for (const field of normalizeFilterOn(target.filter_on)) {
      if (field !== 'title' && !fieldFilters.has(field)) {
        exitOnConfigError(`${target.name}: filter_on "${field}" has no field_filters.${field} block in portals.yml`);
      }
    }
  }

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  const companyCount = targets.length - boardCount;
  const parts = [`${companyCount} companies`];
  if (boardCount > 0) parts.push(`${boardCount} job boards`);
  parts.push(`${localParserCount} local parser`);
  parts.push(`${skippedCount} skipped — no provider matched`);
  console.log(`Scanning ${parts.join('; ')} via providers`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const blacklist = loadBlacklist();

  const historyPolicy = scanHistoryPolicy(config);
  const canonicalizeCompany = buildCompanyCanonicalizer(config.company_aliases);
  const dedupIncludeLocation = resolveDedupIncludeLocation(config);
  const dedupIncludeLanguage = resolveDedupIncludeLanguage(config);
  const dedupSnapshot = loadDedupSnapshot(historyPolicy, canonicalizeCompany, { includeLocation: dedupIncludeLocation });
  const seenUrls = dedupSnapshot.seen;
  const seenCompanyRoles = dedupSnapshot.seenCompanyRoles;
  const seenCompanyRoleRequisitions = dedupSnapshot.seenCompanyRoleRequisitions ?? new Map();
  const locatedRequisitionsByBase = dedupSnapshot.locatedRequisitionsByBase ?? new Map();
  const seenCompanyRoleLanguages = dedupSnapshot.seenCompanyRoleLanguages ?? new Map();
  const locatedLanguagesByBase = dedupSnapshot.locatedLanguagesByBase ?? new Map();

  const date = localToday();
  const windows = loadReApplyWindows();
  const cooldownFilter = buildCooldownFilter(windows, date);
  let totalFilteredCooldown = 0;
  const cooldownOffers = [];
  const locationFilteredOffers = [];
  const ageFilteredOffers = [];
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredTier = 0;
  let totalFilteredDeclaredField = 0;
  let totalPassedFieldAbsent = 0;
  const declaredFieldSeen = new Map();
  const declaredFieldAbsent = new Map();
  let totalFilteredLocation = 0;
  let totalFilteredPostingAge = 0;
  let totalFilteredPostedDate = 0;
  let totalFilteredSalary = 0;
  let totalFilteredContent = 0;
  let totalFilteredCountryEligibility = 0;
  let totalFilteredBlacklist = 0;
  let annotatedBlacklisted = 0;
  let totalFilteredVisa = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [...resolveErrors];
  const emptyTargets = [];
  const unverifiedZeroTargets = [];

  if (!dryRun) {
    registerRunFailureSnapshot(() => ({
      timestamp: new Date().toISOString(),
      companies: targets.filter(t => !t._isBoard).length,
      boards: targets.filter(t => t._isBoard).length,
      found: totalFound, filteredTitle: totalFilteredTitle, filteredTier: totalFilteredTier,
      filteredLocation: totalFilteredLocation, filteredPostingAge: totalFilteredPostingAge,
      filteredSalary: totalFilteredSalary, filteredContent: totalFilteredContent,
      filteredCooldown: totalFilteredCooldown, dupes: totalDupes, newAdded: 0,
      errors: errors.length, filteredBlacklist: totalFilteredBlacklist,
      filteredVisa: totalFilteredVisa, filteredPostedDate: totalFilteredPostedDate,
      filteredCountryEligibility: totalFilteredCountryEligibility,
    }));
    process.once('SIGINT', () => {
      writeRunFailureRow('failed');
      process.exit(130);
    });
  }

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    const observation = { requests: 0, successfulResponses: 0, lastStatus: null };
    const ctx = {
      ...makeHttpCtx({
        onRequest: () => { observation.requests++; },
        onResponse: status => {
          observation.lastStatus = status;
          if (status >= 200 && status < 300) observation.successfulResponses++;
        },
      }),
      sinceMs: earlyStopSinceMs,
      includeUndated: true,
      locationHints: config.location_filter,
    };
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(company, ctx);
        errors.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      totalFound += jobs.length;
      if (!company._isBoard && jobs.length === 0) {
        if (emptyTargetStatus(observation) === 'empty') emptyTargets.push(company.name);
        else unverifiedZeroTargets.push(company.name);
      }

      const declaredFields = normalizeFilterOn(company.filter_on);
      for (const job of jobs) {
        for (const field of declaredFields) {
          if (field === 'title') continue;
          const key = declaredFieldKey(company._targetId, field);
          declaredFieldSeen.set(key, (declaredFieldSeen.get(key) || 0) + 1);
          if (isFieldAbsent(declaredFieldValue(job, field))) {
            declaredFieldAbsent.set(key, (declaredFieldAbsent.get(key) || 0) + 1);
          }
        }

        const trustResult = trustValidator(job);
        job.trustScore = trustResult.score;
        job.trustFlags = trustResult.flags;
        job.trustLevel = trustResult.level;

        if (blacklist.size > 0) {
          const blEntry = findBlacklistEntry(blacklist, job.company || company.name || '', job.url);
          if (blEntry) {
            if (!includeBlacklisted) {
              totalFilteredBlacklist++;
              continue;
            }
            annotatedBlacklisted++;
            job.blacklisted = true;
            const label = `blacklisted${blEntry.reason ? `: ${blEntry.reason}` : ''}`;
            job.note = typeof job.note === 'string' && job.note.trim()
              ? `${label} — ${job.note}`
              : label;
          }
        }

        let failedField = null;
        let sawAbsentField = false;
        for (const field of declaredFields) {
          if (field === 'title') {
            if (!titleFilter(job.title)) { failedField = field; break; }
          } else {
            const value = declaredFieldValue(job, field);
            if (isFieldAbsent(value)) sawAbsentField = true;
            else if (!fieldFilters.get(field)(String(value))) { failedField = field; break; }
          }
        }
        if (failedField === 'title') {
          totalFilteredTitle++;
          continue;
        }
        if (failedField !== null) {
          totalFilteredDeclaredField++;
          continue;
        }
        if (sawAbsentField) totalPassedFieldAbsent++;
        if (classifyTier && skipTiers.includes(classifyTier(job.title))) {
          totalFilteredTier++;
          continue;
        }
        if (!locationFilter(job.location, job.url, job.title)) {
          totalFilteredLocation++;
          if (!dryRun) locationFilteredOffers.push({ ...job, source: sourceName });
          continue;
        }
        if (!postingAgeFilter(job.postedAt)) {
          totalFilteredPostingAge++;
          if (!dryRun) ageFilteredOffers.push({ ...job, source: sourceName });
          continue;
        }
        if (!postedDateFilter(job.postedAt)) {
          totalFilteredPostedDate++;
          continue;
        }
        if (!salaryFilter(job.salary)) {
          totalFilteredSalary++;
          continue;
        }
        if (!contentFilter(job.description, matchedTitleKeywords(job.title, config.title_filter))) {
          totalFilteredContent++;
          continue;
        }
        if (!countryEligibilityFilter(job.description)) {
          totalFilteredCountryEligibility++;
          continue;
        }
        if (!visaFilter(job.description)) {
          totalFilteredVisa++;
          continue;
        }
        const dedupUrl = normalizeUrlForDedup(job.url);
        if (seenUrls.has(dedupUrl)) {
          totalDupes++;
          continue;
        }
        const baseKey = companyRoleDedupKey(job.company, job.title, canonicalizeCompany);
        const key = company.aggregator === true
          ? null
          : (dedupIncludeLocation
            ? companyRoleDedupKey(job.company, job.title, canonicalizeCompany, job.location)
            : baseKey);
        const requisition = requisitionIdsForDedup({ url: job.url, text: job.title, requisitionId: job.requisitionId });
        const language = languageFormsForDedup(job.language);
        if (matchesSeenCompanyRole({ key, baseKey, seen: seenCompanyRoles,
          requisitions: seenCompanyRoleRequisitions, locatedRequisitions: locatedRequisitionsByBase,
          languages: seenCompanyRoleLanguages, locatedLanguages: locatedLanguagesByBase },
        requisition, dedupIncludeLanguage ? language : [])) {
          totalDupes++;
          continue;
        }
        const cooldownResult = cooldownFilter(job);
        if (cooldownResult.skip) {
          totalFilteredCooldown++;
          cooldownOffers.push({
            job: { ...job, source: sourceName },
            status: cooldownResult.reason,
          });
          continue;
        }
        seenUrls.add(dedupUrl);
        if (key !== null) {
          seenCompanyRoles.add(key);
          recordForms(seenCompanyRoleRequisitions, key, requisition);
          recordLanguages(seenCompanyRoleLanguages, key, requisition, language);
          if (key !== baseKey) {
            recordForms(locatedRequisitionsByBase, baseKey, requisition);
            recordLanguages(locatedLanguagesByBase, baseKey, requisition, language);
          }
        }
        const careersUrlDomain = extractCareersUrlDomain(company.careers_url);
        newOffers.push({
          ...job,
          source: sourceName,
          tracked: Boolean(careersUrlDomain),
          careersUrlDomain,
        });
      }
    } catch (err) {
      errors.push({
        company: company.name,
        error: err.message,
        kind: classifyFetchError(err),
        status: err.status ?? observation.lastStatus,
      });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  let migratedOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) via API, with sequential Playwright fallback...`);
    const result = await verifyOffers(newOffers, { headedFallback, throttleBaseMs, rediscover });
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
    migratedOffers = result.migrated;
    if (migratedOffers.length > 0) {
      verifiedOffers = [...verifiedOffers, ...migratedOffers];
    }
  }

  for (const offer of verifiedOffers) {
    offer.fingerprint = fingerprintText(offer.description);
  }
  const crossListings = findCrossListings(verifiedOffers, dedupSnapshot.fingerprintHistory);

  if (!dryRun && verifiedOffers.length > 0) {
    await appendToPipeline(verifiedOffers);
    await appendToScanHistory(verifiedOffers, date);
  }
  if (!dryRun && cooldownOffers.length > 0) {
    const cooldownGroups = {};
    for (const item of cooldownOffers) {
      if (!cooldownGroups[item.status]) {
        cooldownGroups[item.status] = [];
      }
      cooldownGroups[item.status].push(item.job);
    }
    for (const [status, group] of Object.entries(cooldownGroups)) {
      await appendToScanHistory(group, date, status);
    }
  }
  const expiredForHistory = [
    ...expiredOffers,
    ...migratedOffers.map(o => ({ ...o, url: o.previousUrl })),
  ];
  if (!dryRun && expiredForHistory.length > 0) {
    await appendToScanHistory(expiredForHistory, date, 'skipped_expired');
  }
  if (!dryRun && (locationFilteredOffers.length > 0 || ageFilteredOffers.length > 0)) {
    const historyText = readIfExists(SCAN_HISTORY_PATH);
    const newLocationRows = unrecordedOffers(locationFilteredOffers, 'skipped_location', historyText);
    const newAgeRows = unrecordedOffers(ageFilteredOffers, 'skipped_age', historyText);
    if (newLocationRows.length > 0) await appendToScanHistory(newLocationRows, date, 'skipped_location');
    if (newAgeRows.length > 0) await appendToScanHistory(newAgeRows, date, 'skipped_age');
  }
  if (!dryRun && droppedOffers.length > 0) {
    await appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  if (!dryRun && invalidOffers.length > 0) {
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      await appendToScanHistory(group, date, status);
    }
  }

  printScanSummaryHeader('Portal Scan', date);
  const summaryCompanies = targets.filter(t => !t._isBoard).length;
  const summaryBoards = targets.filter(t => t._isBoard).length;
  console.log(`Companies scanned:     ${summaryCompanies}`);
  if (summaryBoards > 0) console.log(`Job boards scanned:    ${summaryBoards}`);
  console.log(`Total jobs found:      ${totalFound}`);
  if (config.title_filter || totalFilteredTitle > 0) {
    console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  }
  if (fieldFilters.size > 0) {
    console.log(`Filtered by field:     ${totalFilteredDeclaredField} removed`);
    console.log(`Passed, field absent:  ${totalPassedFieldAbsent} ungated`);
  }
  if (skipTiers.length > 0) {
    console.log(`Filtered by tier:      ${totalFilteredTier} removed`);
  }
  if (config.location_filter || totalFilteredLocation > 0) {
    console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  }
  if (config.max_posting_age_days != null || totalFilteredPostingAge > 0) {
    console.log(`Filtered by age:       ${totalFilteredPostingAge} removed`);
  }
  if (effectiveAfter || postedBefore) {
    console.log(`Filtered by posted date: ${totalFilteredPostedDate} removed`);
  }
  if (config.salary_filter || totalFilteredSalary > 0) {
    console.log(`Filtered by salary:    ${totalFilteredSalary} removed`);
  }
  if (config.content_filter || totalFilteredContent > 0) {
    console.log(`Filtered by content:   ${totalFilteredContent} removed`);
  }
  if (config.country_eligibility_filter || totalFilteredCountryEligibility > 0) {
    console.log(`Filtered by country eligibility: ${totalFilteredCountryEligibility} removed`);
  }
  if (visaEnabled) {
    console.log(`Filtered by visa:      ${totalFilteredVisa} removed`);
  }
  if (Object.keys(windows).length > 0 || totalFilteredCooldown > 0) {
    console.log(`Filtered by cooldown:  ${totalFilteredCooldown} removed`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (blacklist.size > 0) {
    if (includeBlacklisted) {
      console.log(`Blacklisted:           ${annotatedBlacklisted} let through annotated (--include-blacklisted)`);
    } else {
      console.log(`Blacklisted:           ${totalFilteredBlacklist} skipped (blacklist)`);
    }
  }
  if (crossListings.length > 0) {
    console.log(`\n⚠️  Possible cross-listings (same JD text, different company) — warn only, nothing was dropped:`);
    for (const { offer, row, score } of crossListings) {
      console.log(`  - ${offer.company} — ${offer.title}`);
      console.log(`    ≈ ${Math.round(score * 100)}% of ${row.company} — ${row.title} (seen ${row.dateStr})`);
      console.log(`    ${offer.url}`);
      console.log(`    vs ${row.url}`);
    }
    console.log(`  If one side is an agency, apply through ONE channel only — a double submission burns both (#1596).`);
  }
  const aggregatorMap = loadAggregatorDomains();
  if (aggregatorMap.size > 0 && verifiedOffers.length > 0) {
    const aggregatorMatches = [];
    for (const offer of verifiedOffers) {
      const match = checkAggregatorRepost(offer, aggregatorMap);
      if (match) {
        aggregatorMatches.push({ offer, match });
      }
    }
    if (aggregatorMatches.length > 0) {
      console.log(`\n⚠️  Possible aggregator reposts (listed on a known aggregator domain) — warn only, nothing was dropped:`);
      for (const { offer, match } of aggregatorMatches) {
        console.log(`  - ${offer.company} — ${offer.title}`);
        console.log(`    ${offer.url}`);
        console.log(`    (${match.domain}: ${match.reason || 'known aggregator'})`);
      }
      console.log(`  Aggregators often scrape primary boards — consider applying directly on the employer's career site (#3577).`);
    }
  }
  const deadDeclarations = [];
  for (const target of targets) {
    for (const field of normalizeFilterOn(target.filter_on)) {
      if (field === 'title') continue;
      const key = declaredFieldKey(target._targetId, field);
      const seen = declaredFieldSeen.get(key) || 0;
      const absent = declaredFieldAbsent.get(key) || 0;
      if (seen > 0 && absent === seen) deadDeclarations.push({ name: target.name, field, seen });
    }
  }
  if (deadDeclarations.length > 0) {
    console.log(`
⚠️  Declared field never observed — that whitelist is effectively OFF:`);
    for (const d of deadDeclarations) {
      console.log(`  ${d.name}: "${d.field}" absent on all ${d.seen} job(s) from this target`);
    }
    console.log(`  Check the field name and whether the provider supplies it.`);
  }
  if (historyPolicy.recheckAfterDays != null) {
    console.log(`Recheck eligible:      ${dedupSnapshot.recheckEligible} old scan-history URL(s)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Rediscovered (moved):  ${migratedOffers.length} migrated`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  if (config.trust_filter && config.trust_filter.enabled !== false && verifiedOffers.length > 0) {
    const trustHigh = verifiedOffers.filter(o => o.trustLevel === 'high').length;
    const trustMedium = verifiedOffers.filter(o => o.trustLevel === 'medium').length;
    const trustLow = verifiedOffers.filter(o => o.trustLevel === 'low').length;
    console.log(`Trust validation:      ${trustHigh} high, ${trustMedium} medium, ${trustLow} low`);
    const flagCounts = {};
    for (const o of verifiedOffers) {
      for (const f of (o.trustFlags || [])) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
    if (Object.keys(flagCounts).length > 0) {
      const parts = Object.entries(flagCounts).map(([k, v]) => `${k}: ${v}`);
      console.log(`Trust flags:           ${parts.join(', ')}`);
    }
  }

  if (agentHandoff.length > 0) {
    console.log(`Agent/WebSearch handoff: ${agentHandoff.length} compan${agentHandoff.length === 1 ? 'y' : 'ies'} not handled by zero-token providers`);
    for (const item of agentHandoff.slice(0, 25)) {
      const hint = item.query ? ` — ${item.query}` : '';
      console.log(`  • ${item.company} (${item.method})${hint}`);
    }
    if (agentHandoff.length > 25) {
      console.log(`  … ${agentHandoff.length - 25} more omitted; narrow with --company or inspect portals.yml`);
    }
  }

  const unreachableTargets = errors.filter((e) => e.kind === 'slug_gone');
  const networkTargets = errors.filter((e) => e.kind === 'network');
  const otherErrors = errors.filter((e) => e.kind !== 'slug_gone' && e.kind !== 'network');

  const STREAK_THRESHOLD = config.portal_health_threshold || 3;
  const nowStr = new Date().toISOString();
  const healthRecords = [];

  const errorKindByCompany = new Map(
    errors.filter((e) => e.kind).map((e) => [e.company, e.kind])
  );
  for (const t of targets) {
    const isEmpty = emptyTargets.includes(t.name);
    const isUnverifiedZero = unverifiedZeroTargets.includes(t.name);

    let status = errorKindByCompany.get(t.name) || 'reachable';
    if (status === 'reachable' && isEmpty) status = 'empty';
    if (status === 'reachable' && isUnverifiedZero) status = 'unverified_zero';

    healthRecords.push({ timestamp: nowStr, company: t.name, status });
  }

  const pastHealth = loadPortalHealth();
  const currentStreaks = computeConsecutiveFailures([...pastHealth, ...healthRecords]);

  const persistentlyDead = [];
  const newlyDeadSlug = [];
  const newlyDeadNetwork = [];

  for (const e of [...unreachableTargets, ...networkTargets, ...otherErrors.filter((x) => x.kind),
    ...unverifiedZeroTargets.map(company => ({ company, kind: 'unverified_zero' }))]) {
    const streak = currentStreaks.get(e.company) || 1;
    if (streak >= STREAK_THRESHOLD) {
      if (!persistentlyDead.includes(e.company)) persistentlyDead.push(e.company);
    } else if (e.kind === 'slug_gone') {
      if (!newlyDeadSlug.some(x => x.company === e.company)) newlyDeadSlug.push(e);
    } else if (e.kind === 'network') {
      newlyDeadNetwork.push(e);
    }
  }

  if (persistentlyDead.length > 0) {
    console.log(`\n🚨 FIX NEEDED: ${persistentlyDead.length} target(s) have been unreachable for ${STREAK_THRESHOLD}+ runs:`);
    console.log(`   ${persistentlyDead.join(', ')}`);
    console.log(`   Run: node verify-portals.mjs to check if the ATS migrated, or update their board slugs.`);
  }
  if (newlyDeadSlug.length > 0) {
    const names = newlyDeadSlug.map(x => x.company).join(', ');
    console.log(`\n⚠️  ${newlyDeadSlug.length} target(s) unreachable (slug?): ${names} — run: node verify-portals.mjs`);
  }
  if (emptyTargets.length > 0) {
    console.log(`🟡 ${emptyTargets.length} target(s) live but empty: ${emptyTargets.join(', ')}`);
  }
  if (unverifiedZeroTargets.length > 0) {
    console.log(`⚠️  ${unverifiedZeroTargets.length} target(s) returned zero jobs without a successful HTTP response: ${unverifiedZeroTargets.join(', ')}`);
  }
  if (newlyDeadNetwork.length > 0) {
    console.log(`\nNetwork errors (${newlyDeadNetwork.length}):`);
    for (const e of newlyDeadNetwork) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }
  if (otherErrors.length > 0) {
    console.log(`\nErrors (${otherErrors.length}):`);
    for (const e of otherErrors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      const trustSuffix = o.trustScore != null && o.trustScore < 100
        ? ` [Trust: ${o.trustScore}/100${o.trustFlags?.length ? ' — ' + o.trustFlags.join(', ') : ''}]`
        : '';
      const blacklistSuffix = o.blacklisted ? ' [BLACKLISTED — on your do-not-apply list]' : '';
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}${trustSuffix}${blacklistSuffix}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  if (!dryRun) {
    await appendPortalHealth(healthRecords);
    await withPipelineLock(SCAN_RUNS_PATH, () => appendScanRunSummary({
      timestamp: new Date().toISOString(), status: 'completed',
      companies: summaryCompanies, boards: summaryBoards, found: totalFound,
      filteredTitle: totalFilteredTitle, filteredTier: totalFilteredTier,
      filteredLocation: totalFilteredLocation, filteredPostingAge: totalFilteredPostingAge,
      filteredSalary: totalFilteredSalary,
      filteredContent: totalFilteredContent, filteredCooldown: totalFilteredCooldown,
      dupes: totalDupes, newAdded: verifiedOffers.length, errors: errors.length,
      filteredBlacklist: totalFilteredBlacklist,
      filteredVisa: totalFilteredVisa,
      filteredPostedDate: totalFilteredPostedDate,
      filteredCountryEligibility: totalFilteredCountryEligibility,
    }));
  }
  registerRunFailureSnapshot(null);

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');

  if (jsonMode) {
    const filtered = totalFilteredTitle + totalFilteredDeclaredField + totalFilteredTier + totalFilteredLocation
      + totalFilteredPostingAge + totalFilteredPostedDate + totalFilteredSalary
      + totalFilteredContent + totalFilteredCountryEligibility + totalFilteredBlacklist
      + totalFilteredVisa + totalFilteredCooldown;
    emitJsonReceipt({
      version: 'careerops.scan.receipt@1',
      date,
      scanned: targets.length,
      skipped: skippedCount,
      found: totalFound,
      filtered,
      duplicates: totalDupes,
      added: verifiedOffers.length,
      added_urls: verifiedOffers.map(offer => offer.url),
      errors: errors.map(({ company, error }) => ({ company, error })),
      unverified_zero: unverifiedZeroTargets,
      dry_run: dryRun,
    }, errors.length > 0 ? 2 : 0);
  }

  if (!dryRun && process.stdout.isTTY && !process.argv.includes('--quiet') && !existsSync('.manifesto-noted')) {
    const osc8 = ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby'].includes(process.env.TERM_PROGRAM)
      || !!process.env.WT_SESSION || !!process.env.KITTY_WINDOW_ID
      || parseInt(process.env.VTE_VERSION || '0', 10) >= 5000;
    const link = osc8
      ? '\x1b]8;;https://career-ops.org/manifesto?utm_source=cli\x1b\\career-ops.org/manifesto\x1b]8;;\x1b\\'
      : 'career-ops.org/manifesto?utm_source=cli';
    console.log(`\nthe practice behind this tool has a name and a manifesto: ${link}`);
    try { writeFileSync('.manifesto-noted', new Date().toISOString() + '\n'); } catch { }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    writeRunFailureRow('failed');
    process.exitCode = 1;
  });
}
