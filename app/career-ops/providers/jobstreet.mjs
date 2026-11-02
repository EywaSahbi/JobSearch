import { sleep } from './_http.mjs';

const DEFAULT_API = 'https://id.jobstreet.com/api/jobsearch/v5/search';
const DEFAULT_SITE_KEY = 'ID-Main';
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 3;

const ALLOWED_JOBSTREET_HOSTS = new Set([
  'id.jobstreet.com',
  'www.jobstreet.com',
  'www.jobstreet.co.id',
  'jobstreet.com',
  'jobstreet.co.id',
  'sg.jobstreet.com',
  'my.jobstreet.com',
  'hk.jobsdb.com',
  'www.seek.com.au',
  'www.seek.co.nz',
]);

const V5_SEARCH_PATH = '/api/jobsearch/v5/search';

const ID_LOCALE_HOSTS = new Set(['id.jobstreet.com', 'www.jobstreet.co.id', 'jobstreet.co.id']);

function jobDetailPath(origin) {
  let host = '';
  try { host = new URL(origin).hostname; } catch { }
  return ID_LOCALE_HOSTS.has(host) ? '/id/job/' : '/job/';
}

function assertJobstreetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobstreet: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobstreet: URL must use HTTPS: ${url}`);
  if (!ALLOWED_JOBSTREET_HOSTS.has(parsed.hostname))
    throw new Error(`jobstreet: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_JOBSTREET_HOSTS].join(', ')}`);
  return url;
}

function deriveOrigin(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return 'https://id.jobstreet.com';
  }
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseJobstreetItem(item, origin, fallbackCompany, options = {}) {
  if (!item || typeof item !== 'object') return null;

  let title = (item.title || '').trim();
  if (!title) return null;

  if (options.appendWorkType) {
    const types = Array.isArray(item.workTypes)
      ? item.workTypes.map(t => String(t ?? '').trim()).filter(Boolean)
      : [];
    if (types.length) title = `${title} [${types.join(', ')}]`;
  }

  const jobId = (item.id || '').trim();
  if (!jobId) return null;
  const url = `${origin}${jobDetailPath(origin)}${jobId}`;

  try {
    const parsed = new URL(url);
    if (!ALLOWED_JOBSTREET_HOSTS.has(parsed.hostname)) return null;
  } catch {
    return null;
  }

  const company = (item.advertiser?.description || item.companyName || fallbackCompany || '').trim();
  const location = (item.locations?.[0]?.label || '').trim();
  const postedAt = toEpochMs(item.listingDate);

  return { title, url, company, location, ...(postedAt != null ? { postedAt } : {}) };
}

function buildSearchUrl(origin, params) {
  const url = new URL(V5_SEARCH_PATH, origin);
  const { siteKey, keywords, location, pageSize, page } = params;
  if (siteKey) url.searchParams.set('siteKey', siteKey);
  if (keywords) url.searchParams.set('keywords', keywords);
  if (location) url.searchParams.set('where', location);
  url.searchParams.set('pageSize', String(pageSize || DEFAULT_PAGE_SIZE));
  url.searchParams.set('page', String(page || 1));
  return url.href;
}

export default {
  id: 'jobstreet',

  detect(_entry) {
    return null;
  },

  async fetch(entry, ctx) {
    const apiUrl = entry.api || DEFAULT_API;
    assertJobstreetUrl(apiUrl);
    const origin = deriveOrigin(apiUrl);

    const siteKey = entry.siteKey || DEFAULT_SITE_KEY;
    const keywords = entry.searchKeywords || '';
    const searchLocation = entry.searchLocation || '';
    const pageSize = Number(entry.pageSize) || DEFAULT_PAGE_SIZE;
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;
    const fallbackCompany = entry.name || '';
    const appendWorkType = entry.appendWorkType === true;

    const allJobs = [];

    for (let page = 1; page <= maxPages; page++) {
      const searchUrl = buildSearchUrl(origin, {
        siteKey,
        keywords,
        location: searchLocation,
        pageSize,
        page,
      });

      let json;
      try {
        json = (await ctx.fetchJson(searchUrl, { redirect: 'error' }));
      } catch (err) {
        if (page === 1) throw err;
        console.error(`jobstreet: page ${page} fetch failed — ${err.message}`);
        break;
      }

      const data = Array.isArray(json?.data) ? json.data : [];
      if (data.length === 0) break;

      for (const item of data) {
        const job = parseJobstreetItem(item, origin, fallbackCompany, { appendWorkType });
        if (job) allJobs.push(job);
      }

      if (data.length < pageSize) break;

      await sleep(200, ctx);
    }

    return allJobs;
  },
};
