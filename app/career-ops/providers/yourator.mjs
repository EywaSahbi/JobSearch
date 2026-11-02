import { sleep } from './_http.mjs';

const SITE_ORIGIN = 'https://www.yourator.co';
const FEED_BASE = `${SITE_ORIGIN}/api/v4/jobs`;
const TRUSTED_HOST = 'www.yourator.co';
const DEFAULT_MAX_PAGES = 120;
const MAX_PAGES_CAP = 500;
const PAGE_DELAY_MS = 200;

function assertYouratorUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`yourator: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`yourator: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`yourator: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export function resolveYouratorUrl(j) {
  const raw = typeof j.thirdPartyUrl === 'string' ? j.thirdPartyUrl.trim() : '';
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:') {
        for (const key of [...parsed.searchParams.keys()]) {
          if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
        }
        return parsed.href;
      }
    } catch {
    }
  }

  const rawPath = typeof j.path === 'string' ? j.path.trim() : '';
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.startsWith('/\\')) return '';
  try {
    const parsed = new URL(rawPath, SITE_ORIGIN);
    if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) return parsed.href;
  } catch {
  }
  return '';
}

export function normalizeYouratorJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.name === 'string' ? j.name.trim() : '';
  if (!title) return null;

  const url = resolveYouratorUrl(j);
  if (!url) return null;

  const brand = typeof j.company?.brand === 'string' ? j.company.brand.trim() : '';
  const company = brand || fallbackCompany || 'Yourator';
  const location = typeof j.location === 'string' ? j.location.trim() : '';

  return { title, url, company, location };
}

export default {
  id: 'yourator',

  async fetch(entry, ctx) {
    assertYouratorUrl(FEED_BASE);
    const maxPages = Math.min(resolveMaxPages(entry), ctx?.maxPages ?? Number.POSITIVE_INFINITY);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = `${FEED_BASE}?page=${page}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      const jobs = json?.payload?.jobs;
      if (!Array.isArray(jobs)) {
        throw new Error(
          `yourator: unexpected API response on page ${page} — expected { payload: { jobs: [...] } }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of jobs) {
        const normalized = normalizeYouratorJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.payload.hasMore !== true) break;
      if (page < maxPages) {
        await sleep(PAGE_DELAY_MS, ctx);
      }
    }
    return out;
  },
};
