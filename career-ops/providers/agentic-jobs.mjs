import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';
import { countryName } from './_country.mjs';

const SITE_ORIGIN = 'https://agentic-engineering-jobs.com';
const API_BASE = `${SITE_ORIGIN}/api/v1`;
const TRUSTED_HOST = 'agentic-engineering-jobs.com';
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const MAX_JOBS = 2000;
const PAGE_DELAY_MS = 2100;

function assertAgenticUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`agentic-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`agentic-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`agentic-jobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

export { countryName };

export function stripHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  const noMedia = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noMedia.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function normalizeAgenticLocation(j) {
  if (typeof j?.location === 'string' && j.location.trim()) return j.location.trim();
  const countries = Array.isArray(j?.countries) ? j.countries : [];
  const names = [...new Set(countries.map(countryName).filter(Boolean))];
  if (names.length) return names.join(' / ');
  return typeof j?.geoRegion === 'string' ? j.geoRegion.trim() : '';
}

export function normalizeAgenticSalary(j) {
  const hasMin = typeof j?.salaryMin === 'number' && Number.isFinite(j.salaryMin);
  const hasMax = typeof j?.salaryMax === 'number' && Number.isFinite(j.salaryMax);
  if (!hasMin && !hasMax) return null;
  const salary = {};
  if (hasMin) salary.min = j.salaryMin;
  if (hasMax) salary.max = j.salaryMax;
  const currency = typeof j?.salaryCurrency === 'string' ? j.salaryCurrency.trim().toUpperCase() : '';
  if (currency) salary.currency = currency;
  return salary;
}

export function normalizeAgenticJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = typeof j.title === 'string' ? j.title.trim() : '';
  const company = typeof j.companyName === 'string' ? j.companyName.trim() : '';
  const slug = typeof j.slug === 'string' ? j.slug.trim() : '';
  if (!title || !company || !slug || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;

  const job = {
    title,
    url: `${SITE_ORIGIN}/jobs/${slug}`,
    company,
    location: normalizeAgenticLocation(j),
  };

  const description = stripHtml(j.description);
  if (description) job.description = description;

  const posted = typeof j.postedAt === 'string' ? Date.parse(j.postedAt) : NaN;
  if (Number.isFinite(posted)) job.postedAt = posted;

  const salary = normalizeAgenticSalary(j);
  if (salary) job.salary = salary;

  return job;
}

export default {
  id: 'agentic-jobs',

  detect(entry) {
    return entry?.provider === 'agentic-jobs' ? { url: SITE_ORIGIN } : null;
  },

  async fetch(_entry, ctx) {
    const jobs = [];
    const seen = new Set();
    let total = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS, ctx);
      const url = assertAgenticUrl(`${API_BASE}/jobs?page=${page}`);
      const json = await ctx.fetchJson(url, { redirect: 'error', headers: { accept: 'application/json' } });
      if (!json || !Array.isArray(json.data)) {
        throw new Error(`agentic-jobs: unexpected API response shape on page ${page} — "data" is missing or not an array`);
      }
      const records = json.data;
      if (total === null) total = typeof json.meta?.total === 'number' ? json.meta.total : null;
      const effectivePageSize = typeof json.meta?.per_page === 'number' && json.meta.per_page > 0 ? json.meta.per_page : PAGE_SIZE;

      for (const record of records) {
        const job = normalizeAgenticJob(record);
        if (job && !seen.has(job.url)) {
          seen.add(job.url);
          jobs.push(job);
        }
      }

      if (jobs.length >= MAX_JOBS) break;
      if (records.length < effectivePageSize) break;
      if (total !== null && page * effectivePageSize >= total) break;
    }

    if (jobs.length === 0) {
      throw new Error('agentic-jobs: parsed 0 jobs from the API — the response shape likely changed');
    }
    return jobs.slice(0, MAX_JOBS);
  },
};
