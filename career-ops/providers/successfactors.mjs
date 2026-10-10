import { decodeEntities } from './_html-entities.mjs';

const MAX_PAGES = 40;
const MAX_JOBS = 1000;

const CSB_PAGE_SIZE = 10;
const CSB_MAX_PAGES_PER_LOCALE = 100;
const CSB_MAX_LOCALES = 16;
const CSB_DEFAULT_LOCALES = ['de_DE', 'en_US'];
const CSB_LOCALE_PRIORITY = ['de_DE', 'en_US', 'en_GB', 'en_EN'];

export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const path = u.pathname
    .replace(/\/go\/[^/]+\/\d+(?:\/\d+)?\/?$/i, '')
    .replace(/\/(?:search|tile-search-results|services\/recruiting\/v1\/jobs)\/?$/i, '')
    .replace(/\/+$/, '');
  const base = u.origin + path;
  return {
    origin: u.origin,
    base,
    tileApi: `${base}/tile-search-results/`,
    jobBase: u.origin,
    jobsApi: `${base}/services/recruiting/v1/jobs`,
    searchPage: `${base}/search/`,
  };
}

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function cityFromSlug(dataUrl, title) {
  let path;
  try {
    path = decodeURIComponent(dataUrl);
  } catch {
    path = dataUrl;
  }
  const m = path.match(/\/job\/([^/]+)\//);
  if (!m) return '';
  const slug = m[1].toLowerCase();
  const words = title.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words || !words.length) return '';
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let anchorRe;
  try {
    anchorRe = new RegExp(words.slice(0, 2).map(esc).join('[^\\p{L}\\p{N}]+'), 'u');
  } catch {
    return '';
  }
  const hit = slug.match(anchorRe);
  if (!hit || hit.index === undefined || hit.index <= 0) return '';
  return slug
    .slice(0, hit.index)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseTiles(htmlText, jobBase) {
  const out = [];
  const tileRe = /<li class="job-tile job-id-(\d+)\b[\s\S]*?<\/li>/g;
  let t;
  while ((t = tileRe.exec(htmlText)) !== null) {
    const id = t[1];
    const block = t[0];
    const urlM = block.match(/data-url="([^"]+)"/);
    if (!urlM) continue;
    const titleM = block.match(/class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleM ? clean(titleM[1]) : '';
    if (!title) continue;
    const path = decodeEntities(urlM[1]);
    const cityM = block.match(/id="[^"]*-section-city-value">([\s\S]*?)<\/div>/);
    const city = cityM ? clean(cityM[1]) : cityFromSlug(path, title);
    const url = /^https?:\/\//i.test(path) ? path : jobBase + (path.startsWith('/') ? path : '/' + path);
    out.push({ id, title, url, location: city });
  }
  return out;
}

export function extractLocales(html) {
  const found = new Set();
  const re = /locale=([a-z]{2}_[A-Z]{2})\b/g;
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  const all = [...found];
  const prio = (loc) => {
    const i = CSB_LOCALE_PRIORITY.indexOf(loc);
    return i === -1 ? CSB_LOCALE_PRIORITY.length : i;
  };
  all.sort((a, b) => prio(a) - prio(b) || a.localeCompare(b));
  return all.slice(0, CSB_MAX_LOCALES);
}

export function parseCsbDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  let a, b, year;
  let slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  let dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (slash) {
    [, a, b, year] = slash;
  } else if (dot) {
    [, b, a, year] = dot;
  } else {
    return undefined;
  }
  const month = Number(a);
  const day = Number(b);
  let y = Number(year);
  if (y < 100) y += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(y, month - 1, day);
  return Number.isFinite(ms) ? ms : undefined;
}

export function cleanCsbLocation(raw) {
  const parts = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const cleaned = [];
  for (const p of parts) {
    const s = clean(String(p));
    if (s && !cleaned.includes(s)) cleaned.push(s);
  }
  return cleaned.join(' / ');
}

export function parseCsbJobs(json, cfg, locale) {
  const list = Array.isArray(json?.jobSearchResult) ? json.jobSearchResult : [];
  const out = [];
  for (const item of list) {
    const r = item?.response;
    if (!r) continue;
    const id = r.id != null ? String(r.id) : '';
    const title = clean(String(r.unifiedStandardTitle || r.jobTitle || ''));
    if (!id || !title) continue;
    const slug = decodeEntities(String(r.unifiedUrlTitle || r.urlTitle || 'job'))
      .replace(/[?#&]+/g, '-')
      .replace(/-{2,}/g, '-');
    const url = `${cfg.base || cfg.origin}/job/${slug}/${id}-${locale}`;
    out.push({
      id,
      title,
      url,
      location: cleanCsbLocation(r.jobLocationShort),
      postedAt: parseCsbDate(r.unifiedStandardStart),
    });
  }
  return out;
}

function resolveCsbMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, CSB_MAX_PAGES_PER_LOCALE);
  return CSB_MAX_PAGES_PER_LOCALE;
}

async function fetchCsb(entry, cfg, ctx, { probe = false } = {}) {
  let locales = CSB_DEFAULT_LOCALES;
  try {
    const html = await ctx.fetchText(cfg.searchPage, { redirect: 'error', headers: { accept: 'text/html' } });
    const discovered = extractLocales(html);
    if (discovered.length) locales = discovered;
  } catch {
  }

  const maxPages = resolveCsbMaxPages(entry);
  const jobs = [];
  const seen = new Set();
  let succeededOnce = false;
  let firstErr = null;

  for (const locale of locales) {
    if (jobs.length >= MAX_JOBS) break;
    let total = null;
    for (let page = 0; page < maxPages; page++) {
      let json;
      try {
        json = await ctx.fetchJson(cfg.jobsApi, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ keywords: '', locale, location: '', pageNumber: page, sortBy: 'recent' }),
        });
      } catch (err) {
        firstErr ??= err;
        break;
      }
      succeededOnce = true;
      if (total === null) {
        total = typeof json?.totalJobs === 'number' ? json.totalJobs : null;
      }
      const rawCount = Array.isArray(json?.jobSearchResult) ? json.jobSearchResult.length : 0;
      if (rawCount === 0) break;
      const rows = parseCsbJobs(json, cfg, locale);

      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
        if (jobs.length >= MAX_JOBS) break;
      }
      if (jobs.length >= MAX_JOBS) break;
      if (total !== null && (page + 1) * CSB_PAGE_SIZE >= total) break;
      if (rawCount < CSB_PAGE_SIZE) break;
    }
  }
  if (!probe && !succeededOnce && firstErr) throw firstErr;
  return jobs;
}

async function fetchRmk(entry, cfg, ctx) {
  const jobs = [];
  const seen = new Set();
  let startrow = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const htmlText = await ctx.fetchText(`${cfg.tileApi}?startrow=${startrow}`, {
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    const tiles = parseTiles(htmlText, cfg.jobBase);
    if (tiles.length === 0) break;

    let fresh = 0;
    for (const tile of tiles) {
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      fresh++;
      jobs.push({
        title: tile.title,
        url: tile.url,
        company: entry.name,
        location: tile.location,
      });
    }
    if (fresh === 0) break;
    if (jobs.length >= MAX_JOBS) break;
    startrow += tiles.length;
  }
  return jobs.slice(0, MAX_JOBS);
}

export default {
  id: 'successfactors',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (/successfactors\.(eu|com)|jobs2web\.com/i.test(url)) return { url };
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`successfactors: cannot resolve origin for ${entry.name}`);

    if (String(entry.sfVariant || '').toLowerCase() === 'csb') {
      return fetchCsb(entry, cfg, ctx);
    }
    const rmkJobs = await fetchRmk(entry, cfg, ctx);
    if (rmkJobs.length > 0) return rmkJobs;
    return fetchCsb(entry, cfg, ctx, { probe: true });
  },
};
