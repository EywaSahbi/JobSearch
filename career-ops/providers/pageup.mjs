import { fetchTextWithRetry, isRefusedRedirectError, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

const ORIGIN = 'https://careers.pageuppeople.com';

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 250;

const TENANT_PATH_RE = /^\/(\d+)\/([A-Za-z0-9_-]+)\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})?)(?:\/|$)/;

function resolveConfig(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.origin !== ORIGIN) continue;
    const m = parsed.pathname.match(TENANT_PATH_RE);
    if (!m) continue;
    return { tenant: m[1], site: m[2], lang: m[3] };
  }
  return null;
}

const listingUrl = (cfg, page) =>
  `${ORIGIN}/${cfg.tenant}/${cfg.site}/${cfg.lang}/listing/?page=${page}&page-items=${PAGE_SIZE}`;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function stripComments(s) {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = s.indexOf('<!--', pos);
    if (open === -1) return out + s.slice(pos);
    out += s.slice(pos, open);
    const close = s.indexOf('-->', open + 4);
    if (close === -1) return out;
    pos = close + 3;
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`(?<![\\w-])${name}=["']([^"'<>]*)["']`, 'i'));
  return m ? m[1] : null;
}

const hasClass = (tag, token) => (attr(tag, 'class') ?? '').split(/\s+/).includes(token);

export function parsePageupListing(html, cfg, companyName) {
  const doc = String(html);
  const open = doc.match(/<tbody\b[^<>]*(?<![\w-])id=["']search-results-content["'][^<>]*>/i);
  if (!open) return { valid: false, reason: 'no-table', linkCount: 0, hasMore: false, jobs: [] };
  const start = (open.index ?? 0) + open[0].length;
  const close = doc.slice(start).search(/<\/tbody\s*>/i);
  const end = close === -1 ? doc.length : start + close;
  const body = stripComments(doc.slice(start, end));

  const jobs = [];
  let linkCount = 0;
  const opens = [...body.matchAll(/<a\b[^<>]*>/gi)];
  const closes = [...body.matchAll(/<\/a\s*>/gi)].map(m => m.index ?? 0);
  let nextClose = 0;
  for (let i = 0; i < opens.length; i++) {
    const tag = opens[i];
    if (!hasClass(tag[0], 'job-link')) continue;
    linkCount++;
    const href = attr(tag[0], 'href');
    if (!href) continue;
    let parsed;
    try { parsed = new URL(decodeEntities(href), ORIGIN); } catch { continue; }
    if (parsed.origin !== ORIGIN) continue;
    const m = parsed.pathname.match(/^\/(\d+)\/([A-Za-z0-9_-]+)\/[^/]+\/job\/(\d+)(?:\/|$)/);
    if (!m || m[1] !== cfg.tenant || m[2] !== cfg.site) continue;
    const textStart = (tag.index ?? 0) + tag[0].length;
    while (nextClose < closes.length && closes[nextClose] < textStart) nextClose++;
    const textEnd = closes[nextClose];
    const nextOpen = opens[i + 1]?.index;
    if (textEnd === undefined || (nextOpen !== undefined && nextOpen < textEnd)) continue;
    const title = htmlToText(body.slice(textStart, textEnd));
    if (!title) continue;
    jobs.push({
      title,
      url: `${ORIGIN}/${cfg.tenant}/${cfg.site}/${cfg.lang}/job/${m[3]}`,
      company: companyName,
      location: '',
    });
  }

  if (jobs.length === 0 && (linkCount > 0 || /\/job\/\d/.test(body))) {
    return { valid: false, reason: 'no-jobs-parsed', linkCount, hasMore: false, jobs: [] };
  }

  const tail = doc.slice(end);
  let hasMore = false;
  if (tail.includes('more-link')) {
    for (const tag of stripComments(tail).matchAll(/<a\b[^<>]*>/gi)) {
      if (hasClass(tag[0], 'more-link')) { hasMore = true; break; }
    }
  }
  return { valid: true, linkCount, hasMore, jobs };
}

export default {
  id: 'pageup',

  detect(entry) {
    const cfg = resolveConfig(entry);
    return cfg ? { url: listingUrl(cfg, 1) } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`pageup: cannot derive a careers.pageuppeople.com tenant URL for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;

    const jobs = [];
    const seen = new Set();
    let stopReason = 'cap';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let html;
      try {
        html = await fetchTextWithRetry(ctx, listingUrl(cfg, page), { redirect: 'error' }, probing ? { retries: 0 } : {});
      } catch (err) {
        if (probing) throw err;
        if (page === 1 && isRefusedRedirectError(err)) {
          throw new Error(
            `pageup: ${entry.name} redirects away from ${ORIGIN} — the tenant has likely moved its careers site ` +
              'off the vendor host, which this provider does not read',
            { cause: err },
          );
        }
        if (page === 1) throw err;
        const why = isRefusedRedirectError(err) ? `redirected away from ${ORIGIN}` : err?.message;
        console.error(`⚠️  pageup: ${entry.name} stopped at page ${page} (${jobs.length} jobs kept): ${why}`);
        stopReason = 'fetch-error';
        break;
      }
      const parsed = parsePageupListing(html, cfg, entry.name);
      if (!parsed.valid) {
        const what = parsed.reason === 'no-table'
          ? 'no search-results table — likely a login, error or challenge page, not zero postings'
          : 'posting links but none could be read — markup changed';
        if (page === 1) throw new Error(`pageup: ${entry.name} returned a listing page with ${what}`);
        console.error(`⚠️  pageup: ${entry.name} page ${page} had ${what} (${jobs.length} jobs kept)`);
        stopReason = 'unrecognised-page';
        break;
      }

      let fresh = 0;
      for (const job of parsed.jobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        fresh++;
        jobs.push(job);
      }
      if (fresh === 0) { stopReason = 'complete'; break; }
      if (!parsed.hasMore && parsed.linkCount < PAGE_SIZE) { stopReason = 'complete'; break; }
    }

    if (stopReason === 'cap' && !probing) {
      console.error(`⚠️  pageup: ${entry.name} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
