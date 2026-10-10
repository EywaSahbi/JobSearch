import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';

const HOST_RE = /^[a-z0-9][a-z0-9-]*\.applytojob\.com$/i;
const MAX_JOBS = 1000;
const DETAIL_DEFAULT_LIMIT = 25;
const DETAIL_FETCH_DELAY_MS = 200;

function resolveOrigin(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed;
    try { parsed = new URL(raw.trim()); } catch { continue; }
    if (parsed.protocol !== 'https:' || !HOST_RE.test(parsed.hostname)) continue;
    return `https://${parsed.hostname}`;
  }
  return null;
}

const boardUrl = (origin) => `${origin}/apply`;

function assertJazzHRUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw).trim()); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || !HOST_RE.test(parsed.hostname)) {
    throw new Error(`jazzhr: untrusted or invalid public board URL: ${raw}`);
  }
  return parsed;
}

function clean(value) {
  return htmlToText(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
}

function parseJsonLd(html) {
  const out = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (Array.isArray(parsed?.['@graph'])) out.push(...parsed['@graph']);
      else out.push(parsed);
    } catch { }
  }
  return out;
}

function locationText(location) {
  const places = Array.isArray(location) ? location : [location];
  for (const place of places) {
    const address = place?.address || {};
    const values = [address.addressLocality, address.addressRegion, address.addressCountry]
      .filter((v) => typeof v === 'string' && v.trim());
    if (values.length) return values.join(', ');
  }
  return '';
}

const POSTING_LINK_RE = /<a\b[^>]*href=["']([^"']*\/apply\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function resolvePostingUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.origin !== base.origin || !/^\/apply\/[^/].*$/i.test(url.pathname)) return null;
    url.search = '';
    return url;
  } catch { return null; }
}

export function parseJazzHRList(html, boardHref, companyName) {
  if (typeof html !== 'string') return [];
  const base = new URL(boardHref);
  const jobs = [];
  const seen = new Set();
  const addJob = (url, title, location) => {
    if (!title || seen.has(url.href)) return;
    seen.add(url.href);
    jobs.push({ title, url: url.href, company: companyName || '', location });
  };

  const cardRe = /<li\b[^>]*class=["'][^"']*list-group-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(cardRe)) {
    const card = match[1];
    const link = card.match(/<a\b[^>]*href=["']([^"']*\/apply\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = resolvePostingUrl(link[1], base);
    if (!url) continue;
    const location = clean((card.match(/fa-map-marker[^<]*<\/i>\s*([^<]+)/i) || [])[1] || '');
    addJob(url, clean(link[2]), location);
    if (jobs.length >= MAX_JOBS) break;
  }

  for (const match of html.matchAll(POSTING_LINK_RE)) {
    const url = resolvePostingUrl(match[1], base);
    if (!url) continue;
    addJob(url, clean(match[2]), '');
    if (jobs.length >= MAX_JOBS) break;
  }

  const POSTING_HREF_RE = /<a\b[^>]*href=["'][^"']*\/apply\/[^"']+["']/i;
  if (jobs.length === 0 && POSTING_HREF_RE.test(html)) {
    throw new Error('jazzhr: found ApplyToJob links but could not parse any posting cards');
  }
  return jobs;
}

export function parseJazzHRDetail(html, job) {
  const node = parseJsonLd(html).find((item) => item && (item['@type'] === 'JobPosting' || (Array.isArray(item['@type']) && item['@type'].includes('JobPosting'))));
  if (!node) return job;
  if (!job.title && typeof node.title === 'string') job.title = clean(node.title);
  const description = clean(node.description);
  if (description) job.description = description;
  if (!String(job.location || '').trim() || /^n\/?a$/i.test(String(job.location).trim())) {
    const location = locationText(node.jobLocation);
    if (location) job.location = location;
  }
  if (typeof node.datePosted === 'string') {
    const parsed = Date.parse(node.datePosted);
    if (!Number.isNaN(parsed)) job.postedAt = parsed;
  }
  return job;
}

function config(entry) {
  const cfg = entry?.jazzhr || {};
  const limit = Number.isInteger(cfg.detailLimit) && cfg.detailLimit > 0 ? Math.min(cfg.detailLimit, 100) : DETAIL_DEFAULT_LIMIT;
  return { fetchDetails: cfg.fetchDetails === true, detailLimit: limit };
}

export default {
  id: 'jazzhr',
  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: boardUrl(origin) } : null;
  },
  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`jazzhr: cannot derive public ApplyToJob board URL for ${entry.name}`);
    const board = boardUrl(origin);
    const html = await fetchTextWithRetry(ctx, board, { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html' } });
    const jobs = parseJazzHRList(html, board, entry.name);
    const { fetchDetails, detailLimit } = config(entry);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (fetchDetails && !probing) {
      const targets = jobs.slice(0, detailLimit);
      for (let i = 0; i < targets.length; i++) {
        if (i > 0) await sleep(DETAIL_FETCH_DELAY_MS, ctx);
        const job = targets[i];
        try {
          const detailUrl = assertJazzHRUrl(job.url);
          const detail = await fetchTextWithRetry(ctx, detailUrl.href, { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html' } });
          parseJazzHRDetail(detail, job);
        } catch { }
      }
    }
    return jobs;
  },
};

export { resolveOrigin, assertJazzHRUrl };
