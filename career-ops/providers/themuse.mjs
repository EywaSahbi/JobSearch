import { sleep } from './_http.mjs';

const FEED_BASE = 'https://www.themuse.com/api/public/jobs';
const TRUSTED_HOST = 'www.themuse.com';

const MAX_PAGES = 100;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

const INTER_PAGE_DELAY_MS = 250;

function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableError(err) {
  const status = err?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return status === undefined;
}

async function fetchPageWithRetry(ctx, url, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ctx.fetchJson(url, opts);
    } catch (err) {
      lastErr = err;
      lastErr.attempts = attempt + 1;
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw lastErr;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const retryAfterMs = parseRetryAfterMs(err?.retryAfter);
      const delayMs = retryAfterMs !== null ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS * 4) : (backoff + Math.random() * 250);
      await sleep(delayMs, ctx);
    }
  }
  throw lastErr;
}

function assertMuseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`themuse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`themuse: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`themuse: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

export function normalizeMuseJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = typeof j.name === 'string' ? j.name.trim() : '';
  if (!title) return null;
  const url = typeof j.refs?.landing_page === 'string' ? j.refs.landing_page.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const company =
    typeof j.company?.name === 'string' && j.company.name.trim()
      ? j.company.name.trim()
      : 'The Muse';
  const location =
    Array.isArray(j.locations) && j.locations.length > 0 && typeof j.locations[0]?.name === 'string'
      ? j.locations[0].name.trim()
      : '';
  return { title, url, company, location };
}

export default {
  id: 'themuse',

  async fetch(_entry, ctx) {
    assertMuseUrl(FEED_BASE);

    const firstUrl = `${FEED_BASE}?page=0`;
    const first = await fetchPageWithRetry(ctx, firstUrl, { redirect: 'error' });
    if (!first || !Array.isArray(first.results)) {
      throw new Error(
        `themuse: unexpected API response on page 0 — expected { results: [...] }, got keys: [${first ? Object.keys(first).join(', ') : 'null'}]`,
      );
    }
    const allResults = [...first.results];
    const pageCount = Number.isInteger(first.page_count) && first.page_count > 1
      ? Math.min(first.page_count, MAX_PAGES)
      : 1;

    for (let page = 1; page < pageCount; page++) {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${FEED_BASE}?page=${page}`;
      let json;
      try {
        json = await fetchPageWithRetry(ctx, url, { redirect: 'error' });
        if (!json || !Array.isArray(json.results)) {
          throw new Error(
            `themuse: unexpected API response on page ${page} — expected { results: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
          );
        }
      } catch (err) {
        const attempts = Number.isInteger(err?.attempts) ? err.attempts : 1;
        console.error(`⚠️  themuse: truncated at page ${page} of ${pageCount} after ${attempts} attempt${attempts === 1 ? '' : 's'} (${allResults.length} jobs gathered so far): ${err.message}`);
        break;
      }
      allResults.push(...json.results);
    }
    return allResults.map(normalizeMuseJob).filter(Boolean);
  },
};
