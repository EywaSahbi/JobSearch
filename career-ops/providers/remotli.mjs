import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://remotli.ch';
const API_PATH = '/api/jobs';
const ALL_WORK_MODES = 'remote=all';
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;
const HOST_RE = /^(www\.)?remotli\.ch$/i;

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function resolveUrl(job, safeSlug) {
  const raw = typeof job.applyUrl === 'string' ? job.applyUrl.trim() : '';
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:') return parsed.href;
    } catch {
    }
  }
  return safeSlug ? `${ORIGIN}/jobs/${safeSlug}` : '';
}

function resolveLocation(job) {
  const primary = typeof job.location === 'string' ? job.location.trim() : '';
  const all = Array.isArray(job.allLocations)
    ? job.allLocations.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim())
    : [];
  const merged = [];
  for (const l of [primary, ...all]) {
    if (l && !merged.some(m => m.toLowerCase() === l.toLowerCase())) merged.push(l);
  }
  return merged.join('; ');
}

function resolveSalary(job) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const min = num(job.salaryMin);
  const max = num(job.salaryMax);
  if (min == null && max == null) return null;
  const currency = typeof job.salaryCurrency === 'string' ? job.salaryCurrency.trim().toUpperCase() : '';
  const lo = min ?? max;
  const hi = max ?? min;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi), currency };
}

export function normalizeRemotliJob(row, fallbackCompany) {
  if (!row || typeof row !== 'object') return null;
  const job = row.jobs && typeof row.jobs === 'object' ? row.jobs : null;
  if (!job) return null;

  const title = typeof job.title === 'string' ? job.title.trim() : '';
  if (!title) return null;

  const status = typeof job.status === 'string' ? job.status.trim().toLowerCase() : '';
  if (status !== 'active') return null;

  const slug = typeof job.slug === 'string' ? job.slug.trim() : '';
  const safeSlug = slug && !/[^a-z0-9._~-]/i.test(slug) ? slug : '';
  const url = resolveUrl(job, safeSlug);
  if (!url) return null;

  const companies = row.companies && typeof row.companies === 'object' ? row.companies : {};
  const company =
    (typeof job.company === 'string' && job.company.trim()) ||
    (typeof companies.name === 'string' && companies.name.trim()) ||
    (fallbackCompany || 'Remotli');

  const out = { title, url, company, location: resolveLocation(job) };

  const description = htmlToText(job.description);
  if (description) out.description = description;

  const postedAt = toEpochMs(job.publishedAt || job.createdAt);
  if (postedAt !== undefined) out.postedAt = postedAt;

  const salary = resolveSalary(job);
  if (salary) out.salary = salary;

  return out;
}

function assertRemotliUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`remotli: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`remotli: URL must use HTTPS: ${url}`);
  if (!HOST_RE.test(parsed.hostname))
    throw new Error(`remotli: untrusted hostname "${parsed.hostname}" — must be remotli.ch`);
  return url;
}

export default {
  id: 'remotli',

  detect(entry) {
    const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
    if (!raw) return null;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (!HOST_RE.test(parsed.hostname)) return null;
    return { url: `${ORIGIN}${API_PATH}?page=1&limit=${PAGE_SIZE}&${ALL_WORK_MODES}` };
  },

  async fetch(entry, ctx) {
    const cap =
      Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
        ? ctx.maxPages
        : Number.isInteger(entry?.max_pages) && entry.max_pages > 0
          ? entry.max_pages
          : DEFAULT_MAX_PAGES;

    const out = [];
    let totalPages = 1;
    let succeededOnce = false;

    for (let page = 1; page <= Math.min(cap, totalPages); page++) {
      const url = `${ORIGIN}${API_PATH}?page=${page}&limit=${PAGE_SIZE}&${ALL_WORK_MODES}`;
      assertRemotliUrl(url);

      let rows;
      try {
        const data = await ctx.fetchJson(url, { redirect: 'error' });

        if (!data || typeof data !== 'object' || !Array.isArray((data).jobs)) {
          throw new Error(
            `remotli: unexpected API response — expected { jobs: [...] }, got ${data === null ? 'null' : typeof data}`,
          );
        }

        rows = (data).jobs;

        const reported = Number((data).pagination?.totalPages);
        if (Number.isInteger(reported) && reported > 0) totalPages = reported;
      } catch (err) {
        if (!succeededOnce) throw err;
        break;
      }

      succeededOnce = true;

      for (const row of rows) {
        const job = normalizeRemotliJob(row, entry?.name);
        if (job) out.push(job);
      }

      if (rows.length < PAGE_SIZE) break;
    }

    return out;
  },
};
