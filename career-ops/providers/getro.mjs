import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, fetchTextWithRetry, sleep } from './_http.mjs';

function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const API_BASE = 'https://api.getro.com/api/v2/collections';
const HITS_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 1500;
const DEFAULT_MAX_AGE_DAYS = 90;

const INTER_PAGE_DELAY_MS = 250;

function resolveCollectionOverride(entry) {
  const id = entry.getro_collection;
  if (id == null) return null;
  const s = String(id).trim();
  if (!/^\d+$/.test(s) || !/[1-9]/.test(s)) return null;
  return s;
}

function resolveCareersUrl(entry) {
  let parsed;
  try {
    parsed = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' ? parsed : null;
}

export function extractCollectionId(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<script\b[^>]*\sid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const id = data?.props?.pageProps?.network?.id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return id;
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return String(id);
  return null;
}

async function resolveCollectionId(entry, ctx, careersUrl) {
  const override = resolveCollectionOverride(entry);
  if (override) return override;

  const label = entry?.name || careersUrl.href;
  const html = await fetchTextWithRetry(ctx, careersUrl.href, {
    redirect: 'error',
    headers: { accept: 'text/html', 'user-agent': BROWSER_LIKE_USER_AGENT },
  });
  const id = extractCollectionId(html);
  if (!id) {
    throw new Error(
      `getro: ${label} — could not resolve collection_id from ${careersUrl.href} (no network.id found in ` +
      `__NEXT_DATA__; page structure may have changed — set getro_collection: N on this entry as a fallback)`,
    );
  }
  return id;
}

function getroSalary(job) {
  const period = typeof job?.compensation_period === 'string' ? job.compensation_period.trim().toLowerCase() : '';
  if (period && period !== 'year') return null;
  const minCents = Number(job?.compensation_amount_min_cents);
  const maxCents = Number(job?.compensation_amount_max_cents);
  const min = Number.isFinite(minCents) && minCents > 0 ? minCents / 100 : null;
  const max = Number.isFinite(maxCents) && maxCents > 0 ? maxCents / 100 : null;
  if (min === null && max === null) return null;
  const currency = typeof job?.compensation_currency === 'string' ? job.compensation_currency.trim() : '';
  return { min: min ?? max, max: max ?? min, currency };
}

function locationString(job) {
  const fromArray = (arr) => (Array.isArray(arr) ? arr.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim()) : []);
  const primary = fromArray(job.locations);
  let parts = primary.length > 0 ? primary : fromArray(job.searchable_locations);
  if (job.work_mode === 'remote' && !parts.some((l) => /remote/i.test(l))) {
    parts = [...parts, 'Remote'];
  }
  return parts.join(', ');
}

export default {
  id: 'getro',

  detect(entry) {
    const id = resolveCollectionOverride(entry);
    return id ? { url: `${API_BASE}/${id}/search/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const careersUrl = resolveCareersUrl(entry);
    if (!careersUrl) throw new Error(`getro: ${entry.name} needs an https careers_url`);

    const collectionId = await resolveCollectionId(entry, ctx, careersUrl);
    const apiUrl = `${API_BASE}/${collectionId}/search/jobs`;

    const requestedMaxPages = Number.isInteger(entry.getro_max_pages) && entry.getro_max_pages > 0
      ? Math.min(entry.getro_max_pages, HARD_MAX_PAGES) : DEFAULT_MAX_PAGES;
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const maxPages = Math.min(requestedMaxPages, ctxCap);

    const maxAgeDays = Number.isFinite(entry.getro_max_age_days) && entry.getro_max_age_days >= 0
      ? entry.getro_max_age_days : DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;

    const out = [];
    let total = Infinity;
    for (let page = 0; page < maxPages && page * HITS_PER_PAGE < total; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, apiUrl, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            referer: `${careersUrl.origin}/`,
          },
          body: JSON.stringify({ hitsPerPage: HITS_PER_PAGE, page, filters: { page }, query: '' }),
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        if (page === 0) {
          throw err instanceof Error ? err : new Error(cause);
        }
        console.error(`⚠️  getro: ${entry.name || collectionId} truncated at page ${page} after retries (${out.length} jobs): ${cause}`);
        break;
      }

      const results = json?.results || {};
      const jobs = Array.isArray(results.jobs) ? results.jobs : [];
      if (typeof results.count === 'number') total = results.count;
      if (jobs.length === 0) break;

      let reachedOld = false;
      for (const j of jobs) {
        const url = j.url || '';
        if (!url) continue;
        const createdMs = toEpochMs(j.created_at);
        if (cutoffMs > 0 && createdMs != null && createdMs < cutoffMs) {
          reachedOld = true;
          continue;
        }
        const row = {
          title: j.title || '',
          url,
          company: j.organization?.name || j.organization_name || entry.name,
          location: locationString(j),
          postedAt: createdMs,
        };
        const salary = getroSalary(j);
        if (salary) row.salary = salary;
        out.push(row);
      }
      if (reachedOld) break;
    }
    return out;
  },
};
