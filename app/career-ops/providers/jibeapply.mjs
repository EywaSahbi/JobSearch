import { safeEncodeURIComponent } from './_safe-url.mjs';

const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 500;

const DEFAULT_PAGE_SIZE = 10;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toApiUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/^[a-z0-9-]+\.jibeapply\.com$/i.test(u.hostname)) return null;
  if (!u.pathname.startsWith('/api/')) {
    u.pathname = '/api' + (u.pathname.startsWith('/') ? u.pathname : '/' + u.pathname);
  }
  return u.href;
}

function validateExplicitApi(apiUrl) {
  let u;
  try { u = new URL(apiUrl); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}

export function parseJibeapplyResponse(json, entry) {
  let origin = '';
  try { origin = new URL(entry.careers_url || '').origin; } catch { }
  if (!origin) {
    try { origin = new URL(entry.api || '').origin; } catch { }
  }
  const items = Array.isArray(json?.jobs) ? json.jobs : [];
  return items
    .map(item => {
      if (item == null) return null;
      const d = item.data ?? item;
      const title = String(d.title || '').trim();
      const slug = d.slug || d.req_id;
      if (!title || !slug) return null;
      const encodedSlug = safeEncodeURIComponent(slug);
      if (encodedSlug === null) return null;
      return {
        title,
        url: `${origin}/jobs/${encodedSlug}`,
        company: String(d.hiring_organization || entry.name || '').trim(),
        location: d.full_location || [d.city, d.country].filter(Boolean).join(', '),
      };
    })
    .filter(Boolean);
}

export default {
  id: 'jibeapply',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    const apiUrl = toApiUrl(url);
    if (!apiUrl) return null;
    return { url: apiUrl };
  },

  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (typeof url !== 'string' || !url) throw new Error('jibeapply: careers_url required');

    const apiUrl = (typeof entry.api === 'string' && validateExplicitApi(entry.api))
      || toApiUrl(url);
    if (!apiUrl) throw new Error(`jibeapply: cannot derive API URL for ${entry.name}`);
    const first = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    const total = first.totalCount ?? 0;
    const pageSize = first.jobs?.length || first.count || DEFAULT_PAGE_SIZE;
    const allJobs = [...(first.jobs ?? [])];

    if (total > pageSize && pageSize > 0) {
      const maxPages = resolveMaxPages(entry);
      const pages = Math.min(Math.ceil(total / pageSize), maxPages);
      for (let page = 2; page <= pages; page++) {
        const u2 = new URL(apiUrl);
        u2.searchParams.set('page', String(page));
        let json;
        try {
          json = await ctx.fetchJson(u2.toString(), { redirect: 'error' });
        } catch (err) {
          console.error(`⚠️  jibeapply: ${entry.name} page ${page} fetch failed — ${err.message} (returning ${allJobs.length} jobs fetched so far)`);
          break;
        }
        allJobs.push(...(json.jobs ?? []));
      }

      if (Math.ceil(total / pageSize) > maxPages) {
        console.error(
          `⚠️  jibeapply: ${entry.name} has more postings than max_pages allows ` +
          `(fetched ${allJobs.length} of ${total}) — ` +
          `set max_pages on this portal entry to raise the cap (current: ${maxPages})`,
        );
      }
    }

    return parseJibeapplyResponse({ jobs: allJobs }, entry);
  },
};
