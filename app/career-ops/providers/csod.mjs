import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const PAGE_SIZE = 25;
const MAX_PAGES = 40;
const MAX_JOBS = 1000;
const PAGE_DELAY_MS = 120;

export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'csod.com' && !host.endsWith('.csod.com')) return null;
  const m = u.pathname.match(/\/ux\/ats\/careersite\/(\d+)\//i) || u.pathname.match(/\/ux\/ats\/careersite\/(\d+)$/i);
  if (!m) return null;
  const siteId = Number(m[1]);
  const corpName = u.searchParams.get('c') || host.split('.')[0];
  return {
    origin: u.origin,
    siteId,
    corpName,
    homeUrl: `${u.origin}/ux/ats/careersite/${siteId}/home?c=${encodeURIComponent(corpName)}`,
    searchApi: `${u.origin}/services/x/career-site/v1/search`,
  };
}

export function cookieHeaderFrom(setCookies) {
  const jar = new Map();
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function extractToken(html) {
  const m = typeof html === 'string' ? html.match(/"token"\s*:\s*"([A-Za-z0-9._-]+)"/) : null;
  return m ? m[1] : '';
}

export function parseCsodDate(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) : null;
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).getUTCDate() !== day) return undefined;
  return Number.isFinite(ms) ? ms : undefined;
}

export function cleanLocations(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const loc of list) {
    if (!loc || typeof loc !== 'object') continue;
    const city = String(loc.city || '').trim();
    const country = String(loc.country || '').trim();
    const s = city ? (country ? `${city}, ${country}` : city) : country;
    if (s && !out.includes(s)) out.push(s);
  }
  return out.join(' / ');
}

export function parseRequisitions(json, cfg) {
  const list = Array.isArray(json?.data?.requisitions) ? json.data.requisitions : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const id = r.requisitionId != null ? String(r.requisitionId) : '';
    const title = decodeEntities(String(r.displayJobTitle || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    out.push({
      id,
      title,
      url: `${cfg.origin}/ux/ats/careersite/${cfg.siteId}/home/requisition/${id}?c=${encodeURIComponent(cfg.corpName)}`,
      location: cleanLocations(r.locations),
      postedAt: parseCsodDate(r.postingEffectiveDate),
    });
  }
  return out;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export default {
  id: 'csod',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveConfig({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`csod: cannot resolve careersite URL for ${entry.name}`);

    let html;
    let cookie = '';
    if (typeof ctx.fetchResponse === 'function') {
      const res = await ctx.fetchResponse(cfg.homeUrl, { redirect: 'error', headers: { accept: 'text/html' } });
      const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      cookie = cookieHeaderFrom(setCookies);
      html = await res.text();
    } else {
      html = await ctx.fetchText(cfg.homeUrl, { redirect: 'error', headers: { accept: 'text/html' } });
    }
    const token = extractToken(html);
    if (!token) throw new Error(`csod: no anonymous token on ${cfg.homeUrl}`);

    const maxPages = resolveMaxPages(entry);
    const jobs = [];
    const seen = new Set();
    let total = null;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS, ctx);
      const json = await ctx.fetchJson(cfg.searchApi, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({
          careerSiteId: cfg.siteId,
          careerSitePageId: cfg.siteId,
          pageNumber: page,
          pageSize: PAGE_SIZE,
          cultureId: 1,
          cultureName: 'en-US',
          searchText: '',
          states: [],
          countryCodes: [],
          cities: [],
          placeID: '',
          radius: null,
          postingsWithinDays: null,
          customFieldCheckboxKeys: [],
          customFieldDropdowns: [],
          customFieldRadios: [],
        }),
      });
      if (total === null) {
        total = typeof json?.data?.totalCount === 'number' ? json.data.totalCount : null;
      }
      const rows = parseRequisitions(json, cfg);
      const rawCount = Array.isArray(json?.data?.requisitions) ? json.data.requisitions.length : 0;
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
      if (total !== null && page * PAGE_SIZE >= total) break;
      if (rawCount < PAGE_SIZE) break;
    }
    return jobs;
  },
};
