import { fetchJsonWithRetry, sleep } from './_http.mjs';

const CAREERS_HOST = 'ats.rippling.com';
const API_BASE = `https://${CAREERS_HOST}/api/v2/board`;
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

const PAGE_SIZE = 1000;

const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_CAP = 50;

const INTER_PAGE_DELAY_MS = 200;

const RETRY_POLICY = { retries: 2 };

const STOP_REASON = {
  COMPLETE: 'complete',
  CAP: 'cap',
  FETCH_ERROR: 'fetch-error',
};

function resolveSlug(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== CAREERS_HOST) return null;
  const segment = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!SLUG_RE.test(segment)) return null;
  return segment;
}

function apiUrlForSlug(slug, page) {
  const encodedSlug = encodeURIComponent(slug);
  const apiUrl = new URL(`${API_BASE}/${encodedSlug}/jobs`);
  apiUrl.searchParams.set('page', String(page));
  apiUrl.searchParams.set('pageSize', String(PAGE_SIZE));
  return apiUrl.href;
}

function assertRipplingApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`rippling: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`rippling: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== CAREERS_HOST) {
    throw new Error(`rippling: untrusted hostname "${parsed.hostname}" — must be ${CAREERS_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export function parseRipplingPage(json, companyName) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`rippling: unexpected response — expected items[], got: [${got}]`);
  }
  const rawCount = json.items.length;
  const jobs = json.items
    .map((j) => {
      const title = typeof j?.name === 'string' ? j.name.trim() : '';
      if (!title) return null;

      let url = '';
      const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'https:' && parsed.hostname === CAREERS_HOST) url = parsed.href;
        } catch {
        }
      }
      if (!url) return null;

      const locs = Array.isArray(j?.locations) ? j.locations : [];
      const location = locs
        .map((l) => (l && typeof l.name === 'string' ? l.name.trim() : ''))
        .filter(Boolean)
        .join(' · ');

      return { title, url, location, company: companyName };
    })
    .filter(Boolean);
  return { jobs, rawCount };
}

export default {
  id: 'rippling',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: apiUrlForSlug(slug, 0) } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`rippling: cannot derive API URL for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const ctxCap = ctxMaxPages > 0 ? ctxMaxPages : Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);
    const probing = ctxCap !== Infinity;

    const jobs = [];
    let stopReason = STOP_REASON.COMPLETE;
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = apiUrlForSlug(slug, page);
      assertRipplingApiUrl(url);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' }, RETRY_POLICY);
      } catch (err) {
        if (probing) throw err;
        const attempts = err?.attempts ?? RETRY_POLICY.retries + 1;
        console.error(`⚠️  rippling: ${entry.name} truncated at page ${page + 1} of ${pagesToFetch} after ${attempts} attempts (${jobs.length} jobs): ${err.message}`);
        stopReason = STOP_REASON.FETCH_ERROR;
        break;
      }

      const { jobs: pageJobs, rawCount } = parseRipplingPage(json, entry.name);
      jobs.push(...pageJobs);

      if (rawCount < PAGE_SIZE) break;
    }

    if (stopReason === STOP_REASON.COMPLETE && page === pagesToFetch && pagesToFetch === maxPages) {
      stopReason = STOP_REASON.CAP;
      console.error(`⚠️  rippling: ${entry.name} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }

    return jobs;
  },
};
