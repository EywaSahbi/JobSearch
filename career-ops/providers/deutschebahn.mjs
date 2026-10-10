import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const ITEMS_PER_PAGE = 1000;
const MAX_PAGES = 5;
const MAX_JOBS = 1000;
const PAGE_DELAY_MS = 150;
const PAGE_TIMEOUT_MS = 30_000;
const SORT = 'pubExternalDate_tdt';

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'db.jobs' && !host.endsWith('.db.jobs')) return null;
  const idM = u.pathname.match(/\/service\/search\/de-de\/(\d+)/) || u.pathname.match(/\/(\d{6,})(?:[/?]|$)/);
  const searchId = idM ? idM[1] : '5441588';
  return {
    origin: u.origin,
    searchBase: `${u.origin}/service/search/de-de/${searchId}`,
  };
}

export function parseHits(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*class="[^"]*m-search-hit\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const anchor = m[0];
    const inner = m[1];
    const hrefM = anchor.match(/href="([^"]+)"/);
    const idM = anchor.match(/data-job-id="([^"]+)"/);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    const id = idM ? idM[1] : href;
    if (seen.has(id)) continue;
    const titleM = inner.match(/m-search-hit__title-text"[^>]*>([\s\S]*?)<\/span>/i);
    const title = titleM ? clean(titleM[1]) : '';
    if (!title) continue;
    const locM = inner.match(/aria-label="Arbeitsort"[^>]*><\/i>([\s\S]*?)<\/li>/i);
    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    seen.add(id);
    out.push({ id, title, url, location: locM ? clean(locM[1]) : '' });
  }
  return out;
}

export function countHitAnchors(html) {
  if (typeof html !== 'string') return 0;
  return (html.match(/<a\b[^>]*class="[^"]*m-search-hit\b[^"]*"/gi) || []).length;
}

export function parseResultCount(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/class="result-count"[^>]*data-count="([\d.]+)"/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ''));
  return Number.isFinite(n) ? n : null;
}

export function assertNoUnparsedHits(html, url) {
  if (!/href="[^"]*[?&](?:amp;)?jobId=\d+/.test(String(html ?? ''))) return;
  throw new Error(`deutschebahn: ${url} still contains posting links but no hit could be parsed — the listing markup changed`);
}

export function countMissedPostingLinks(html) {
  if (typeof html !== 'string') return 0;
  const idOf = (s) => s.match(/[?&](?:amp;)?jobId=(\d+)/)?.[1];
  const hitIds = new Set();
  for (const a of html.match(/<a\b[^>]*class="[^"]*m-search-hit\b[^"]*"[^>]*>/gi) || []) {
    const id = idOf(a);
    if (id) hitIds.add(id);
  }
  const missed = new Set();
  for (const link of html.match(/href="[^"]*[?&](?:amp;)?jobId=\d+/g) || []) {
    const id = idOf(link);
    if (id && !hitIds.has(id)) missed.add(id);
  }
  return missed.size;
}

export function assertEmptyFirstPage(html, url) {
  assertNoUnparsedHits(html, url);
  const count = parseResultCount(html);
  if (count === 0) return;
  if (count === null) throw new Error(`deutschebahn: ${url} rendered the results shell with no hits and no result count — db.jobs blanks a page holding a posting it can't render, or the search request is no longer served`);
  throw new Error(`deutschebahn: ${url} reports ${count} postings but no hit could be parsed — the listing markup changed`);
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export default {
  id: 'deutschebahn',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveConfig({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`deutschebahn: cannot resolve db.jobs search id for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const jobs = [];
    const seen = new Set();

    let stopReason = 'cap';
    let lastHtml = '';
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      const url = `${cfg.searchBase}?qli=true&query=&sort=${SORT}&itemsPerPage=${ITEMS_PER_PAGE}&pageNum=${page}`;
      let html;
      try {
        html = await fetchTextWithRetry(ctx, url, { headers: { accept: 'text/html' }, redirect: 'error', timeoutMs: PAGE_TIMEOUT_MS });
      } catch (err) {
        if (page === 0 || ctx?.maxPages) throw err;
        console.warn(`deutschebahn: ${entry.name}: page ${page} failed (${err?.message ?? err}) — keeping the ${jobs.length} collected so far`);
        stopReason = 'fetch-error';
        break;
      }
      lastHtml = html;
      const rows = parseHits(html, cfg.origin);
      if (rows.length === 0) {
        stopReason = 'complete';
        if (page === 0) {
          assertEmptyFirstPage(html, url);
        } else {
          assertNoUnparsedHits(html, url);
          const count = parseResultCount(html);
          if (count !== null && page * ITEMS_PER_PAGE < count) {
            console.warn(`deutschebahn: ${entry.name}: page ${page} came back empty with ${count} postings reported — keeping the ${jobs.length} collected so far`);
          }
        }
        break;
      }

      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      const missed = countMissedPostingLinks(html);
      if (missed > 0) {
        console.warn(`deutschebahn: ${entry.name}: page ${page} links ${missed} posting(s) no hit anchor carries — the hit markup may have a new variant`);
      }
      if (jobs.length >= MAX_JOBS) {
        stopReason = 'max-jobs';
        break;
      }
      if (countHitAnchors(html) < ITEMS_PER_PAGE) {
        stopReason = 'complete';
        break;
      }
    }
    if (stopReason === 'cap') {
      const count = parseResultCount(lastHtml);
      if (count === null || maxPages * ITEMS_PER_PAGE < count) {
        console.warn(`deutschebahn: ${entry.name}: stopped at ${maxPages} pages (${jobs.length} postings); raise max_pages on this entry`);
      }
    }
    return jobs.slice(0, MAX_JOBS);
  },
};
