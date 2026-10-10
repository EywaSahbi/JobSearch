import { randomUUID } from 'node:crypto';
import { decodeEntities } from './_html-entities.mjs';
import { fetchJsonWithRetry, fetchTextWithRetry, sleep } from './_http.mjs';

const MAX_PAGES = 200;
const DEFAULT_MAX_JOBS = 2000;
const PAGE_DELAY_MS = 150;

const FRAGMENT_RECORDS_PER_PAGE = 100;

const MAX_JOBS_CAP = MAX_PAGES * FRAGMENT_RECORDS_PER_PAGE;

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (/\/search-jobs\/?$/.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  const lang = (u.pathname.match(/^\/([a-z]{2})(\/|$)/) || [])[1] || 'en';
  return `${u.origin}/${lang}/search-jobs`;
}

export function buildFragmentUrl(listUrl, page, recordsPerPage = FRAGMENT_RECORDS_PER_PAGE) {
  const q = new URLSearchParams({
    ActiveFacetID: '0',
    CurrentPage: String(page),
    RecordsPerPage: String(recordsPerPage),
    Distance: '50',
    RadiusUnitType: '0',
    Keywords: '',
    Location: '',
    ShowRadius: 'False',
    IsPagination: 'True',
    CustomFacetName: '',
    FacetTerm: '',
    FacetType: '0',
    SearchResultsModuleName: 'Search Results',
    SortCriteria: '0',
    SortDirection: '0',
    SearchType: '5',
    _: randomUUID(),
  });
  return `${listUrl}/results?${q.toString()}`;
}

export function readFragmentTotals(html) {
  if (typeof html !== 'string') return { totalResults: null, totalPages: null };
  const num = (re) => {
    const m = html.match(re);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  return {
    totalResults: num(/data-total-results="(\d+)"/),
    totalPages: num(/data-total-pages="(\d+)"/),
  };
}

const LEGACY_LOCATION_RE = /class="[^"]*\bjob-location\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|p|div)>/i;

export function parseLegacyResults(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const [n, a] of anchors.entries()) {
    const attrs = a[1];
    const inner = a[2];
    const idM = attrs.match(/data-job-id="([^"]+)"/i);
    if (!idM) continue;
    const hrefM = attrs.match(/href="([^"]+)"/i);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    if (!/\/job\//.test(href)) continue;
    const id = idM[1];
    if (seen.has(id)) continue;

    const headM = inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const title = clean(headM ? headM[1] : inner.replace(/<span[\s\S]*?<\/span>/gi, ' '));
    if (!title) continue;

    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    const locM = inner.match(LEGACY_LOCATION_RE)
      || html.slice(a.index + a[0].length, anchors[n + 1]?.index ?? html.length).match(LEGACY_LOCATION_RE);
    seen.add(id);
    out.push({ id, title, url, location: locM ? clean(locM[1]) : '' });
  }
  return out;
}

export function parseResults(html, origin) {
  const modern = parseModernResults(html, origin);
  return modern.length ? modern : parseLegacyResults(html, origin);
}

export function parseModernResults(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const blocks = html.split(/<li class="search-results-list__item/).slice(1);
  for (const block of blocks) {
    const link = block.match(/search-results-list__job-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = decodeEntities(link[1]);
    const dataIdM = block.match(/data-job-id="([^"]+)"/);
    const hrefIds = [...href.matchAll(/\/(\d+)(?=[/?#]|$)/g)];
    const id = dataIdM ? dataIdM[1] : (hrefIds.length ? hrefIds[hrefIds.length - 1][1] : href);
    if (seen.has(id)) continue;
    const title = clean(link[2]);
    if (!title) continue;
    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    const locM = block.match(/__job-info--location[\s\S]*?<span>([\s\S]*?)<\/span>/);
    seen.add(id);
    out.push({ id, title, url, location: locM ? clean(locM[1]) : '' });
  }
  return out;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

export default {
  id: 'radancy',

  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`radancy: cannot resolve search-jobs URL for ${entry.name}`);
    const origin = new URL(listUrl).origin;

    const maxPages = resolveMaxPages(entry);
    const maxJobs = resolveMaxJobs(entry);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const effectiveMaxPages = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const jobs = [];
    const seen = new Set();
    let succeededOnce = false;

    if (typeof ctx.fetchJson === 'function') {
      try {
        const first = await fetchJsonWithRetry(ctx, buildFragmentUrl(listUrl, 1), {
          redirect: 'error',
          headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        });
        const firstIsString = typeof first?.results === 'string';
        const firstHtml = firstIsString ? first.results : '';
        const firstRows = firstHtml ? parseResults(firstHtml, origin) : [];
        if (firstIsString) succeededOnce = true;
        if (firstRows.length) {
          const { totalResults, totalPages } = readFragmentTotals(firstHtml);
          const lastPage = Math.min(totalPages ?? effectiveMaxPages, effectiveMaxPages);
          const push = (rows) => {
            let fresh = 0;
            for (const row of rows) {
              if (seen.has(row.id)) continue;
              seen.add(row.id);
              fresh++;
              jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
            }
            return fresh;
          };
          push(firstRows);

          let stopReason = 'complete';
          let page = 2;
          for (; page <= lastPage && jobs.length < maxJobs; page++) {
            await sleep(PAGE_DELAY_MS, ctx);
            let rows;
            try {
              const json = await fetchJsonWithRetry(ctx, buildFragmentUrl(listUrl, page), {
                redirect: 'error',
                headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
              });
              if (typeof json?.results !== 'string') {
                throw new Error(`radancy: unexpected fragment response shape at page ${page} (results is not a string)`);
              }
              rows = json.results ? parseResults(json.results, origin) : [];
            } catch (err) {
              if (probing) throw err;
              console.error(
                `⚠️  radancy: ${entry.name} truncated at page ${page} of ${lastPage}`
                + ` (${jobs.length} jobs): ${err.message}`,
              );
              stopReason = 'error';
              break;
            }
            if (rows.length === 0) break;
            if (push(rows) === 0) break;
          }
          if (stopReason === 'complete' && page > lastPage && lastPage === effectiveMaxPages
            && (totalPages == null || totalPages > effectiveMaxPages)) {
            stopReason = 'cap';
          }
          if (stopReason === 'complete'
            && (jobs.length > maxJobs || (jobs.length === maxJobs && page <= lastPage))) {
            stopReason = 'cap';
          }

          if (!probing && stopReason === 'cap') {
            const returned = Math.min(jobs.length, maxJobs);
            console.error(
              `⚠️  radancy: ${entry.name} truncated at ${returned}${totalResults ? ` of ${totalResults}` : ''} jobs`
              + ` (max_pages/max_jobs reached) — raise max_jobs/max_pages on this entry for more`,
            );
          }
          return jobs.slice(0, maxJobs);
        }
      } catch (err) {
        if (probing) throw err;
      }
    }

    for (let page = 1; page <= effectiveMaxPages; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS, ctx);
      let rows;
      try {
        const html = await fetchTextWithRetry(ctx, `${listUrl}?p=${page}`, { redirect: 'error', headers: { accept: 'text/html' } });
        rows = parseResults(html, origin);
      } catch (err) {
        if (probing) throw err;
        if (!succeededOnce) throw err;
        break;
      }
      succeededOnce = true;
      if (rows.length === 0) break;

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      if (fresh === 0) break;
      if (jobs.length >= maxJobs) break;
    }
    return jobs.slice(0, maxJobs);
  },
};
