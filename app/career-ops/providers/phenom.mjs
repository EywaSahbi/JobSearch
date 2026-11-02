import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const PAGE_SIZE = 100;

const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 300;

const PAGE_DELAY_MS = 150;

export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const block = entry.phenom && typeof entry.phenom === 'object' ? entry.phenom : {};
  const urlPrefix = String(block.urlPrefix || 'global/en').replace(/^\/+|\/+$/g, '');
  return {
    origin: u.origin,
    widgetsApi: `${u.origin}/widgets`,
    lang: typeof block.lang === 'string' ? block.lang : 'en_global',
    country: typeof block.country === 'string' ? block.country : 'global',
    urlPrefix,
    selectedFields: block.selectedFields && typeof block.selectedFields === 'object' ? block.selectedFields : {},
  };
}

export function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'job';
}

export function parsePhenomDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

export function jobLocation(job) {
  const direct = decodeEntities(String(job?.location || job?.cityStateCountry || job?.cityState || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  const parts = [job?.city, job?.state, job?.country].map((p) => String(p || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

export function parseRefineSearch(json, cfg) {
  const rs = json?.refineSearch;
  const total = typeof rs?.totalHits === 'number' ? rs.totalHits : null;
  const list = Array.isArray(rs?.data?.jobs) ? rs.data.jobs : [];
  const rows = [];
  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    const id = job.jobId != null ? String(job.jobId) : '';
    const title = decodeEntities(String(job.title || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    const encodedId = safeEncodeURIComponent(id);
    if (encodedId === null) continue;
    rows.push({
      id,
      title,
      url: `${cfg.origin}/${cfg.urlPrefix}/job/${encodedId}/${slugify(title)}`,
      location: jobLocation(job),
      postedAt: parsePhenomDate(job.postedDate || job.dateCreated),
    });
  }
  return { total, rows };
}

export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export default {
  id: 'phenom',

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`phenom: cannot resolve origin for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);
    const jobs = [];
    const seen = new Set();
    let total = null;

    let stopReason = 'complete';
    let page = 0;
    let anyPageSucceeded = false;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, cfg.widgetsApi, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            lang: cfg.lang,
            deviceType: 'desktop',
            country: cfg.country,
            pageName: 'search-results',
            ddoKey: 'refineSearch',
            sortBy: '',
            subsearch: '',
            from: page * PAGE_SIZE,
            jobs: true,
            counts: true,
            all_fields: ['category', 'country', 'city'],
            size: PAGE_SIZE,
            clearAll: false,
            jdsource: 'facets',
            isSliderEnable: false,
            pageId: 'page10',
            siteType: 'external',
            keywords: '',
            global: cfg.country === 'global',
            selected_fields: cfg.selectedFields,
            locationData: {},
          }),
        });
      } catch (err) {
        if (!anyPageSucceeded) throw err;
        const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
        console.error(`⚠️  phenom: ${entry.name} truncated at page ${page + 1} of ${maxPages} (${jobsSummary}): ${err.message}`);
        stopReason = 'fetch-error';
        break;
      }
      anyPageSucceeded = true;
      const { total: pageTotal, rows } = parseRefineSearch(json, cfg);
      if (total === null) total = pageTotal;
      if (rows.length === 0) break;

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (fresh === 0) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
    }
    if (stopReason === 'complete' && page === maxPages) stopReason = 'cap';

    if (stopReason === 'cap') {
      const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
      console.error(`⚠️  phenom: ${entry.name} truncated at max_pages=${maxPages} (${jobsSummary}) — raise max_pages on this entry for more`);
    }

    return jobs;
  },
};
