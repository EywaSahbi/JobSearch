import { DEFAULT_USER_AGENT } from '../user-agent.mjs';

export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_TIMEOUT_MS = 20_000;

export const YC_MAX_PAGES = 500;

const YC_API_URL = 'https://api.ycombinator.com/v0.1/companies?page=1&per_page=1000';

const A16Z_PORTFOLIO_URL = 'https://a16z.com/portfolio/';

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = await res.text().catch(() => '').then(t => t.slice(0, 200));
      throw new Error(`HTTP ${res.status}${snippet ? ': ' + snippet.replace(/\s+/g, ' ').trim() : ''}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function parseYCPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload);
  const list = Array.isArray(raw.companies) ? raw.companies : (Array.isArray(raw) ? raw : []);
  const seen = new Map();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;

    const rawSlug = typeof item.slug === 'string' ? item.slug.trim()
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!rawSlug || !SLUG_RE.test(rawSlug)) continue;

    if (seen.has(rawSlug)) continue;

    const url = typeof item.website === 'string' && item.website.startsWith('http')
      ? item.website.trim()
      : (typeof item.url === 'string' && item.url.startsWith('http') ? item.url.trim() : '');

    const entry = {
      name,
      slug: rawSlug,
      url,
      source: 'yc',
    };

    if (typeof item.batch === 'string' && item.batch.trim()) {
      entry.batch = item.batch.trim();
    }

    seen.set(rawSlug, entry);
  }

  return [...seen.values()];
}

export function parseA16zPayload(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const seen = new Map();

  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'Organization' || item?.['@type'] === 'Corporation') {
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          const url = typeof item.url === 'string' ? item.url.trim() : '';
          if (!name) continue;
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
          seen.set(slug, { name, slug, url, source: 'a16z' });
        }
      }
    } catch {
    }
  }

  const dataAttrRe = /data-company-name=["']([^"']+)["'](?:[^>]*data-company-url=["']([^"']+)["'])?/gi;
  for (const match of html.matchAll(dataAttrRe)) {
    const name = match[1]?.trim();
    const url = match[2]?.trim() || '';
    if (!name) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.set(slug, { name, slug, url, source: 'a16z' });
  }

  const portfolioAnchorRe = /<a\s+[^>]*href=["'](https?:\/\/[^"'?\s]+)["'][^>]*class=["'][^"']*(?:portfolio|company|card)[^"']*["'][^>]*>\s*([A-Z][^<]{1,60}?)\s*<\/a>/gi;
  for (const match of html.matchAll(portfolioAnchorRe)) {
    const url = match[1]?.trim();
    const name = match[2]?.trim().replace(/\s+/g, ' ');
    if (!name || !url) continue;
    if (/^(read more|learn more|visit|see all|view|more|news|blog|press|contact)/i.test(name)) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || !SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.set(slug, { name, slug, url, source: 'a16z' });
  }

  return [...seen.values()];
}

export function parseSeedEntries(payload, source) {
  if (source === 'a16z') {
    return parseA16zPayload(typeof payload === 'string' ? payload : '');
  }
  return parseYCPayload(payload);
}

export function toPortalEntry(company) {
  let careers_url = '';

  const atsId = company.ats_id && SLUG_RE.test(company.ats_id) ? company.ats_id : null;
  if (atsId) {
    if (company.ats === 'greenhouse') {
      careers_url = `https://job-boards.greenhouse.io/${atsId}`;
    } else if (company.ats === 'lever') {
      careers_url = `https://jobs.lever.co/${atsId}`;
    } else if (company.ats === 'ashby') {
      careers_url = `https://jobs.ashbyhq.com/${atsId}`;
    }
  }

  if (!careers_url && company.slug && SLUG_RE.test(company.slug)) {
    careers_url = `https://job-boards.greenhouse.io/${company.slug}`;
  }

  if (!careers_url) {
    careers_url = company.url || '';
  }

  return {
    name: company.name,
    careers_url,
    source: company.source,
  };
}

export async function fetchYCCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = YC_MAX_PAGES } = {}) {
  const all = [];
  const seen = new Set();

  const limit = Math.min(maxPages, YC_MAX_PAGES);

  let page = 1;
  for (let fetched = 0; fetched < limit; fetched++) {
    const url = `https://api.ycombinator.com/v0.1/companies?page=${page}&per_page=1000`;
    let payload;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs });
      payload = await res.json();
    } catch (err) {
      if (page === 1) throw new Error(`vc-portfolios: YC API fetch failed — ${err.message}`);
      break;
    }

    const entries = parseYCPayload(payload);
    if (entries.length === 0) break;

    for (const e of entries) {
      if (!seen.has(e.slug)) {
        seen.add(e.slug);
        all.push(e);
      }
    }

    const raw = (payload);
    if (Number.isInteger(raw?.totalPages) && raw.totalPages > 0) {
      if (page >= raw.totalPages) break;
      page += 1;
      continue;
    }
    const next = parseYCNextPage(raw?.nextPage);
    if (next == null || next <= page) break;
    page = next;
  }

  return all;
}

export function parseYCNextPage(nextPage) {
  if (nextPage == null || nextPage === false) return null;
  if (typeof nextPage === 'number') {
    return Number.isInteger(nextPage) && nextPage > 0 ? nextPage : null;
  }
  if (typeof nextPage === 'string') {
    const m = nextPage.match(/(?:^|[?&/])page[=/](\d+)/) || nextPage.match(/^\s*(\d+)\s*$/);
    if (m) {
      const n = Number(m[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

export async function fetchA16zCompanies({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let html;
  try {
    const res = await fetchWithTimeout(A16Z_PORTFOLIO_URL, { timeoutMs });
    html = await res.text();
  } catch (err) {
    throw new Error(`vc-portfolios: a16z portfolio fetch failed — ${err.message}`);
  }
  return parseA16zPayload(html);
}

export const SEED_SOURCES = {
  yc: {
    fetch: fetchYCCompanies,
    label: 'Y Combinator Portfolio',
  },
  a16z: {
    fetch: fetchA16zCompanies,
    label: 'Andreessen Horowitz (a16z) Portfolio',
  },
};
