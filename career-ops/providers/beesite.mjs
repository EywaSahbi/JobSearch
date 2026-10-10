import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const MAX_JOBS = 1000;
const PAGE_DELAY_MS = 150;

const DESCRIPTOR = [
  'PositionID',
  'PositionTitle',
  'PositionURI',
  'PositionLocation.CityName',
  'PublicationStartDate',
];

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
  if (host !== 'beesite.de' && !host.endsWith('.beesite.de')) return null;
  const cfgBlock = entry.beesite && typeof entry.beesite === 'object' ? entry.beesite : {};
  return {
    searchApi: `${u.origin}/search`,
    languageCode: typeof cfgBlock.languageCode === 'string' ? cfgBlock.languageCode : 'EN',
    searchCriteria: Array.isArray(cfgBlock.searchCriteria) ? cfgBlock.searchCriteria : [],
  };
}

export function buildSearchUrl(cfg, firstItem) {
  const data = {
    LanguageCode: cfg.languageCode,
    SearchParameters: {
      FirstItem: firstItem,
      CountItem: PAGE_SIZE,
      Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }],
      MatchedObjectDescriptor: DESCRIPTOR,
    },
    SearchCriteria: cfg.searchCriteria,
  };
  return `${cfg.searchApi}?data=${encodeURIComponent(JSON.stringify(data))}`;
}

export function parseBeesiteDate(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return undefined;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(Number(m[1]), month - 1, day);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseSearchResult(json) {
  const sr = json?.SearchResult;
  const total = typeof sr?.SearchResultCountAll === 'number' ? sr.SearchResultCountAll : null;
  const items = Array.isArray(sr?.SearchResultItems) ? sr.SearchResultItems : [];
  const rows = [];
  for (const item of items) {
    const d = item?.MatchedObjectDescriptor;
    if (!d) continue;
    const id = item.MatchedObjectId != null ? String(item.MatchedObjectId) : String(d.PositionID || '');
    const title = decodeEntities(String(d.PositionTitle || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const url = String(d.PositionURI || '').trim();
    if (!id || !title || !/^https?:\/\//i.test(url)) continue;
    const locs = Array.isArray(d.PositionLocation) ? d.PositionLocation : [];
    const cities = [];
    for (const l of locs) {
      const c = String(l?.CityName || '').trim();
      if (c && !cities.includes(c)) cities.push(c);
    }
    rows.push({
      id,
      title,
      url,
      location: cities.join(' / '),
      postedAt: parseBeesiteDate(d.PublicationStartDate),
    });
  }
  return { total, rows };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export default {
  id: 'beesite',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveConfig({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`beesite: cannot resolve search host for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const jobs = [];
    const seen = new Set();
    let total = null;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      const json = await ctx.fetchJson(buildSearchUrl(cfg, page * PAGE_SIZE + 1), {
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      const { total: pageTotal, rows } = parseSearchResult(json);
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
        if (jobs.length >= MAX_JOBS) break;
      }
      if (fresh === 0) break;
      if (jobs.length >= MAX_JOBS) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
    }
    return jobs;
  },
};
