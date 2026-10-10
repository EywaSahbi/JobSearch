import { decodeEntities } from './_html-entities.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { sleep } from './_http.mjs';

const MAX_PAGES = 60;
const MAX_JOBS = 1000;
const PAGE_DELAY_MS = 150;

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
  if (host !== 'jobs.tkmsgroup.com') return null;
  const block = entry.tkms && typeof entry.tkms === 'object' ? entry.tkms : {};
  const locale = typeof block.locale === 'string' ? block.locale : 'en';
  return {
    origin: u.origin,
    queryApi: `${u.origin}/api/filter/query`,
    subclient: typeof block.subclient === 'string' ? block.subclient : 'tkms',
    locale,
  };
}

export function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'job';
}

export function parseTkmsDate(data) {
  const ts = data?.postingDate_timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts * 1000;
  const raw = data?.postingDate;
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw.trim() + 'Z');
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export function tkmsLocation(data) {
  const locs = Array.isArray(data?.locations) ? data.locations : [];
  const out = [];
  for (const l of locs) {
    const s = String(l?.cityState || l?.city || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length) return out.join(' / ');
  const flat = [data?.city, data?.country].map((p) => String(p || '').trim()).filter(Boolean);
  return [...new Set(flat)].join(', ');
}

export function parseQuery(json, cfg) {
  const total = typeof json?.totalHits === 'number' ? json.totalHits : null;
  const nextPage = typeof json?.nextPage === 'number' ? json.nextPage : null;
  const list = Array.isArray(json?.jobs) ? json.jobs : [];
  const rows = [];
  const localeSeg = encodeURIComponent(cfg.locale);
  for (const item of list) {
    const d = item?.data;
    if (!d) continue;
    const id = d.id != null ? String(d.id) : '';
    const title = decodeEntities(String(d.title || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    const encodedId = safeEncodeURIComponent(id);
    if (encodedId === null) continue;
    rows.push({
      id,
      title,
      url: `${cfg.origin}/${localeSeg}/job/${slugify(title)}/${encodedId}`,
      location: tkmsLocation(d),
      postedAt: parseTkmsDate(d),
    });
  }
  return { total, nextPage, rows };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export default {
  id: 'tkms',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveConfig({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`tkms: cannot resolve jobs host for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    const jobs = [];
    const seen = new Set();

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      const json = await ctx.fetchJson(cfg.queryApi, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ searchQuery: '', filter: {}, subclient: cfg.subclient, locale: cfg.locale, page }),
      });
      const { nextPage, rows } = parseQuery(json, cfg);
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
      if (nextPage === null) break;
    }
    return jobs;
  },
};
