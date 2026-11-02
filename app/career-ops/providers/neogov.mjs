import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const NEOGOV_ORIGINS = new Map([
  ['schooljobs.com', 'https://www.schooljobs.com'],
  ['www.schooljobs.com', 'https://www.schooljobs.com'],
  ['governmentjobs.com', 'https://www.governmentjobs.com'],
  ['www.governmentjobs.com', 'https://www.governmentjobs.com'],
]);
const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 30;
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 200;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveTarget(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const origin = NEOGOV_ORIGINS.get(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' || !origin) return null;
  const [root, agency, folder = ''] = parsed.pathname.split('/').filter(Boolean);
  if (root !== 'careers' || !agency || !SEGMENT_RE.test(agency)) return null;
  if (agency.toLowerCase() === 'home') return null;
  if (folder && !SEGMENT_RE.test(folder)) return null;
  return { origin, agency: agency.toLowerCase(), folder: folder.toLowerCase() };
}

function pageUrl(t, page) {
  const q = new URLSearchParams({ agency: t.agency });
  if (t.folder) q.set('departmentFolder', t.folder);
  q.set('sort', 'PostingDate');
  q.set('isDescendingSort', 'true');
  q.set('page', String(page));
  return `${t.origin}/careers/home/index?${q}`;
}

export default {
  id: 'neogov',

  detect(entry) {
    const t = resolveTarget(entry);
    return t ? { url: pageUrl(t, 1) } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTarget(entry);
    if (!t) throw new Error(`neogov: cannot derive agency for ${entry.name} (need an https://www.schooljobs.com/careers/<agency>[/<folder>] or governmentjobs.com careers_url)`);

    const ctxMax = Number(ctx?.maxPages);
    const ceiling = resolveMaxPages(entry);
    const pagesToFetch = ctxMax > 0 ? Math.min(ceiling, ctxMax) : ceiling;

    const jobs = [];
    const seen = new Set();
    let stoppedOnEmpty = false;
    let pagesFetched = 0;
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const html = await fetchTextWithRetry(ctx, pageUrl(t, page), {
        redirect: 'error',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      pagesFetched++;
      const found = parseNeogovPage(html, entry.name, t.origin);
      let fresh = 0;
      for (const job of found) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        fresh++;
      }
      if (fresh === 0) {
        stoppedOnEmpty = true;
        break;
      }
    }
    if (!stoppedOnEmpty && pagesFetched >= ceiling && !(ctxMax > 0 && ctxMax < ceiling)) {
      console.warn(`neogov: ${entry.name}: stopped at ${ceiling} pages (${ceiling * PAGE_SIZE} postings); raise max_pages on this entry`);
    }
    return jobs;
  },
};

const text = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseNeogovPage(html, companyName, origin) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const items = html.split(/<li class="list-item"/i).slice(1);
  if (!items.length) {
    if (html.includes('jobs-not-found-container') || html.includes('search-results-listing-container')) return [];
    throw new Error('neogov: response is not a NEOGOV job list (no list items, listing container or not-found container)');
  }
  const jobs = [];
  for (const item of items) {
    const link =
      item.match(/<a [^>]*class="item-details-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
      item.match(/<a [^>]*href="([^"]+)"[^>]*class="item-details-link"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const title = text(link[2]);
    let url;
    try {
      const u = new URL(decodeEntities(link[1]), origin);
      if (u.origin !== origin || !/^\/careers\/[^/]+\/(?:[^/]+\/)?jobs\/\d+/.test(u.pathname)) continue;
      u.hash = '';
      url = u.href;
    } catch {
      continue;
    }
    if (!title) continue;
    const meta = (item.match(/<ul class="list-meta">([\s\S]*?)<\/ul>/i) || [])[1] || '';
    const location = text((meta.match(/<li>([\s\S]*?)<\/li>/i) || [])[1] || '');
    jobs.push({ title, url, company: companyName, location });
  }
  return jobs;
}
