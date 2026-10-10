import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { resolveProfileKeywords } from './_profile-keywords.mjs';

const API_BASE = 'https://portal.gupy.io/api/job-search/jobs';
const API_HOST = 'portal.gupy.io';
const PLATFORM_HOSTS = new Set([API_HOST, 'employability-portal.gupy.io']);
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 100;
const INTER_REQUEST_DELAY_MS = 200;

const EARLY_STOP_MARGIN_MS = 2 * 86_400_000;

const CONFIDENTIAL_EMPLOYER = /^(?:empresa\s+)?confidencial$/i;

function isSafeGupyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'gupy.io' || host.endsWith('.gupy.io'));
  } catch {
    return false;
  }
}

function assertApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gupy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`gupy: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== API_HOST) {
    throw new Error(`gupy: untrusted hostname "${parsed.hostname}"; must be ${API_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function searchConfig(entry) {
  const cfg = entry?.gupy;
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}

function resolveKeywords(cfg) {
  if (Array.isArray(cfg.keywords)) {
    const list = cfg.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
    if (list.length > 0) return list;
  }
  if (typeof cfg.q === 'string' && cfg.q.trim()) return [cfg.q.trim()];
  return resolveProfileKeywords();
}

function resolveSinceDays(cfg) {
  const v = cfg.since_days;
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function sinceDaysToCutoffMs(days, now = Date.now()) {
  if (days === null) return null;
  const d = new Date(now - days * 86_400_000);
  if (Number.isNaN(d.getTime())) return null;
  return Date.parse(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

export function pageIsPastWindow(pageJobs, cutoffMs) {
  if (typeof cutoffMs !== 'number') return false;
  const dated = pageJobs.map((j) => j?.postedAt).filter((v) => typeof v === 'number');
  if (dated.length === 0) return false;
  return Math.min(...dated) < cutoffMs - EARLY_STOP_MARGIN_MS;
}

function listParam(value) {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  return list.length > 0 ? list.join(',') : null;
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function extractGupyRows(json, keyword, page) {
  const rows = json && typeof json === 'object' && Array.isArray(json.data) ? json.data : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? `keys: [${Object.keys(json).join(', ')}]` : `type: ${json === null ? 'null' : typeof json}`;
    throw new Error(`gupy: unexpected API response for "${keyword}" page ${page}: expected { data: [...] }, got ${got}`);
  }
  return rows;
}

export function buildGupyLocation(j) {
  const parts = [];
  const type = typeof j?.workplaceType === 'string' ? j.workplaceType.trim() : '';
  if (type) {
    parts.push({ remote: 'Remoto', hybrid: 'Híbrido', 'on-site': 'Presencial' }[type] || type);
  } else if (j?.isRemoteWork === true) {
    parts.push('Remoto');
  }
  for (const field of ['city', 'state', 'country']) {
    const v = j?.[field];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  return parts.join(', ');
}

export function normalizeGupyApiJob(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.isConfidentialCareerPage === true) return null;

  const title = typeof j.name === 'string' ? j.name.trim() : '';
  if (!title) return null;

  const rawUrl = typeof j.jobUrl === 'string' ? j.jobUrl.trim() : '';
  if (!isSafeGupyUrl(rawUrl)) return null;

  const company = typeof j.careerPageName === 'string' ? j.careerPageName.trim() : '';
  if (!company || CONFIDENTIAL_EMPLOYER.test(company)) return null;

  const job = {
    title,
    url: rawUrl,
    company,
    location: buildGupyLocation(j),
  };
  if (typeof j.description === 'string' && j.description) job.description = j.description;
  const postedAt = toEpochMs(j.publishedDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export default {
  id: 'gupy',

  detect(entry) {
    if (entry?.provider === 'gupy') return { url: API_BASE };
    for (const candidate of [entry?.careers_url, entry?.api]) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:' && PLATFORM_HOSTS.has(parsed.hostname.toLowerCase())) {
          return { url: candidate };
        }
      } catch {
      }
    }
    return null;
  },

  async fetch(entry, ctx) {
    assertApiUrl(API_BASE);
    const maxPages = resolveMaxPages(entry);
    const cfg = searchConfig(entry);
    const keywords = resolveKeywords(cfg);
    if (keywords.length === 0) {
      throw new Error(
        `gupy: entry "${entry?.name || '(unnamed)'}" has no gupy.keywords[]/gupy.q and no config/profile.yml target_roles to fall back to`,
      );
    }
    const workplaceTypes = listParam(cfg.workplace_types);
    const jobTypes = listParam(cfg.job_types);
    const state = typeof cfg.state === 'string' ? cfg.state.trim() : '';
    if (typeof cfg.country === 'string' && cfg.country.trim()) {
      console.error(
        `⚠️  gupy: entry "${entry?.name || '(unnamed)'}" sets gupy.country, but the Gupy API has no country filter; it is ignored`,
      );
    }

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pageBudget = probing ? ctx.maxPages : Infinity;
    let pagesAttempted = 0;

    const ctxCutoff = typeof ctx?.sinceMs === 'number' ? ctx.sinceMs : null;
    const entryCutoff = sinceDaysToCutoffMs(resolveSinceDays(cfg));
    const cutoffMs = ctxCutoff ?? entryCutoff;
    const filterCutoff = ctxCutoff === null ? entryCutoff : null;

    const seen = new Set();
    const out = [];

    let firstError = null;
    let succeededOnce = false;

    for (const keyword of keywords) {
      if (pagesAttempted >= pageBudget) break;
      for (let page = 0; page < maxPages; page++) {
        if (pagesAttempted >= pageBudget) break;
        const params = new URLSearchParams({
          jobName: keyword,
          offset: String(page * PER_PAGE),
          limit: String(PER_PAGE),
        });
        if (workplaceTypes) params.set('workplaceType', workplaceTypes);
        if (jobTypes) params.set('type', jobTypes);
        if (state) params.set('state', state);

        const url = assertApiUrl(`${API_BASE}?${params}`);
        if (pagesAttempted > 0) await sleep(INTER_REQUEST_DELAY_MS, ctx);
        pagesAttempted++;
        let rows;
        try {
          const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
          rows = extractGupyRows(json, keyword, page);
        } catch (err) {
          if (probing) throw err;
          if (firstError === null) firstError = err;
          console.error(`⚠️  gupy: sweep "${keyword}" stopped at page ${page}: ${err?.message || String(err)}`);
          break;
        }
        succeededOnce = true;

        const pageJobs = [];
        for (const raw of rows) {
          const normalized = normalizeGupyApiJob(raw);
          if (!normalized) continue;
          pageJobs.push(normalized);
          if (seen.has(normalized.url)) continue;
          seen.add(normalized.url);
          if (filterCutoff !== null && typeof normalized.postedAt === 'number'
              && normalized.postedAt < filterCutoff) {
            continue;
          }
          out.push(normalized);
        }

        if (rows.length < PER_PAGE) break;
        if (pageIsPastWindow(pageJobs, cutoffMs)) break;
        if (page + 1 >= maxPages) {
          const remedy = maxPages < MAX_PAGES_CAP
            ? 'raise max_pages on this entry for more'
            : `the API serves no deeper, so split "${keyword}" into narrower keywords`;
          console.error(
            `⚠️  gupy: "${keyword}" truncated at max_pages=${maxPages} (${maxPages * PER_PAGE} postings read, feed has more); ${remedy}`,
          );
        }
      }
    }

    if (!succeededOnce && firstError !== null) throw firstError;
    return out;
  },
};
