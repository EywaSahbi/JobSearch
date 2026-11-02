import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ICIMS_MAX_PAGES = 30;
const INTER_PAGE_DELAY_MS = 250;

const HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
};

function resolveOrigin(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    if (!parsed.hostname.endsWith('.icims.com')) continue;
    return parsed.origin;
  }
  return null;
}

const searchUrl = (origin, page) => `${origin}/jobs/search?ss=1&pr=${page}&in_iframe=1`;

export function parseIcimsSearchPage(html, origin, companyName) {
  const jobs = [];
  const cards = String(html).split('iCIMS_JobCardItem').slice(1);
  for (const card of cards) {
    const href = card.match(/href="([^"]*\/jobs\/\d+\/[^"/]+\/job[^"]*)"/);
    if (!href) continue;
    let parsed;
    try { parsed = new URL(decodeEntities(href[1]), origin); } catch { continue; }
    if (parsed.origin !== origin) continue;
    const title = card.match(/<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/);
    if (!title || !title[1].trim()) continue;
    const location = card.match(/<span\b[^>]*class=["'][^"']*(?<![\w-])field-label(?![\w-])[^"']*["'][^>]*>\s*Location\s*<\/span>\s*<span\b[^>]*>\s*([\s\S]*?)<\/span>/);
    jobs.push({
      title: decodeEntities(title[1].replace(/\s+/g, ' ').trim()),
      url: `${parsed.origin}${parsed.pathname}`,
      company: companyName,
      location: location ? decodeEntities(location[1].replace(/\s+/g, ' ').trim()) : '',
    });
  }
  return jobs;
}

async function fetchPortal(origin, entry, ctx) {
  const all = [];
  let prevFirstUrl = null;
  let reachedEnd = false;
  for (let pageNum = 0; pageNum < ICIMS_MAX_PAGES; pageNum++) {
    if (pageNum > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
    let html;
    try {
      html = await ctx.fetchText(searchUrl(origin, pageNum), { headers: HEADERS, redirect: 'error' });
    } catch (err) {
      if (pageNum === 0 && err && typeof err === 'object') err.firstPage = true;
      throw err;
    }
    const pageJobs = parseIcimsSearchPage(html, origin, entry.name);
    if (pageJobs.length === 0) { reachedEnd = true; break; }
    if (pageJobs[0].url === prevFirstUrl) { reachedEnd = true; break; }
    prevFirstUrl = pageJobs[0].url;
    all.push(...pageJobs);
  }
  if (!reachedEnd) all.icimsTruncated = true;
  return all;
}

export default {
  id: 'icims',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: searchUrl(origin, 0) } : null;
  },

  async fetch(entry, ctx) {
    const primary = resolveOrigin(entry);
    if (!primary) throw new Error(`icims: cannot derive portal origin for ${entry.name}`);
    const origins = [primary];
    for (const raw of Array.isArray(entry.fallback_urls) ? entry.fallback_urls : []) {
      const origin = resolveOrigin({ careers_url: raw });
      if (origin && !origins.includes(origin)) origins.push(origin);
    }
    let notFound;
    for (const origin of origins) {
      try {
        return await fetchPortal(origin, entry, ctx);
      } catch (err) {
        if (err?.status !== 404 || !err.firstPage) throw err;
        notFound = err;
      }
    }
    throw notFound;
  },

  async enrichDate(job, ctx) {
    const sep = job.url.includes('?') ? '&' : '?';
    const html = await ctx.fetchText(`${job.url}${sep}in_iframe=1`, { headers: HEADERS, redirect: 'error' });
    const nodes = [];
    for (const [, raw] of String(html).matchAll(/<script\b[^>]*(?<![\w-])type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      if (Array.isArray(data)) nodes.push(...data);
      else if (Array.isArray(data?.['@graph'])) nodes.push(...data['@graph']);
      else nodes.push(data);
    }
    const ts = Date.parse(pickDatePosted(nodes) || '');
    if (!Number.isNaN(ts)) job.postedAt = ts;
    if (!String(job.location || '').trim() || /^n\/?a$/i.test(String(job.location).trim())) {
      const loc = pickLocation(nodes);
      if (loc) job.location = loc;
    }
  },
};

const COUNTRY_NAMES = { US: 'United States', CA: 'Canada' };

function pickLocation(nodes) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.jobLocation) continue;
    const places = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
    for (const place of places) {
      const addr = place?.address;
      if (!addr || typeof addr !== 'object') continue;
      const clean = v => {
        const s = String(v ?? '').trim();
        return !s || /^unavailable$/i.test(s) ? '' : s;
      };
      const country = clean(addr.addressCountry);
      const parts = [
        clean(addr.addressLocality),
        clean(addr.addressRegion),
        COUNTRY_NAMES[country.toUpperCase()] || country,
      ].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  }
  return null;
}

function pickDatePosted(nodes) {
  let fallback = null;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.datePosted) continue;
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node.datePosted;
    if (fallback == null) fallback = node.datePosted;
  }
  return fallback;
}
