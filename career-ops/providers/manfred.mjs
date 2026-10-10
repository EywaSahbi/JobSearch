import { safeEncodeURIComponent } from './_safe-url.mjs';
import { fetchJsonWithRetry } from './_http.mjs';

const FEED_BASE = 'https://www.getmanfred.com/api/v2/public/offers';
const FETCH_TIMEOUT_MS = 25_000;
const TRUSTED_HOST = 'www.getmanfred.com';
const OFFER_BASE = 'https://www.getmanfred.com/ofertas-empleo';
const VALID_LANGS = ['EN', 'ES'];
const DEFAULT_LANG = 'EN';

function assertManfredUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`manfred: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`manfred: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`manfred: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

export function resolveLang(entry) {
  const raw = typeof entry?.lang === 'string' ? entry.lang.trim().toUpperCase() : '';
  return VALID_LANGS.includes(raw) ? raw : DEFAULT_LANG;
}

const CURRENCY_BY_SYMBOL = new Map([
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['US$', 'USD'],
  ['$', 'USD'],
  ['MXN$', 'MXN'],
]);

export function normalizeCurrency(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\s  ]/g, '').toUpperCase();
  for (const [symbol, iso] of CURRENCY_BY_SYMBOL) {
    if (cleaned === symbol.toUpperCase()) return iso;
  }
  return /^[A-Z]{3}$/.test(cleaned) ? cleaned : '';
}

function buildFeedUrl(entry) {
  return `${FEED_BASE}?lang=${resolveLang(entry)}`;
}

export function parseCompensation(offer) {
  const from = Number(offer?.salaryFrom);
  const to = Number(offer?.salaryTo);
  const min = Number.isFinite(from) && from > 0 ? from : null;
  const max = Number.isFinite(to) && to > 0 ? to : null;
  if (min === null && max === null) return null;
  return {
    min: min ?? (max),
    max: max ?? (min),
    currency: normalizeCurrency(offer?.currency),
  };
}

export function resolveLocation(offer) {
  const listed = Array.isArray(offer?.locations)
    ? offer.locations.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : [];
  if (listed.length > 0) return listed.join(', ');

  const remote = Number(offer?.remotePercentage);
  if (!Number.isFinite(remote)) return '';
  if (remote >= 100) return 'Remote';
  if (remote > 0) return 'Hybrid';
  return '';
}

export function normalizeManfredOffer(offer, fallbackCompany) {
  if (!offer || typeof offer !== 'object') return null;
  if (offer.status !== 'ACTIVE') return null;

  const title = typeof offer.position === 'string' ? offer.position.trim() : '';
  if (!title) return null;

  const id = Number(offer.id);
  const slug = typeof offer.slug === 'string' ? offer.slug.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !slug) return null;
  const encodedSlug = safeEncodeURIComponent(slug);
  if (encodedSlug === null) return null;
  const url = `${OFFER_BASE}/${id}/${encodedSlug}`;

  const company =
    typeof offer.company?.name === 'string' && offer.company.name.trim()
      ? offer.company.name.trim()
      : fallbackCompany || 'getManfred';

  const job = { title, url, company, location: resolveLocation(offer) };
  const salary = parseCompensation(offer);
  if (salary) job.salary = salary;
  return job;
}

export default {
  id: 'manfred',

  detect(entry) {
    return entry?.provider === 'manfred' ? { url: buildFeedUrl(entry) } : null;
  },

  async fetch(entry, ctx) {
    const url = assertManfredUrl(buildFeedUrl(entry));
    const json = (
      await fetchJsonWithRetry(ctx, url, { redirect: 'error', timeoutMs: FETCH_TIMEOUT_MS })
    );
    if (!Array.isArray(json)) {
      throw new Error(
        `manfred: unexpected API response — expected a JSON array of offers, got ${json === null ? 'null' : typeof json}`,
      );
    }
    const fallbackCompany = entry?.name;
    const out = [];
    for (const offer of json) {
      const normalized = normalizeManfredOffer(offer, fallbackCompany);
      if (normalized) out.push(normalized);
    }
    return out;
  },
};
