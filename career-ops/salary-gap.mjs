#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportLinks, extractTrackerReportNumbers } from './tracker-parse.mjs';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();
const OBS_PATH = join(CAREER_OPS, 'data/salary-observations.tsv');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RELOCATION_TABLE_PATH = join(SCRIPT_DIR, 'templates/jurisdiction-relocation-tax.yml');

export function normalizeId(raw) {
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

const compareIds = (a, b) => {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b);
};

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const statedForFlagIdx = args.indexOf('--stated-for');
const statedForNum = statedForFlagIdx !== -1 ? args[statedForFlagIdx + 1] : null;
const relocationMode = args.includes('--relocation');
const relocGrossRaw = flagValue(args, '--gross');
const relocCurrency = flagValue(args, '--currency') ?? null;
const relocPostingLocation = flagValue(args, '--posting-location') ?? null;
const relocPostingLocationFile = flagValue(args, '--posting-location-file') ?? null;
const relocPostingLocationFileFlagPresent = hasFlag(args, '--posting-location-file');
const relocHomeLocationFlag = flagValue(args, '--home-location') ?? null;

const TRUST = {
  actual: { contract: 3, 'offer-letter': 2, 'recruiter-verbal': 1, user: 0 },
  desired: { user: 1, profile: 0 },
  advertised: { user: 2, 'recruiter-verbal': 1, jd: 0 },
};

function canonicalizeSeparators(numStr) {
  const lastComma = numStr.lastIndexOf(',');
  const lastDot = numStr.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    return numStr.split(grouping).join('').replace(decimal, '.');
  }

  const sep = lastComma !== -1 ? ',' : lastDot !== -1 ? '.' : null;
  if (sep === null) return numStr;
  const grouped = new RegExp(`(\\d)\\${sep}(?=\\d{3}(?!\\d))`, 'g');
  return numStr.replace(grouped, '$1').replace(sep, '.');
}

export function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s === '?' || s === '-' || /^(n\/?a|null)$/i.test(s)) return null;
  const stripAnnual = (value) => value.replace(/\s*(?:\/\s*(?:year|yr)|per\s+(?:year|annum)|annual(?:ly)?|yearly)\s*$/i, '').trim();
  s = stripAnnual(s);
  s = s.replace(/[€$£¥]/g, '').replace(/\s*[A-Za-z]{3}\s*$/, '').trim();
  s = stripAnnual(s);
  const toNum = (numStr, kFlag) => {
    const n = parseFloat(canonicalizeSeparators(numStr));
    return Number.isNaN(n) ? null : (kFlag ? n * 1000 : n);
  };
  const range = s.match(/^([\d.,]+)\s*(k)?\s*[-–—]\s*([\d.,]+)\s*(k)?$/i);
  if (range) {
    const lo = toNum(range[1], range[2] || range[4]);
    const hi = toNum(range[3], range[4] || range[2]);
    if (lo === null || hi === null) return null;
    const min = Math.min(lo, hi), max = Math.max(lo, hi);
    return { min, max, mid: (min + max) / 2 };
  }
  const single = s.match(/^([\d.,]+)\s*(k)?$/i);
  if (single) {
    const v = toNum(single[1], single[2]);
    return v === null ? null : { min: v, max: v, mid: v };
  }
  return null;
}

export function compensationPeriod(raw) {
  const value = String(raw ?? '');
  if (/(?:\/\s*(?:year|yr)\b|\bper\s+(?:year|annum)\b|\bannual(?:ly)?\b|\byearly\b)/i.test(value)) return 'annual';
  if (/(?:\/\s*(?:month|mo)\b|\bper\s+month\b|\bmonthly\b)/i.test(value)) return 'monthly';
  if (/(?:\/\s*(?:hour|hr)\b|\bper\s+hour\b|\bhourly\b)/i.test(value)) return 'hourly';
  return null;
}

const VALID_TYPES = new Set(['desired', 'advertised', 'actual', 'stated']);

export function parseObservations(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cells = t.split('\t');
    if (cells.length < 6) continue;
    const [num, date, type, amount, currency, source, note = '', round = '', interviewer = ''] = cells.map(c => c.trim());
    if (!VALID_TYPES.has(type)) continue;
    out.push({ num, date, type, amount, currency: currency ? currency.toUpperCase() : 'UNKNOWN', source, note, round, interviewer, parsed: parseAmount(amount) });
  }
  return out;
}

export function getStatedObservations(observations, num) {
  const want = normalizeId(num);
  return observations
    .filter(o => o.type === 'stated' && normalizeId(o.num) === want)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const FENCE_RE = /##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i;
const yamlStr = (body, key) => {
  const m = body.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  const v = m[1].trim().replace(/^["']|["']$/g, '');
  return v === 'null' || v === '' ? null : v;
};

export function reportToObservation(content, num, date) {
  const fence = String(content || '').match(FENCE_RE);
  if (!fence) return null;
  const body = fence[1];
  const company = yamlStr(body, 'company');
  const role = yamlStr(body, 'role');
  const adv = yamlStr(body, 'advertised_comp');
  const postingLocation = yamlStr(body, 'posting_location');
  const currencyGuess = adv ? (adv.match(/\b[A-Z]{3}\b/)?.[0] ?? 'UNKNOWN') : null;
  return {
    company, role, postingLocation,
    observation: adv === null ? null : {
      num, date, type: 'advertised', amount: adv, currency: currencyGuess,
      source: 'jd', note: 'from report Machine Summary', parsed: parseAmount(adv),
      period: compensationPeriod(adv), postingLocation,
    },
  };
}

export function loadRelocationTable(tablePath = RELOCATION_TABLE_PATH) {
  if (!existsSync(tablePath)) return null;
  try {
    const doc = yaml.load(readFileSync(tablePath, 'utf-8').replace(/\r\n/g, '\n'));
    return doc?.jurisdictions && typeof doc.jurisdictions === 'object' ? doc.jurisdictions : null;
  } catch {
    return null;
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BLOCKING_CONTEXT_MARKERS = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
  'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
  'United States', 'USA',
  'United Kingdom', 'UK', 'England', 'Scotland', 'Wales',
  'New Zealand', 'Australia',
  'Quebec', 'Québec', 'QC', 'Manitoba', 'MB', 'Saskatchewan', 'SK',
  'New Brunswick', 'NB', 'Prince Edward Island', 'PE',
  'Newfoundland and Labrador', 'NL', 'Yukon', 'YT',
  'Northwest Territories', 'NT', 'Nunavut', 'NU',
];
const hasBlockingContext = (text) => BLOCKING_CONTEXT_MARKERS.some(
  (m) => new RegExp(`\\b${escapeRegExp(m)}\\b`, 'i').test(text),
);

function isStrongAlias(alias, row) {
  const bare = alias.replace(/^[,\s]+/, '').trim();
  if (/^[A-Z]{2}$/.test(bare)) return true;
  const provinceName = String(row?.jurisdiction_name ?? '').split(',')[0].trim();
  return !!provinceName && bare.toLowerCase() === provinceName.toLowerCase();
}

function textContainsAlias(text, alias) {
  const bare = alias.replace(/^[,\s]+/, '').trim();
  if (!bare) return false;
  if (/^[A-Z]{2}$/.test(bare)) {
    const re = new RegExp(`(^|[\\s,(])${escapeRegExp(bare)}(?=$|[\\s,).])`);
    return re.test(text);
  }
  const re = new RegExp(`\\b${escapeRegExp(bare)}\\b`, 'i');
  return re.test(text);
}

export function matchJurisdiction(text, jurisdictions) {
  const s = String(text ?? '').trim();
  if (!s || !jurisdictions) return null;

  const strongMatches = new Set();
  const weakMatches = new Set();
  for (const [code, row] of Object.entries(jurisdictions)) {
    if (row?.level === 'federal') continue;
    let strongHit = false;
    let weakHit = false;
    for (const alias of row?.aliases ?? []) {
      const a = String(alias ?? '').trim();
      if (!a || !textContainsAlias(s, a)) continue;
      if (isStrongAlias(a, row)) strongHit = true;
      else weakHit = true;
    }
    if (strongHit) strongMatches.add(code);
    else if (weakHit) weakMatches.add(code);
  }

  if (strongMatches.size > 0) return strongMatches.size === 1 ? [...strongMatches][0] : null;
  if (weakMatches.size !== 1) return null;

  const onlyCode = [...weakMatches][0];
  if (hasBlockingContext(s)) return null;
  return onlyCode;
}

export function bracketTax(brackets, income) {
  if (!Array.isArray(brackets) || brackets.length === 0 || !(income >= 0)) return null;
  let tax = 0;
  let floor = 0;
  for (const b of brackets) {
    const cap = b?.up_to === null || b?.up_to === undefined ? Infinity : Number(b.up_to);
    const rate = Number(b?.rate);
    if (!Number.isFinite(rate) || (Number.isFinite(cap) && cap <= floor)) return null;
    const slice = Math.max(0, Math.min(income, cap) - floor);
    tax += slice * rate;
    floor = cap;
    if (income <= cap) break;
  }
  return tax;
}

export function computeRelocationAdjustment({ grossAnnual, homeCode, destCode, jurisdictions, currency }) {
  if (!jurisdictions) return { ok: false, reason: 'no-table' };
  if (!(grossAnnual > 0)) return { ok: false, reason: 'no-gross-amount' };
  if (!homeCode || !destCode) return { ok: false, reason: 'no-jurisdiction-match' };
  if (homeCode === destCode) return { ok: false, reason: 'same-jurisdiction' };
  const home = jurisdictions[homeCode];
  const dest = jurisdictions[destCode];
  if (!home || !dest) return { ok: false, reason: 'no-jurisdiction-match' };
  if (home.country !== dest.country) return { ok: false, reason: 'cross-country-not-supported' };

  const tableCurrency = dest.currency ?? home.currency ?? null;
  if (tableCurrency) {
    const stated = currency ? String(currency).toUpperCase() : 'UNKNOWN';
    if (stated === 'UNKNOWN' || stated !== String(tableCurrency).toUpperCase()) {
      return { ok: false, reason: 'currency-mismatch' };
    }
  }

  const federalCode = Object.keys(jurisdictions).find(
    (c) => jurisdictions[c]?.level === 'federal' && jurisdictions[c]?.country === home.country,
  );
  const federal = federalCode ? jurisdictions[federalCode] : null;
  if (!federal) return { ok: false, reason: 'no-federal-table' };

  const sideFor = (row) => {
    const federalTax = bracketTax(federal.brackets, grossAnnual);
    const subnationalTax = bracketTax(row.brackets, grossAnnual);
    if (federalTax === null || subnationalTax === null) return null;
    const totalTax = federalTax + subnationalTax;
    return {
      jurisdiction: row.jurisdiction_name, federalTax, subnationalTax, totalTax,
      takeHome: grossAnnual - totalTax, effectiveRate: totalTax / grossAnnual,
    };
  };
  const homeSide = sideFor(home);
  const destSide = sideFor(dest);
  if (!homeSide || !destSide) return { ok: false, reason: 'malformed-brackets' };

  return {
    ok: true,
    grossAnnual,
    taxYear: dest.tax_year ?? home.tax_year ?? null,
    home: homeSide,
    dest: destSide,
    takeHomeDeltaAbs: destSide.takeHome - homeSide.takeHome,
    takeHomeDeltaPct: ((destSide.takeHome - homeSide.takeHome) / homeSide.takeHome) * 100,
    limitations: 'Marginal tax brackets only (federal + provincial/state) — basic personal amount, credits, CPP/EI, surtaxes and cost-of-living are NOT modeled. Not financial or tax advice; a corroborating data point only.',
  };
}

export function relocationForApplication(a, { jurisdictions, homeLocation }) {
  const postingLocation = a?.advertised?.postingLocation;
  if (!jurisdictions || !homeLocation || !postingLocation || !a?.advertised) return null;
  if (a.advertised.period !== 'annual') return null;
  const homeCode = matchJurisdiction(homeLocation, jurisdictions);
  const destCode = matchJurisdiction(postingLocation, jurisdictions);
  return computeRelocationAdjustment({
    grossAnnual: a.advertised.value, homeCode, destCode, jurisdictions,
    currency: a.advertised.currency,
  });
}

const pctDelta = (from, to) => ((to - from) / from) * 100;
const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function pickEffective(type, candidates) {
  const tiers = TRUST[type];
  const usable = candidates.filter(o => o.type === type && o.parsed !== null && Object.hasOwn(tiers, o.source));
  if (!usable.length) return null;
  usable.sort((a, b) => (tiers[b.source] - tiers[a.source]) || (a.date < b.date ? 1 : -1));
  const top = usable[0];
  return {
    value: top.parsed.mid, source: top.source, date: top.date,
    currency: top.currency, raw: top.amount,
    period: top.period ?? compensationPeriod(top.amount),
    postingLocation: top.postingLocation ?? null,
  };
}

export function fold(observations, apps, profileDesired) {
  const appsByNum = new Map(Object.entries(apps ?? {}).map(([k, v]) => [normalizeId(k), v]));
  const byNum = new Map();
  for (const o of observations) {
    const key = normalizeId(o.num);
    if (!byNum.has(key)) byNum.set(key, []);
    byNum.get(key).push(o);
  }

  const applications = [];
  const orphans = [];
  const currencyMismatches = [];
  const unparseable = observations
    .filter(o => o.parsed === null && o.amount && o.amount !== '?')
    .map(o => ({ num: normalizeId(o.num), type: o.type, raw: o.amount }));
  const invalidSources = observations
    .filter(o => TRUST[o.type] && !Object.hasOwn(TRUST[o.type], o.source))
    .map(o => ({ num: normalizeId(o.num), type: o.type, source: o.source }));

  const profileObs = profileDesired?.amount ? {
    num: '*', date: '0000-00-00', type: 'desired', amount: profileDesired.amount,
    currency: (profileDesired.currency || 'UNKNOWN').toUpperCase(), source: 'profile', note: '', parsed: parseAmount(profileDesired.amount),
  } : null;
  if (profileObs && profileObs.parsed === null && profileObs.amount !== '?') {
    unparseable.push({ num: '*', type: 'desired', raw: profileObs.amount, source: 'profile' });
  }

  for (const [num, obs] of byNum) {
    const meta = appsByNum.get(num);
    if (!meta) { orphans.push({ num, count: obs.length }); continue; }
    const trail = [...obs].sort((a, b) => (a.date < b.date ? -1 : 1));
    const desired = pickEffective('desired', profileObs ? [...obs, profileObs] : obs);
    const advertised = pickEffective('advertised', obs);
    const actual = pickEffective('actual', obs);
    const advComparable = advertised && actual && advertised.currency === actual.currency && advertised.currency !== 'UNKNOWN';
    const desComparable = desired && actual && desired.currency === actual.currency && desired.currency !== 'UNKNOWN';
    if (advertised && actual && !advComparable) currencyMismatches.push({ num, comparison: 'advertised-vs-actual', currencies: [advertised.currency, actual.currency] });
    if (desired && actual && !desComparable) currencyMismatches.push({ num, comparison: 'desired-vs-actual', currencies: [desired.currency, actual.currency] });
    applications.push({
      num, company: meta.company, role: meta.role, postingLocation: meta.postingLocation ?? null,
      desired, advertised, actual, trail,
      advToActPct: advComparable ? pctDelta(advertised.value, actual.value) : null,
      desiredToActPct: desComparable ? pctDelta(desired.value, actual.value) : null,
    });
  }
  for (const [num, meta] of appsByNum) {
    if (!byNum.has(num) && profileObs) {
      applications.push({
        num, company: meta.company, role: meta.role, postingLocation: meta.postingLocation ?? null,
        desired: pickEffective('desired', [profileObs]), advertised: null, actual: null,
        trail: [], advToActPct: null, desiredToActPct: null,
      });
    }
  }
  applications.sort((a, b) => compareIds(a.num, b.num));

  const byCurrency = {};
  const byCompanyRole = {};
  const today = applications.flatMap(a => a.trail.map(t => t.date)).sort().pop() ?? null;
  for (const a of applications) {
    if (!a.actual) continue;
    const cur = a.actual.currency || 'UNKNOWN';
    byCurrency[cur] ??= { confirmed: 0, advGaps: [], atOrAboveAdvertised: 0, atOrAboveDesired: 0, newestActual: null };
    const agg = byCurrency[cur];
    agg.confirmed += 1;
    agg.newestActual = [agg.newestActual, a.actual.date].filter(Boolean).sort().pop();
    if (a.advToActPct !== null) {
      agg.advGaps.push(a.advToActPct);
      if (a.actual.value >= a.advertised.value) agg.atOrAboveAdvertised += 1;
    }
    if (a.desiredToActPct !== null && a.actual.value >= a.desired.value) agg.atOrAboveDesired += 1;

    const legacy = !a.company && !a.role;
    const key = legacy ? `#${a.num}` : `${a.company}|${a.role}`;
    byCompanyRole[key] ??= legacy
      ? { company: `report #${a.num}`, role: '(no Machine Summary)', confirmed: 0, advToActPcts: [] }
      : { company: a.company, role: a.role, confirmed: 0, advToActPcts: [] };
    byCompanyRole[key].confirmed += 1;
    if (a.advToActPct !== null) byCompanyRole[key].advToActPcts.push(a.advToActPct);
  }
  for (const agg of Object.values(byCurrency)) {
    agg.meanAdvToActPct = agg.advGaps.length ? agg.advGaps.reduce((s, v) => s + v, 0) / agg.advGaps.length : null;
    agg.medianAdvToActPct = agg.advGaps.length ? median(agg.advGaps) : null;
    delete agg.advGaps;
  }

  return {
    applications,
    aggregates: { byCurrency, byCompanyRole },
    quality: {
      orphans, unparseable, invalidSources,
      currencyMismatches: currencyMismatches.sort((a, b) => compareIds(a.num, b.num)),
      withoutActual: applications.filter(a => !a.actual).length, latestObservation: today,
    },
  };
}

const OBS_FIXTURE = [
  '001\t2026-06-20\tdesired\t95k\tEUR\tuser\tstated in eval chat',
  '001\t2026-06-28\tactual\t90k\tEUR\trecruiter-verbal\tscreen call',
  '001\t2026-07-03\tactual\t84k\tEUR\toffer-letter\t',
  '001\t2026-07-05\tactual\t86k\tEUR\tcontract\tsigned',
  '002\t2026-06-25\tactual\t88k\tEUR\trecruiter-verbal\t',
  '002\t2026-06-29\tactual\t99k\tEUR\trecruiter_verbal\tunderscore typo on purpose',
  '002\t2026-06-30\tactual\t120k\tEUR\ttoString\tprototype key on purpose',
  '007\t2026-06-25\tactual\t70k\tEUR\trecruiter-verbal\torphan - no report',
  '003\t2026-06-26\tactual\t9ok\tUSD\trecruiter-verbal\ttypo on purpose',
  '005\t2026-07-01\tactual\t92k\tUNKNOWN\toffer-letter\tcurrency not stated',
].join('\n');

const REPORT_FIXTURE_001 = `# Eval: Acme — ML Eng

## Machine Summary

\`\`\`yaml
company: "Acme"
role: "ML Eng"
score: 4.2
advertised_comp: "80-90k EUR"
\`\`\`
`;
const REPORT_FIXTURE_002 = `# Eval: Globex — Data Eng

## Machine Summary

\`\`\`yaml
company: "Globex"
role: "Data Eng"
score: 3.9
advertised_comp: "100k EUR"
\`\`\`
`;
const REPORT_FIXTURE_004 = `# Eval: Umbrella — AI Eng

## Machine Summary

\`\`\`yaml
company: "Umbrella"
role: "AI Eng"
score: 4.1
advertised_comp: "100k USD"
\`\`\`
`;
const REPORT_FIXTURE_005 = `# Eval: Hooli — AI Lead

## Machine Summary

\`\`\`yaml
company: "Hooli"
role: "AI Lead"
score: 3.8
advertised_comp: "95k"
\`\`\`
`;
const REPORT_FIXTURE_003 = `# Eval: Initech — Platform

## Machine Summary

\`\`\`yaml
company: "Initech"
role: "Platform"
score: 4.0
advertised_comp: null
\`\`\`
`;

const REPORT_FIXTURE_4351_029 = `# Eval: Acme — Staff Engineer

## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff Engineer"
advertised_comp: "100k EUR"
\`\`\`
`;

const REPORT_FIXTURE_4368_006 = `# Eval: Globex — Engineer

## Machine Summary

\`\`\`yaml
company: "Globex"
role: "Engineer"
advertised_comp: "200k EUR"
\`\`\`
`;

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); }
  };

  assert(parseAmount('84k')?.mid === 84000, '84k -> 84000');
  assert(parseAmount('84000')?.mid === 84000, 'plain number');
  assert(parseAmount('80-90k')?.mid === 85000, 'range with trailing k');
  assert(parseAmount('80k-90k')?.min === 80000, 'range with both k');
  assert(parseAmount('$80k')?.mid === 80000, 'leading currency symbol tolerated');
  assert(parseAmount('82.5k')?.mid === 82500, 'decimal k');
  assert(parseAmount('90-80k')?.min === 80000, 'reversed range normalized');
  assert(parseAmount('?') === null, '? -> null');
  assert(parseAmount('') === null, 'blank -> null');
  assert(parseAmount('competitive') === null, 'prose -> null');
  assert(parseAmount('9ok') === null, 'typo -> null');
  assert(parseAmount('450k SEK')?.mid === 450000, 'generic trailing ISO token stripped (450k SEK)');
  assert(parseAmount('80-90k eur')?.mid === 85000, 'lowercase trailing ISO token stripped');
  assert(parseAmount('$123,684—$254,644 USD')?.mid === 189164, 'US range, symbol on both bounds, em dash');
  assert(parseAmount('$123,684-$254,644 USD')?.mid === 189164, 'US range, symbol on both bounds, hyphen');
  assert(parseAmount('€80,000-€90,000')?.min === 80000, 'EUR range, symbol on both bounds');
  assert(parseAmount('$150,000')?.mid === 150000, 'single value with symbol still works');
  assert(parseAmount('€35.000 - €45.000')?.min === 35000 && parseAmount('€35.000 - €45.000')?.max === 45000, 'period-grouped range (#3174)');
  assert(parseAmount('40.000')?.mid === 40000, 'period-grouped single value (#3174)');
  assert(parseAmount('35.000 - 55.000')?.mid === 45000, 'period-grouped range, no currency symbol (#3174)');

  assert(parseAmount('€45.000,00')?.mid === 45000, 'period grouping + comma decimal');
  assert(parseAmount('120.000,00 EUR')?.mid === 120000, 'period grouping + comma decimal, trailing ISO token');
  assert(parseAmount('45.000,50')?.mid === 45000.5, 'comma decimal keeps its cents');
  assert(parseAmount('45000,50')?.mid === 45000.5, 'lone comma with two following digits is a decimal point');
  assert(parseAmount('82,5k')?.mid === 82500, 'decimal k written with a comma');
  assert(parseAmount('€1.250.000,75')?.mid === 1250000.75, 'two grouping periods + comma decimal');
  assert(parseAmount('€40.000,00 - €55.000,00')?.mid === 47500, 'range, both bounds with comma decimals');
  assert(parseAmount('$123,684.50')?.mid === 123684.5, 'comma grouping + period decimal');
  assert(parseAmount('1,250')?.mid === 1250, 'lone comma with exactly three following digits stays grouping');

  const obs = parseObservations(OBS_FIXTURE);
  assert(obs.length === 10, `10 observations, got ${obs.length}`);
  assert(obs[0].num === '001' && obs[0].type === 'desired' && obs[0].source === 'user', 'fields mapped');
  assert(parseObservations('').length === 0, 'empty log');
  const blankCur = parseObservations('008\t2026-07-01\tactual\t91k\t\toffer-letter\tblank currency cell');
  assert(blankCur.length === 1 && blankCur[0].currency === 'UNKNOWN', 'blank currency cell -> UNKNOWN (excluded from gap math by the UNKNOWN guard)');

  assert(obs[0].round === '' && obs[0].interviewer === '', 'legacy 7-column row -> round/interviewer default to empty string');

  const statedFixture = [
    '020\t2026-07-01\tstated\t90-95k\tCAD\tuser\ttold recruiter our range\tprescreen\tJane Recruiter',
    '020\t2026-07-08\tstated\t92k\tCAD\tuser\tconfirmed same number in panel\tpanel\tJohn Manager',
    '021\t2026-07-02\tstated\t80k\tCAD\tuser\t',
  ].join('\n');
  const statedObs = parseObservations(statedFixture);
  assert(statedObs.length === 3, `3 stated observations, got ${statedObs.length}`);
  assert(statedObs[0].type === 'stated' && statedObs[0].round === 'prescreen' && statedObs[0].interviewer === 'Jane Recruiter',
    'stated observation carries round + interviewer');
  assert(statedObs[2].round === '' && statedObs[2].interviewer === '', 'stated observation without round/interviewer defaults to empty string');

  const lookup020 = getStatedObservations(statedObs, '020');
  assert(lookup020.length === 2, `2 prior stated observations for 020, got ${lookup020.length}`);
  assert(lookup020[0].interviewer === 'Jane Recruiter' && lookup020[1].interviewer === 'John Manager',
    'stated lookup returns oldest first');
  assert(getStatedObservations(statedObs, '021').length === 1, '021 lookup isolated from 020');
  assert(getStatedObservations(statedObs, '999').length === 0, 'no stated observations for untracked num -> empty array');

  const r1 = reportToObservation(REPORT_FIXTURE_001, '001', '2026-06-20');
  assert(r1.company === 'Acme' && r1.role === 'ML Eng', 'report company/role');
  assert(r1.observation.type === 'advertised' && r1.observation.source === 'jd', 'report -> advertised obs');
  assert(r1.observation.parsed.mid === 85000, 'advertised_comp parsed');
  assert(reportToObservation(REPORT_FIXTURE_003, '003', '2026-06-26').observation === null, 'null advertised_comp -> no obs');
  assert(reportToObservation('no machine summary', '009', '2026-06-01') === null, 'no fence -> null');
  const jsonReport = '# Eval: JsonCo — Eng\n\n## Machine Summary\n\n```json\n{"company": "JsonCo", "role": "Eng", "advertised_comp": "100k EUR"}\n```\n';
  assert(reportToObservation(jsonReport, '010', '2026-06-30') === null, 'json fence rejected (yamlStr cannot extract from JSON — see FENCE_RE comment)');
  const plnReport = '# Eval: PlnCo — Eng\n\n## Machine Summary\n\n```yaml\ncompany: "PlnCo"\nrole: "Eng"\nadvertised_comp: "450-500k PLN"\n```\n';
  const rPln = reportToObservation(plnReport, '011', '2026-07-01');
  assert(rPln.observation.currency === 'PLN' && rPln.observation.parsed.min === 450000, 'non-allowlist currency PLN detected, amount parsed');
  const lowerReport = '# Eval: LowCo — Eng\n\n## Machine Summary\n\n```yaml\ncompany: "LowCo"\nrole: "Eng"\nadvertised_comp: "100k eur"\n```\n';
  const rLow = reportToObservation(lowerReport, '012', '2026-07-01');
  assert(rLow.observation.currency === 'UNKNOWN' && rLow.observation.parsed.mid === 100000, 'lowercase currency token -> UNKNOWN, amount still parsed');

  const apps = {
    '001': { company: 'Acme', role: 'ML Eng' },
    '002': { company: 'Globex', role: 'Data Eng' },
    '003': { company: 'Initech', role: 'Platform' },
    '004': { company: 'Umbrella', role: 'AI Eng' },
    '005': { company: 'Hooli', role: 'AI Lead' },
  };
  const reportObs = [
    { num: '001', ...reportToObservation(REPORT_FIXTURE_001, '001', '2026-06-20').observation },
    { num: '002', ...reportToObservation(REPORT_FIXTURE_002, '002', '2026-06-25').observation },
    { num: '004', ...reportToObservation(REPORT_FIXTURE_004, '004', '2026-06-27').observation },
    { num: '005', ...reportToObservation(REPORT_FIXTURE_005, '005', '2026-06-28').observation },
  ];
  const crossCurrencyObs = parseObservations('004\t2026-06-30\tactual\t88k\tGBP\toffer-letter\tcross-currency on purpose');
  const result = fold([...obs, ...reportObs, ...crossCurrencyObs], apps, { amount: '90k', currency: 'EUR' });

  const a1 = result.applications.find(a => a.num === normalizeId('001'));
  assert(a1.actual.value === 86000 && a1.actual.source === 'contract', '001 actual = contract 86k');
  assert(a1.desired.value === 95000 && a1.desired.source === 'user', '001 desired = user 95k');
  assert(a1.advertised.value === 85000 && a1.advertised.source === 'jd', '001 advertised = jd 85k');
  assert(Math.abs(a1.advToActPct - 1.18) < 0.01, `001 adv->act, got ${a1.advToActPct}`);
  assert(Math.abs(a1.desiredToActPct - (-9.47)) < 0.01, `001 desired->act, got ${a1.desiredToActPct}`);
  assert(a1.trail.filter(t => t.type === 'actual').length === 3, '001 keeps full actual trail');

  const a2 = result.applications.find(a => a.num === normalizeId('002'));
  assert(a2.actual.source === 'recruiter-verbal' && a2.actual.value === 88000, '002 actual from verbal 88k, typo + prototype-key sources ignored');
  assert(a2.desired.source === 'profile' && a2.desired.value === 90000, '002 desired falls back to profile');

  const a4 = result.applications.find(a => a.num === normalizeId('004'));
  assert(a4.advertised.currency === 'USD' && a4.actual.currency === 'GBP', '004 mixed currencies folded');
  assert(a4.advToActPct === null, `004 cross-currency adv->act pct must be null, got ${a4.advToActPct}`);
  assert(a4.desiredToActPct === null, `004 cross-currency desired->act pct must be null, got ${a4.desiredToActPct}`);
  const gbp = result.aggregates.byCurrency.GBP;
  assert(gbp.confirmed === 1 && gbp.meanAdvToActPct === null && gbp.atOrAboveAdvertised === 0 && gbp.atOrAboveDesired === 0,
    'GBP aggregates exclude cross-currency comparisons');

  assert(result.quality.orphans.length === 1 && result.quality.orphans[0].num === normalizeId('007'), 'orphan 007 reported');
  assert(result.quality.unparseable.length === 1 && result.quality.unparseable[0].raw === '9ok', 'typo 9ok reported');
  assert(result.quality.invalidSources.length === 2, `2 invalid sources reported, got ${result.quality.invalidSources.length}`);
  assert(result.quality.invalidSources.some(s => s.num === normalizeId('002') && s.type === 'actual' && s.source === 'recruiter_verbal'),
    'unrecognized source recruiter_verbal reported in invalidSources');
  assert(result.quality.invalidSources.some(s => s.num === normalizeId('002') && s.type === 'actual' && s.source === 'toString'),
    'prototype-key source toString reported in invalidSources, not treated as trusted');
  const badProfile = fold([], {}, { amount: 'competitive', currency: 'EUR' });
  assert(badProfile.quality.unparseable.some(u => u.num === '*' && u.type === 'desired' && u.raw === 'competitive' && u.source === 'profile'),
    'unparseable profile target reported');
  const mm = result.quality.currencyMismatches;
  assert(mm.length === 4, `4 currency mismatches reported, got ${mm.length}`);
  assert(mm.some(m => m.num === normalizeId('004') && m.comparison === 'advertised-vs-actual' && m.currencies[0] === 'USD' && m.currencies[1] === 'GBP'),
    'advertised-vs-actual mismatch reported for 004');
  assert(mm.some(m => m.num === normalizeId('004') && m.comparison === 'desired-vs-actual' && m.currencies[0] === 'EUR' && m.currencies[1] === 'GBP'),
    'desired-vs-actual mismatch reported for 004');

  const a5 = result.applications.find(a => a.num === normalizeId('005'));
  assert(a5.advertised.currency === 'UNKNOWN' && a5.actual.currency === 'UNKNOWN', '005 both sides UNKNOWN currency');
  assert(a5.advToActPct === null, `005 UNKNOWN-vs-UNKNOWN adv->act pct must be null, got ${a5.advToActPct}`);
  assert(a5.desiredToActPct === null, `005 EUR-vs-UNKNOWN desired->act pct must be null, got ${a5.desiredToActPct}`);
  assert(mm.some(m => m.num === normalizeId('005') && m.comparison === 'advertised-vs-actual' && m.currencies[0] === 'UNKNOWN' && m.currencies[1] === 'UNKNOWN'),
    'UNKNOWN-vs-UNKNOWN skip reported for 005');
  assert(mm.some(m => m.num === normalizeId('005') && m.comparison === 'desired-vs-actual' && m.currencies[0] === 'EUR' && m.currencies[1] === 'UNKNOWN'),
    'known-vs-UNKNOWN skip reported for 005');
  const unk = result.aggregates.byCurrency.UNKNOWN;
  assert(unk.confirmed === 1 && unk.meanAdvToActPct === null && unk.atOrAboveAdvertised === 0 && unk.atOrAboveDesired === 0,
    'UNKNOWN bucket carries confirmed count only — no gap math from unproven currency');

  const eur = result.aggregates.byCurrency.EUR;
  assert(eur.confirmed === 2, 'EUR two confirmed actuals');
  assert(Math.abs(eur.meanAdvToActPct - (-5.41)) < 0.01, `EUR mean, got ${eur.meanAdvToActPct}`);
  assert(eur.atOrAboveAdvertised === 1, 'EUR one at/above advertised');
  assert(eur.atOrAboveDesired === 0, 'EUR none at/above desired');
  assert(result.aggregates.byCompanyRole['Acme|ML Eng'].confirmed === 1, 'company+role grouping');

  const legacyApps = { '101': { company: null, role: null }, '102': { company: null, role: null } };
  const legacyObs = parseObservations([
    '101\t2026-07-01\tactual\t80k\tEUR\toffer-letter\tlegacy report',
    '102\t2026-07-02\tactual\t85k\tEUR\tcontract\tlegacy report',
  ].join('\n'));
  const legacy = fold(legacyObs, legacyApps, null);
  const legacyKeys = Object.keys(legacy.aggregates.byCompanyRole);
  assert(!legacyKeys.includes('null|null'), 'no null|null bucket for legacy reports');
  assert(legacyKeys.includes('#101') && legacyKeys.includes('#102'), `legacy apps get per-application buckets, got ${legacyKeys.join(',')}`);
  assert(legacy.aggregates.byCompanyRole['#101'].confirmed === 1 && legacy.aggregates.byCompanyRole['#102'].confirmed === 1,
    'each legacy bucket counts its own confirmed actual');
  assert(legacy.aggregates.byCompanyRole['#101'].company === 'report #101' && legacy.aggregates.byCompanyRole['#101'].role !== null,
    'legacy bucket display fields render without null');

  assert(normalizeId('029') === '29' && normalizeId('29') === '29', 'padded and plain ids canonicalize together');
  assert(normalizeId(29) === '29', 'numeric input accepted');
  assert(normalizeId('*') === '*' && normalizeId('') === '', 'non-numeric ids pass through untouched');
  assert(normalizeId('0') === '0', 'zero survives normalization');

  const trackerRows = [
    { num: '1', company: 'Acme', role: 'Staff Engineer', report: '[029](../reports/029-acme-2026-01-01.md)', notes: '' },
    { num: '29', company: 'Globex', role: 'Principal Engineer', report: '', notes: 'recruiter-sourced' },
  ];
  const reportsByNum = new Map([
    ['29', reportToObservation(REPORT_FIXTURE_4351_029, '029', '2026-01-01')],
  ]);
  const mapped = mapTrackerToApps(trackerRows, reportsByNum);

  assert(mapped.apps['29'].company === 'Globex', 'a report-less tracker row still resolves, from the row itself');
  assert(mapped.apps['1'].company === 'Acme', 'a row that links a report keeps its own company');
  const advOn1 = mapped.observations.filter(o => o.num === '1' && o.type === 'advertised');
  assert(advOn1.length === 1 && advOn1[0].parsed.mid === 100000, "report 029's advertised figure attaches to tracker row 1");
  assert(!mapped.observations.some(o => o.num === '29' && o.type === 'advertised'), 'nothing from report 029 leaks onto tracker row 29');
  assert(mapped.ambiguousIds.length === 1 && mapped.ambiguousIds[0].num === '29' && mapped.ambiguousIds[0].linkedBy === '1',
    'the id that means two different applications is reported, not silently resolved');

  for (const written of ['29', '029']) {
    const obs = parseObservations(`${written}\t2026-01-05\tactual\t150k\tEUR\trecruiter-verbal\tGlobex`);
    const folded = fold(obs, mapped.apps, null);
    const globex = folded.applications.find(a => a.num === '29');
    const acme = folded.applications.find(a => a.num === '1');
    assert(folded.quality.orphans.length === 0, `tracker# written as "${written}" is not an orphan`);
    assert(globex && globex.company === 'Globex' && globex.actual.value === 150000,
      `tracker# written as "${written}" folds onto Globex`);
    assert(!acme || acme.actual === null, `tracker# written as "${written}" never puts Globex's figure on Acme`);
  }

  const unlinked = mapTrackerToApps(
    [{ num: '4', company: 'Initech', role: 'Platform', report: '', notes: '' }],
    new Map([['9', reportToObservation(REPORT_FIXTURE_001, '009', '2026-06-20')]]),
  );
  assert(unlinked.apps['9']?.company === 'Acme', 'an unlinked report still registers under its own number');
  assert(unlinked.apps['4']?.company === 'Initech', 'tracker rows survive alongside unlinked reports');
  const claimed = mapTrackerToApps(
    [{ num: '9', company: 'RowNine', role: 'Eng', report: '', notes: '' }],
    new Map([['9', reportToObservation(REPORT_FIXTURE_001, '009', '2026-06-20')]]),
  );
  assert(claimed.apps['9'].company === 'RowNine', 'a tracker row keeps an id an unlinked report also claims');

  const sortRows = [10, 9, 1].map(n => ({ num: String(n), company: `C${n}`, role: 'R', report: '', notes: '' }));
  const sortObs = parseObservations([10, 9, 1].map(n => `${n}\t2026-01-0${1}\tactual\t1k\tEUR\tcontract\t`).join('\n'));
  const sorted = fold(sortObs, mapTrackerToApps(sortRows, new Map()).apps, null);
  assert(sorted.applications.map(a => a.num).join(',') === '1,9,10', `unpadded ids sort numerically, got ${sorted.applications.map(a => a.num).join(',')}`);

  const dupRows = [
    { num: '1', company: 'Acme', role: 'Eng', report: '[5](../reports/005-acme-2026-01-01.md)', notes: '' },
    { num: '2', company: 'Acme', role: 'Eng (repost)', report: '[5](../reports/005-acme-2026-01-01.md)', notes: '' },
  ];
  const dup = mapTrackerToApps(dupRows, new Map([['5', reportToObservation(REPORT_FIXTURE_4351_029, '005', '2026-01-01')]]));
  const dupAdv = dup.observations.filter(o => o.type === 'advertised');
  assert(dupAdv.length === 1 && dupAdv[0].num === '1', `a shared report's figure attaches once, to the first row; got ${dupAdv.map(o => o.num).join(',') || 'none'}`);
  assert(dup.sharedReports.length === 1 && dup.sharedReports[0].report === '5' && dup.sharedReports[0].owner === '1'
    && dup.sharedReports[0].alsoLinkedBy.join(',') === '2', 'the second linking row is reported in sharedReports');
  assert(dup.apps['2']?.company === 'Acme', 'the second row is still an application in its own right');
  const dupFolded = fold(dup.observations, dup.apps, null);
  assert(dupFolded.applications.filter(a => a.advertised).length === 1, 'one posting is never counted as two advertised figures in the fold');
  assert(mapped.sharedReports.length === 0, 'a report linked from exactly one row is not reported as shared');

  const mislabelRows = [
    { num: '1', company: 'Acme', role: 'Eng', report: '[5](../reports/006-globex-2026-01-01.md)', notes: '' },
  ];
  const mislabelReports = new Map([
    ['5', reportToObservation(REPORT_FIXTURE_4351_029, '005', '2026-01-01')],
    ['6', reportToObservation(REPORT_FIXTURE_4368_006, '006', '2026-01-01')],
  ]);
  const mislabel = mapTrackerToApps(mislabelRows, mislabelReports);
  const advOnMislabeled = mislabel.observations.filter(o => o.num === '1' && o.type === 'advertised');
  assert(advOnMislabeled.length === 1, `a mismatched link attaches one advertised figure, not two; got ${advOnMislabeled.length}`);
  assert(advOnMislabeled[0].parsed.mid === 200000, `the link target's figure is the one joined, got ${advOnMislabeled[0].parsed.mid}`);
  assert(mislabel.mislabeledReports.length === 1 && mislabel.mislabeledReports[0].num === '1'
    && mislabel.mislabeledReports[0].label === '5' && mislabel.mislabeledReports[0].report === '6',
    `the conflicting label is reported separately, got ${JSON.stringify(mislabel.mislabeledReports)}`);
  assert(mislabel.apps['5']?.company === 'Acme', "the labelled-but-unlinked report keeps its own id");
  const mislabelFolded = fold(mislabel.observations, mislabel.apps, null);
  assert(mislabelFolded.applications.find(a => a.num === '1').advertised.value === 200000,
    'the fold sees only the target report on the mismatched row');

  for (const cell of ['[6](../reports/006-globex-2026-01-01.md)', '[006](../reports/006-globex-2026-01-01.md)',
    '../reports/006-globex-2026-01-01.md', '[report](../reports/006-globex-2026-01-01.md)']) {
    const agreed = mapTrackerToApps([{ num: '1', company: 'Acme', role: 'Eng', report: cell, notes: '' }], mislabelReports);
    assert(agreed.mislabeledReports.length === 0, `"${cell}" is not reported as mislabeled`);
    assert(agreed.observations.filter(o => o.num === '1' && o.type === 'advertised').length === 1,
      `"${cell}" attaches exactly one advertised figure to the row`);
  }

  const multiMislabel = fold([], { '1': { company: 'X', role: 'R' }, '2': { company: 'Y', role: 'R' } }, null);
  multiMislabel.quality.ambiguousIds = [];
  multiMislabel.quality.sharedReports = [];
  multiMislabel.quality.mislabeledReports = [{ num: '1', label: '5', report: '6' }, { num: '2', label: '8', report: '9' }];
  const mislabelPrinted = [];
  const realLogMislabel = console.log;
  console.log = (...parts) => { mislabelPrinted.push(parts.join(' ')); };
  try { printSummary(multiMislabel); } finally { console.log = realLogMislabel; }
  const m1 = mislabelPrinted.find(l => l.includes('#1: label says report 5'));
  const m2 = mislabelPrinted.find(l => l.includes('#2: label says report 8'));
  assert(m1 && m1.includes('points at report 6') && !m1.includes('report 9'), `#1's line names its own target, got: ${m1}`);
  assert(m2 && m2.includes('points at report 9') && !m2.includes('report 6'), `#2's line names its own target, got: ${m2}`);

  const links = extractTrackerReportLinks('[5](../reports/006-globex-2026-01-01.md)');
  assert(links.length === 1 && links[0].target === 6 && links[0].label === 5,
    `the link's target and label are both reported, got ${JSON.stringify(links)}`);
  assert(extractTrackerReportNumbers('[5](../reports/006-globex-2026-01-01.md)').join(',') === '5,6',
    'the membership helper still returns label and target, in that order');
  assert(extractTrackerReportLinks('', '[9](../reports/009-acme-2026-01-01.md)')[0]?.target === 9,
    'an empty Report cell still falls back to a report link in Notes');
  assert(extractTrackerReportLinks('[report](https://example.com/reports/006-x.md)').length === 0,
    'an absolute URL is not a local report link');

  const multiAmbig = fold([], { '7': { company: 'X', role: 'R' }, '9': { company: 'Y', role: 'R' } }, null);
  multiAmbig.quality.ambiguousIds = [{ num: '7', linkedBy: '3' }, { num: '9', linkedBy: '4' }];
  multiAmbig.quality.sharedReports = [];
  const printed = [];
  const realLog = console.log;
  console.log = (...parts) => { printed.push(parts.join(' ')); };
  try { printSummary(multiAmbig); } finally { console.log = realLog; }
  const line7 = printed.find(l => l.includes('#7: tracker row #7'));
  const line9 = printed.find(l => l.includes('#9: tracker row #9'));
  assert(line7 && line7.includes('re-point it to #3') && !line7.includes('#4'), `#7's remediation names row #3 only, got: ${line7}`);
  assert(line9 && line9.includes('re-point it to #4') && !line9.includes('#3'), `#9's remediation names row #4, not the first entry's row, got: ${line9}`);
  assert(!printed.some(l => /re-point it at tracker row/.test(l)), 'no single shared remediation line pointing every id at one row');

  const statedPad = parseObservations('029\t2026-07-01\tstated\t90k\tCAD\tuser\t\tpanel\tJane');
  assert(getStatedObservations(statedPad, '29').length === 1, 'stated lookup by plain id finds a padded row');
  assert(getStatedObservations(parseObservations('29\t2026-07-01\tstated\t90k\tCAD\tuser\t'), '029').length === 1,
    'stated lookup by padded id finds a plain row');

  const RELOC_REPORT_FIXTURE = `# Eval: Fictional Corp — Backend Eng

## Machine Summary

\`\`\`yaml
company: "Fictional Corp"
role: "Backend Eng"
advertised_comp: "60k CAD"
posting_location: "Halifax, NS"
\`\`\`
`;
  const relocReportObs = reportToObservation(RELOC_REPORT_FIXTURE, '050', '2026-09-01');
  assert(relocReportObs.postingLocation === 'Halifax, NS', 'reportToObservation extracts posting_location verbatim');
  assert(relocReportObs.observation?.postingLocation === 'Halifax, NS', 'the advertised observation retains its own report posting_location');
  const relocMapped = mapTrackerToApps(
    [{ num: '50', company: '', role: '', report: '[050](../reports/050-fictional-corp-2026-09-01.md)', notes: '' }],
    new Map([['50', relocReportObs]]),
  );
  assert(relocMapped.apps['50']?.postingLocation === 'Halifax, NS', 'mapTrackerToApps carries posting_location onto the owning tracker row');
  const relocShared = mapTrackerToApps([
    { num: '50', company: 'Fictional Corp', role: 'Backend Eng', report: '[050](../reports/050-fictional-corp-2026-09-01.md)', notes: '' },
    { num: '52', company: 'Other Corp', role: 'Other Eng', report: '[050](../reports/050-fictional-corp-2026-09-01.md)', notes: '' },
  ], new Map([['50', relocReportObs]]));
  assert(relocShared.apps['50']?.postingLocation === 'Halifax, NS', 'a shared report keeps its posting location on the owning row');
  assert(relocShared.apps['52']?.postingLocation === null, 'a later row sharing the report does not inherit its owner\'s posting location');
  const relocMappedNoReport = mapTrackerToApps([{ num: '51', company: 'Recruiter Co', role: 'Eng', report: '', notes: '' }], new Map());
  assert(relocMappedNoReport.apps['51']?.postingLocation === null, 'a report-less tracker row gets postingLocation: null, never undefined');

  const RELOC_FIXTURE = {
    'XX-FEDERAL': {
      jurisdiction_name: 'Testland — Federal', country: 'Testland', level: 'federal',
      brackets: [{ up_to: 50000, rate: 0.10 }, { up_to: null, rate: 0.20 }],
    },
    'XX-NORTH': {
      jurisdiction_name: 'North Testland', country: 'Testland', level: 'provincial',
      aliases: ['North Testland', ', NT', 'Testville'],
      tax_year: 2026,
      brackets: [{ up_to: 30000, rate: 0.05 }, { up_to: null, rate: 0.25 }],
    },
    'XX-SOUTH': {
      jurisdiction_name: 'South Testland', country: 'Testland', level: 'provincial',
      aliases: ['South Testland', ', ST', 'Southburg'],
      tax_year: 2026,
      brackets: [{ up_to: 100000, rate: 0.05 }],
    },
    'YY-OTHERCOUNTRY': {
      jurisdiction_name: 'Otherland', country: 'Otherland', level: 'provincial',
      aliases: ['Otherland'], brackets: [{ up_to: null, rate: 0.10 }],
    },
  };

  assert(bracketTax(RELOC_FIXTURE['XX-FEDERAL'].brackets, 40000) === 4000, '10% flat under first bracket');
  assert(bracketTax(RELOC_FIXTURE['XX-FEDERAL'].brackets, 60000) === 50000 * 0.10 + 10000 * 0.20, 'progressive across two brackets');
  assert(bracketTax(RELOC_FIXTURE['XX-FEDERAL'].brackets, 0) === 0, 'zero income -> zero tax');
  assert(bracketTax([], 1000) === null, 'empty brackets -> null, never zero-tax by accident');
  assert(bracketTax(null, 1000) === null, 'non-array brackets -> null');
  assert(bracketTax(RELOC_FIXTURE['XX-FEDERAL'].brackets, -1) === null, 'negative income -> null');
  assert(bracketTax([{ up_to: 100, rate: 'bogus' }], 50) === null, 'non-numeric rate -> null, never silently taxed at 0');
  assert(bracketTax([{ up_to: 100, rate: 0.1 }, { up_to: 50, rate: 0.2 }], 200) === null,
    'non-ascending brackets -> null, never silently mis-taxed');

  assert(matchJurisdiction('Testville, XX', RELOC_FIXTURE) === 'XX-NORTH', 'city alias matches its province');
  assert(matchJurisdiction('Someplace, NT', RELOC_FIXTURE) === 'XX-NORTH', 'abbreviation alias matches');
  assert(matchJurisdiction('Nowhere special', RELOC_FIXTURE) === null, 'no alias match -> null, not a guess');
  assert(matchJurisdiction('', RELOC_FIXTURE) === null, 'blank text -> null');
  assert(matchJurisdiction('Testville', null) === null, 'no table -> null');
  assert(matchJurisdiction('Testland Federal HQ', RELOC_FIXTURE) === null,
    'federal-level row is never matched directly (it carries no aliases)');
  const AMBIGUOUS_FIXTURE = {
    A: { level: 'provincial', aliases: ['Springfield'] },
    B: { level: 'provincial', aliases: ['Springfield'] },
  };
  assert(matchJurisdiction('Springfield', AMBIGUOUS_FIXTURE) === null,
    'two different jurisdictions sharing an alias -> null, never an arbitrary pick');

  {
    const rt = loadRelocationTable();
    assert(matchJurisdiction('Austin, TX (on-site)', rt) === null,
      '"on-site" never false-matches the ON abbreviation (case-sensitive, word-boundary)');
    assert(matchJurisdiction('Remote, Abu Dhabi', rt) === null,
      '"Abu" never false-matches the AB abbreviation (case-sensitive)');
    assert(matchJurisdiction('Abu Dhabi', rt) === null,
      'bare "Abu Dhabi" never false-matches AB either');
    assert(matchJurisdiction('Halifax, NS (in office on Fridays)', rt) === 'CA-NS',
      'a real province abbreviation (NS) wins outright over the "on" in "on Fridays" -- no ambiguity');
    assert(matchJurisdiction('Waterloo, Iowa', rt) === null,
      'Waterloo is also an Iowa city -- the Iowa context blocks the ON city-alias match');
    assert(matchJurisdiction('Hamilton, New Zealand', rt) === null,
      'Hamilton is also a New Zealand city -- that context blocks the ON city-alias match');
    assert(matchJurisdiction('Surrey, UK', rt) === null,
      'Surrey is also a UK city -- that context blocks the BC city-alias match');
    assert(matchJurisdiction('Halifax, NS', rt) === 'CA-NS', 'real "Halifax, NS" still resolves to CA-NS');
    assert(matchJurisdiction('Toronto, ON', rt) === 'CA-ON', 'real "Toronto, ON" still resolves to CA-ON');
    assert(matchJurisdiction('Vancouver, BC', rt) === 'CA-BC', 'real "Vancouver, BC" still resolves to CA-BC');
    assert(matchJurisdiction('Calgary, Alberta', rt) === 'CA-AB', 'real "Calgary, Alberta" still resolves to CA-AB');

    assert(matchJurisdiction('Hamilton, Quebec', rt) === null,
      'Hamilton is also a Quebec city -- the unseeded-province context blocks the ON city-alias match');
    assert(matchJurisdiction('Hamilton, QC', rt) === null,
      'the QC abbreviation blocks the ON city-alias match the same way the full name does');
    assert(matchJurisdiction('Victoria, Prince Edward Island', rt) === null,
      'Victoria, PEI still resolves to null (no colliding table city, unaffected by this fix)');
  }

  const reloc1 = computeRelocationAdjustment({ grossAnnual: 60000, homeCode: 'XX-NORTH', destCode: 'XX-SOUTH', jurisdictions: RELOC_FIXTURE });
  assert(reloc1.ok === true, 'valid relocation comparison succeeds');
  assert(reloc1.home.totalTax === 16000 && reloc1.home.takeHome === 44000, `home side math, got ${JSON.stringify(reloc1.home)}`);
  assert(reloc1.dest.totalTax === 10000 && reloc1.dest.takeHome === 50000, `dest side math, got ${JSON.stringify(reloc1.dest)}`);
  assert(reloc1.takeHomeDeltaAbs === 6000, `South keeps $6000 more take-home than North at the same gross, got ${reloc1.takeHomeDeltaAbs}`);
  assert(typeof reloc1.limitations === 'string' && reloc1.limitations.includes('Not financial or tax advice'),
    'result always carries the not-financial-advice disclaimer');
  assert(reloc1.grossAnnual === 60000, 'inputs are echoed back for transparency, not hidden behind the output');

  assert(computeRelocationAdjustment({ grossAnnual: 0, homeCode: 'XX-NORTH', destCode: 'XX-SOUTH', jurisdictions: RELOC_FIXTURE }).reason === 'no-gross-amount',
    'zero/missing gross -> honest failure reason');
  assert(computeRelocationAdjustment({ grossAnnual: 60000, homeCode: 'XX-NORTH', destCode: 'XX-NORTH', jurisdictions: RELOC_FIXTURE }).reason === 'same-jurisdiction',
    'same jurisdiction both sides -> same-jurisdiction, nothing to show');
  assert(computeRelocationAdjustment({ grossAnnual: 60000, homeCode: 'XX-NORTH', destCode: null, jurisdictions: RELOC_FIXTURE }).reason === 'no-jurisdiction-match',
    'unresolved destination code -> no-jurisdiction-match');
  assert(computeRelocationAdjustment({ grossAnnual: 60000, homeCode: 'XX-NORTH', destCode: 'YY-OTHERCOUNTRY', jurisdictions: RELOC_FIXTURE }).reason === 'cross-country-not-supported',
    'cross-country comparison is explicitly out of scope, not silently computed wrong');
  assert(computeRelocationAdjustment({ grossAnnual: 60000, homeCode: 'XX-NORTH', destCode: 'XX-SOUTH', jurisdictions: null }).reason === 'no-table',
    'missing table -> no-table');

  const relocApp = { advertised: { value: 60000, period: 'annual', postingLocation: 'Southburg, ST' } };
  const relocResult = relocationForApplication(relocApp, { jurisdictions: RELOC_FIXTURE, homeLocation: 'Testville, NT' });
  assert(relocResult?.ok === true && relocResult.dest.jurisdiction === 'South Testland', 'relocationForApplication resolves both sides from free text');
  assert(relocationForApplication({ postingLocation: 'stale earlier location', advertised: { value: 60000, period: 'annual', postingLocation: null } }, { jurisdictions: RELOC_FIXTURE, homeLocation: 'Testville, NT' }) === null,
    'no posting location -> null, not evaluated');
  assert(relocationForApplication({ advertised: null }, { jurisdictions: RELOC_FIXTURE, homeLocation: 'Testville, NT' }) === null,
    'no advertised figure -> null, not evaluated');
  assert(relocationForApplication(relocApp, { jurisdictions: RELOC_FIXTURE, homeLocation: null }) === null,
    'no resolvable home location -> null, not evaluated');
  assert(relocationForApplication(relocApp, { jurisdictions: null, homeLocation: 'Testville, NT' }) === null,
    'no table -> null, not evaluated');

  const realTable = loadRelocationTable();
  assert(realTable !== null, 'the real templates/jurisdiction-relocation-tax.yml loads');
  assert(realTable['CA-FEDERAL']?.level === 'federal', 'real table carries a CA-FEDERAL row');
  assert(realTable['CA-ON'] && realTable['CA-NS'] && realTable['CA-AB'] && realTable['CA-BC'],
    'real table carries the four seeded provinces');
  for (const [code, row] of Object.entries(realTable)) {
    assert(typeof row.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.as_of), `${code} carries a quoted YYYY-MM-DD as_of`);
    assert(Array.isArray(row.sources) && row.sources.length > 0, `${code} carries at least one source`);
    assert(typeof row.official_source?.url === 'string' && row.official_source.url.startsWith('https://'), `${code} carries an official_source.url`);
    assert(bracketTax(row.brackets, 75000) !== null, `${code}'s own brackets are well-formed (ascending, numeric rates)`);
  }
  const realHalifax = matchJurisdiction('Halifax, NS', realTable);
  const realToronto = matchJurisdiction('Toronto, ON', realTable);
  assert(realHalifax === 'CA-NS' && realToronto === 'CA-ON', 'real table resolves the issue #4694 example cities (Halifax NS, Toronto/Midland ON)');
  assert(realTable['CA-ON']?.currency === 'CAD' && realTable['CA-NS']?.currency === 'CAD',
    'every seeded real jurisdiction row declares its currency');
  const realReloc = computeRelocationAdjustment({
    grossAnnual: 60000, homeCode: realToronto, destCode: realHalifax, jurisdictions: realTable, currency: 'CAD',
  });
  assert(realReloc.ok === true && realReloc.dest.takeHome < realReloc.home.takeHome,
    `at the same $60k gross, NS's higher brackets leave less take-home than ON's — got ${JSON.stringify({ home: realReloc.home.takeHome, dest: realReloc.dest.takeHome })}`);

  const usdMismatch = computeRelocationAdjustment({
    grossAnnual: 150000, homeCode: realToronto, destCode: realHalifax, jurisdictions: realTable, currency: 'USD',
  });
  assert(usdMismatch.ok === false && usdMismatch.reason === 'currency-mismatch',
    `a USD gross figure against the CAD table must refuse, not silently tax as CAD, got ${JSON.stringify(usdMismatch)}`);
  const unknownMismatch = computeRelocationAdjustment({
    grossAnnual: 150000, homeCode: realToronto, destCode: realHalifax, jurisdictions: realTable, currency: 'UNKNOWN',
  });
  assert(unknownMismatch.ok === false && unknownMismatch.reason === 'currency-mismatch',
    'an UNKNOWN currency against a currency-bearing table row also refuses');
  const omittedMismatch = computeRelocationAdjustment({
    grossAnnual: 150000, homeCode: realToronto, destCode: realHalifax, jurisdictions: realTable,
  });
  assert(omittedMismatch.ok === false && omittedMismatch.reason === 'currency-mismatch',
    'no currency supplied at all is treated the same as UNKNOWN, never assumed to match');
  const caseInsensitiveMatch = computeRelocationAdjustment({
    grossAnnual: 60000, homeCode: realToronto, destCode: realHalifax, jurisdictions: realTable, currency: 'cad',
  });
  assert(caseInsensitiveMatch.ok === true, 'currency comparison is case-insensitive ("cad" matches "CAD")');

  console.log('salary-gap self-test OK (parser + report extraction + fold + aggregates + currency guard + relocation purchasing-power)');
}

const REPORT_FILE_RE = /^(\d{3})-.*-(\d{4}-\d{2}-\d{2})\.md$/;

export function mapTrackerToApps(rows, reportsByNum) {
  const apps = {};
  const observations = [];
  const linkedBy = new Map();
  const alsoLinkedBy = new Map();
  const mislabeled = [];

  for (const row of rows ?? []) {
    const id = normalizeId(row?.num);
    if (!/^\d+$/.test(id)) continue;
    let company = row.company || null;
    let role = row.role || null;
    let postingLocation = null;
    const seenReports = new Set();
    for (const link of extractTrackerReportLinks(row.report, row.notes)) {
      const rep = normalizeId(link.target);
      const label = link.label == null ? null : normalizeId(link.label);
      if (label !== null && label !== rep
        && !mislabeled.some(m => m.num === id && m.label === label && m.report === rep)) {
        mislabeled.push({ num: id, label, report: rep });
      }
      if (seenReports.has(rep)) continue;
      seenReports.add(rep);
      const report = reportsByNum.get(rep);
      if (!linkedBy.has(rep)) linkedBy.set(rep, id);
      const owner = linkedBy.get(rep);
      if (owner !== id) {
        if (!alsoLinkedBy.has(rep)) alsoLinkedBy.set(rep, []);
        if (!alsoLinkedBy.get(rep).includes(id)) alsoLinkedBy.get(rep).push(id);
      }
      if (!report) continue;
      if (!company) company = report.company || null;
      if (!role) role = report.role || null;
      if (!postingLocation && owner === id) postingLocation = report.postingLocation || null;
      if (report.observation && owner === id) observations.push({ ...report.observation, num: id });
    }
    apps[id] = { company: company || null, role: role || null, postingLocation: postingLocation || null };
  }

  for (const [rep, report] of reportsByNum) {
    if (linkedBy.has(rep) || Object.hasOwn(apps, rep)) continue;
    apps[rep] = { company: report.company || null, role: report.role || null, postingLocation: report.postingLocation || null };
    if (report.observation) observations.push({ ...report.observation, num: rep });
  }

  const ambiguousIds = [];
  for (const [rep, owner] of linkedBy) {
    if (owner !== rep && Object.hasOwn(apps, rep)) ambiguousIds.push({ num: rep, linkedBy: owner });
  }

  const sharedReports = [...alsoLinkedBy]
    .map(([report, others]) => ({ report, owner: linkedBy.get(report), alsoLinkedBy: others.sort(compareIds) }))
    .sort((a, b) => compareIds(a.report, b.report));

  return {
    apps, observations,
    ambiguousIds: ambiguousIds.sort((a, b) => compareIds(a.num, b.num)),
    sharedReports,
    mislabeledReports: mislabeled.sort((a, b) => compareIds(a.num, b.num) || compareIds(a.label, b.label)),
  };
}

function readReportsByNum() {
  const reportsByNum = new Map();
  if (!existsSync(REPORTS_DIR)) return reportsByNum;
  for (const file of readdirSync(REPORTS_DIR)) {
    const m = file.match(REPORT_FILE_RE);
    if (!m) continue;
    const [, num, date] = m;
    let content;
    try { content = readFileSync(join(REPORTS_DIR, file), 'utf-8'); } catch { continue; }
    const r = reportToObservation(content, num, date);
    reportsByNum.set(normalizeId(num), r ?? { company: null, role: null, observation: null });
  }
  return reportsByNum;
}

function readTrackerRows() {
  let trackerPath;
  try { trackerPath = resolveTrackerPath(CAREER_OPS); } catch { return null; }
  if (!trackerPath || !existsSync(trackerPath)) return null;
  let lines;
  try { lines = readFileSync(trackerPath, 'utf-8').split('\n'); } catch { return null; }
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push(row);
  }
  return rows;
}

function collectSources() {
  const reportsByNum = readReportsByNum();
  const rows = readTrackerRows();
  const observations = [];
  let apps = {};
  let ambiguousIds = [];
  let sharedReports = [];
  let mislabeledReports = [];

  if (rows) {
    const mapped = mapTrackerToApps(rows, reportsByNum);
    apps = mapped.apps;
    observations.push(...mapped.observations);
    ambiguousIds = mapped.ambiguousIds;
    sharedReports = mapped.sharedReports;
    mislabeledReports = mapped.mislabeledReports;
  } else {
    for (const [num, report] of reportsByNum) {
      apps[num] = { company: report.company || null, role: report.role || null, postingLocation: report.postingLocation || null };
      if (report.observation) observations.push({ ...report.observation, num });
    }
  }

  if (existsSync(OBS_PATH)) {
    observations.push(...parseObservations(readFileSync(OBS_PATH, 'utf-8')));
  }

  return { apps, observations, ambiguousIds, sharedReports, mislabeledReports };
}

function loadProfileDesired() {
  const profilePath = join(CAREER_OPS, 'config/profile.yml');
  if (!existsSync(profilePath)) return null;
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
    const comp = profile?.compensation;
    if (!comp?.target_range) return null;
    return { amount: String(comp.target_range), currency: comp.currency ? String(comp.currency) : null };
  } catch {
    return null;
  }
}

function loadProfileLocation() {
  const profilePath = join(CAREER_OPS, 'config/profile.yml');
  if (!existsSync(profilePath)) return null;
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
    const candidateLoc = profile?.candidate?.location;
    if (typeof candidateLoc === 'string' && candidateLoc.trim()) return candidateLoc.trim();
    const city = profile?.location?.city;
    return typeof city === 'string' && city.trim() ? city.trim() : null;
  } catch {
    return null;
  }
}

const fmtVal = (v) => (v >= 1000 && v % 500 === 0 ? `${v / 1000}k` : String(v));
const fmtEff = (e) => (e ? `${fmtVal(e.value)} ${e.currency || ''} (${e.source}, ${e.date})`.replace('  ', ' ') : '—');
const fmtPct = (p) => (p === null || p === undefined ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);
const daysOld = (date) => Math.max(0, Math.round((Date.now() - Date.parse(date)) / 86400000));
const fmtMoney = (v) => (Math.round(v / 100) * 100).toLocaleString('en-US');

function printSummary(result) {
  const { applications, aggregates, quality } = result;

  console.log('\nSALARY GAP — desired / advertised / actual\n');

  if (!applications.length) {
    console.log('  No compensation observations yet.');
    console.log('  Sources: reports/*.md Machine Summary `advertised_comp`,');
    console.log('  data/salary-observations.tsv, config/profile.yml compensation.target_range.');
  } else {
    console.log('  Per application:');
    for (const a of applications) {
      const who = [a.company, a.role].filter(Boolean).join(' — ') || '(unknown company/role)';
      console.log(`  #${a.num} ${who}`);
      console.log(`      desired    ${fmtEff(a.desired)}`);
      console.log(`      advertised ${fmtEff(a.advertised)}`);
      console.log(`      actual     ${fmtEff(a.actual)}`);
      if (a.advToActPct !== null || a.desiredToActPct !== null) {
        console.log(`      gap: advertised→actual ${fmtPct(a.advToActPct)}, desired→actual ${fmtPct(a.desiredToActPct)}`);
      }
      if (a.relocation?.ok) {
        const r = a.relocation;
        console.log(`      relocation: ~$${fmtMoney(r.home.takeHome)} take-home in ${r.home.jurisdiction} vs ~$${fmtMoney(r.dest.takeHome)} in ${r.dest.jurisdiction} (bracket-tax estimate only, not financial/tax advice)`);
      }
    }

    const currencies = Object.entries(aggregates.byCurrency);
    if (currencies.length) {
      console.log('\n  Aggregates (per currency — no FX conversion):');
      for (const [cur, agg] of currencies) {
        console.log(`  ${cur}: mean advertised→actual ${fmtPct(agg.meanAdvToActPct)}, median ${fmtPct(agg.medianAdvToActPct)}, at/above advertised ${agg.atOrAboveAdvertised}, at/above desired ${agg.atOrAboveDesired}`);
      }
    }
    const companyRoles = Object.entries(aggregates.byCompanyRole);
    if (companyRoles.length) {
      console.log('\n  By (company, role):');
      for (const [, agg] of companyRoles) {
        const gaps = agg.advToActPcts.length ? `, advertised→actual ${agg.advToActPcts.map(fmtPct).join(' / ')}` : '';
        console.log(`  ${agg.company} — ${agg.role}: ${agg.confirmed} confirmed actual${agg.confirmed === 1 ? '' : 's'}${gaps}`);
      }
    }
  }

  console.log('\n  Data quality:');
  if (quality.unparseable.length) {
    console.log(`  ⚠ ${quality.unparseable.length} unparseable amount${quality.unparseable.length === 1 ? '' : 's'} (excluded from all math):`);
    for (const u of quality.unparseable) console.log(`      #${u.num} ${u.type}: "${u.raw}"`);
  } else {
    console.log('  unparseable amounts: none');
  }
  if (quality.invalidSources.length) {
    console.log(`  ⚠ ${quality.invalidSources.length} observation${quality.invalidSources.length === 1 ? '' : 's'} with unrecognized source (excluded from effective values — check for typos, e.g. recruiter_verbal vs recruiter-verbal):`);
    for (const s of quality.invalidSources) console.log(`      #${s.num} ${s.type}: source "${s.source}"`);
  } else {
    console.log('  unrecognized sources: none');
  }
  if (quality.orphans.length) {
    console.log(`  ⚠ ${quality.orphans.length} orphaned tracker#${quality.orphans.length === 1 ? '' : 's'} (no tracker row carries that number — renumbering/dedup can strand them):`);
    for (const o of quality.orphans) console.log(`      #${o.num} (${o.count} observation${o.count === 1 ? '' : 's'})`);
  } else {
    console.log('  orphaned observations: none');
  }
  if (quality.ambiguousIds?.length) {
    console.log(`  ⚠ ${quality.ambiguousIds.length} id${quality.ambiguousIds.length === 1 ? '' : 's'} mean${quality.ambiguousIds.length === 1 ? 's' : ''} two different applications (column 1 is a tracker#, so these resolve to the tracker row):`);
    for (const a of quality.ambiguousIds) {
      console.log(`      #${a.num}: tracker row #${a.num}, but report ${a.num} belongs to tracker row #${a.linkedBy} — if an older observation on #${a.num} meant the report, re-point it to #${a.linkedBy}`);
    }
  }
  if (quality.sharedReports?.length) {
    console.log(`  ⚠ ${quality.sharedReports.length} report${quality.sharedReports.length === 1 ? ' is' : 's are'} linked from more than one tracker row (its advertised figure is counted once, on the first row):`);
    for (const s of quality.sharedReports) {
      console.log(`      report ${s.report}: counted on #${s.owner}, also linked from ${s.alsoLinkedBy.map(n => `#${n}`).join(', ')}`);
    }
  }
  if (quality.mislabeledReports?.length) {
    const n = quality.mislabeledReports.length;
    console.log(`  ⚠ ${n} Report link${n === 1 ? '' : 's'} name${n === 1 ? 's' : ''} a different report than ${n === 1 ? 'it points' : 'they point'} at (the link target is the report that was joined; the label was not):`);
    for (const m of quality.mislabeledReports) {
      console.log(`      #${m.num}: label says report ${m.label}, link points at report ${m.report} — joined report ${m.report}; fix the label or re-point the link`);
    }
  }
  if (quality.currencyMismatches.length) {
    console.log(`  ⚠ ${quality.currencyMismatches.length} cross-currency comparison${quality.currencyMismatches.length === 1 ? '' : 's'} skipped (no FX conversion — excluded from all gap math):`);
    for (const m of quality.currencyMismatches) console.log(`      #${m.num} ${m.comparison}: ${m.currencies[0]} vs ${m.currencies[1]}`);
  } else {
    console.log('  cross-currency comparisons skipped: none');
  }
  const currencies = Object.entries(result.aggregates.byCurrency);
  if (currencies.length) {
    for (const [cur, agg] of currencies) {
      console.log(`  ${cur}: n=${agg.confirmed} confirmed actual${agg.confirmed === 1 ? '' : 's'}, newest ${agg.newestActual} (${daysOld(agg.newestActual)} days old)`);
    }
  } else {
    console.log('  confirmed actuals: none in any currency');
  }
  console.log(`  applications without a confirmed actual: ${quality.withoutActual} of ${applications.length}`);
  console.log('');
}

function main() {
  if (selfTestMode) { selfTest(); return; }

  if (statedForFlagIdx !== -1) {
    if (!statedForNum) {
      console.error('Usage: node salary-gap.mjs --stated-for <tracker#>');
      process.exit(1);
    }
    const { observations } = collectSources();
    const stated = getStatedObservations(observations, statedForNum);
    console.log(JSON.stringify({ num: statedForNum, stated }, null, 2));
    return;
  }

  if (relocationMode) {
    const gross = relocGrossRaw !== undefined ? parseAmount(relocGrossRaw)?.mid ?? null : null;
    let postingLocation = relocPostingLocation;
    if (relocPostingLocationFileFlagPresent) {
      if (!relocPostingLocationFile || relocPostingLocationFile.startsWith('-')) {
        console.error(
          `Usage: --posting-location-file requires a file path operand (got ${
            relocPostingLocationFile ? `'${relocPostingLocationFile}', which looks like another flag` : 'none'
          })`
        );
        process.exit(1);
      }
      try {
        postingLocation = readFileSync(relocPostingLocationFile, 'utf-8').trim();
      } catch (err) {
        console.error(`Could not read --posting-location-file '${relocPostingLocationFile}': ${err.message}`);
        process.exit(1);
      }
    }
    if (gross === null || !postingLocation) {
      console.error('Usage: node salary-gap.mjs --relocation --gross <amount> (--posting-location "<city, province>" | --posting-location-file <path>) [--home-location "<city, province>"] [--currency <code>]');
      process.exit(1);
    }
    const jurisdictions = loadRelocationTable();
    const homeLocation = relocHomeLocationFlag ?? loadProfileLocation();
    const homeCode = matchJurisdiction(homeLocation, jurisdictions);
    const destCode = matchJurisdiction(postingLocation, jurisdictions);
    const result = computeRelocationAdjustment({
      grossAnnual: gross, homeCode, destCode, jurisdictions, currency: relocCurrency,
    });
    console.log(JSON.stringify({
      inputs: {
        grossAnnual: gross, currency: relocCurrency,
        homeLocation, postingLocation, homeCode, destCode,
      },
      ...result,
    }, null, 2));
    return;
  }

  const { apps, observations, ambiguousIds, sharedReports, mislabeledReports } = collectSources();
  const result = fold(observations, apps, loadProfileDesired());
  result.quality.ambiguousIds = ambiguousIds ?? [];
  result.quality.sharedReports = sharedReports ?? [];
  result.quality.mislabeledReports = mislabeledReports ?? [];

  {
    const jurisdictions = loadRelocationTable();
    const homeLocation = loadProfileLocation();
    for (const a of result.applications) {
      a.relocation = relocationForApplication(a, { jurisdictions, homeLocation });
    }
  }

  if (summaryMode) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
