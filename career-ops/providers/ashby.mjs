import { fetchJsonWithRetry } from './_http.mjs';
import { coerceId } from './_ids.mjs';

const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;
const ASHBY_BACKOFF_BASE_MS = 1_000;

const INTERVAL_MULTIPLIERS = {
  '1 HOUR': 2080,
  '1 DAY': 260,
  '1 WEEK': 52,
  '2 WEEK': 26,
  '0.5 MONTH': 24,
  '1 MONTH': 12,
  '2 MONTH': 6,
  '3 MONTH': 4,
  '6 MONTH': 2,
  '1 YEAR': 1,
};

export function parseCompensation(job) {
  const comp = job?.compensation;
  if (!comp) return null;

  const normalizeNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  let source = comp;
  let nested = false;
  const components = (Array.isArray(comp.compensationTiers) ? comp.compensationTiers : [])
    .flatMap((tier) => (Array.isArray(tier?.components) ? tier.components : []));
  if (components.length) {
    const salaryComponents = components.filter(
      (c) => String(c?.compensationType ?? '').toLowerCase() === 'salary',
    );
    if (!salaryComponents.length) return null;
    const withRange = salaryComponents.filter(
      (c) => normalizeNum(c?.minValue) != null || normalizeNum(c?.maxValue) != null,
    );
    if (!withRange.length) return null;
    const readable = (c) => {
      const raw = c?.interval;
      return typeof raw === 'string'
        && raw.trim() !== ''
        && Object.hasOwn(INTERVAL_MULTIPLIERS, raw);
    };
    const candidates = withRange.filter(readable);
    if (!candidates.length) return null;
    source = candidates.reduce((best, c) => {
      const span = (normalizeNum(c?.maxValue) ?? normalizeNum(c?.minValue) ?? 0)
        - (normalizeNum(c?.minValue) ?? normalizeNum(c?.maxValue) ?? 0);
      const bestSpan = (normalizeNum(best?.maxValue) ?? normalizeNum(best?.minValue) ?? 0)
        - (normalizeNum(best?.minValue) ?? normalizeNum(best?.maxValue) ?? 0);
      return span > bestSpan ? c : best;
    }, candidates[0]);
    nested = true;
  }

  const rawInterval = nested ? source.interval : (source.interval || comp.interval || '1 YEAR');
  if (typeof rawInterval !== 'string' || !rawInterval.trim()) return null;
  const interval = (rawInterval);
  const multiplier = INTERVAL_MULTIPLIERS[interval];
  if (!multiplier) return null;

  const minValue = normalizeNum(source.minValue ?? comp.minValue);
  const maxValue = normalizeNum(source.maxValue ?? comp.maxValue);
  const rawCurrency = source.currencyCode ?? source.currency ?? comp.currency;
  const currency = typeof rawCurrency === 'string' ? rawCurrency.trim() : '';

  if (minValue == null && maxValue == null) return null;

  const min = minValue != null ? minValue * multiplier : null;
  const max = maxValue != null ? maxValue * multiplier : null;

  if (min == null && max == null) return null;

  const resolvedMin = (min ?? max);
  const resolvedMax = (max ?? min);
  return {
    min: Math.min(resolvedMin, resolvedMax),
    max: Math.max(resolvedMin, resolvedMax),
    currency: currency.toUpperCase(),
  };
}

const ALLOWED_ASHBY_HOSTS = new Set(['api.ashbyhq.com']);

function assertAshbyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ashby: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ashby: URL must use HTTPS: ${url}`);
  if (!ALLOWED_ASHBY_HOSTS.has(parsed.hostname))
    throw new Error(`ashby: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_ASHBY_HOSTS].join(', ')}`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) {
    assertAshbyUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function containsWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function formatLocation(j) {
  const parts = [];
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim());
  const primaryPa = j.address && j.address.postalAddress;
  if (primaryPa) {
    for (const k of ['addressLocality', 'addressCountry']) {
      const v = typeof primaryPa[k] === 'string' ? primaryPa[k].trim() : '';
      if (!v) continue;
      if (k === 'addressCountry' && parts.some((p) => containsWholeWord(p, v))) continue;
      parts.push(v);
    }
  }
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.location === 'string' && s.location.trim()) parts.push(s.location.trim());
      const pa = s.address && s.address.postalAddress;
      if (pa) {
        for (const k of ['addressLocality', 'addressCountry']) {
          if (typeof pa[k] === 'string' && pa[k].trim()) parts.push(pa[k].trim());
        }
      }
    }
  }
  const wt = typeof j.workplaceType === 'string' ? j.workplaceType.trim().toLowerCase() : '';
  const isRemote = wt ? wt === 'remote' : j.isRemote === true;
  if (isRemote && !parts.some((p) => /remote/i.test(p))) parts.push('Remote');
  return [...new Set(parts)].join(' · ');
}

export default {
  id: 'ashby',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    assertAshbyUrl(apiUrl);
    const json = (await fetchJsonWithRetry(
      ctx,
      apiUrl,
      { timeoutMs: ASHBY_TIMEOUT_MS, redirect: 'error' },
      { retries: ASHBY_RETRIES, baseDelayMs: ASHBY_BACKOFF_BASE_MS },
    ));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map((j) => ({
      title: j.title || '',
      url: j.jobUrl || '',
      company: entry.name,
      externalId: coerceId(j.id),
      location: formatLocation(j),
      description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
      salary: parseCompensation(j),
      postedAt: toEpochMs(j.publishedAt),
    }));
  },
};
