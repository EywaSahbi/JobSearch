import { decodeEntities } from './_html-entities.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';

const SCHOOLSPRING_HOST_RE = /^[a-z0-9][a-z0-9-]*\.schoolspring\.com$/;
const NON_DISTRICT = new Set(['www.schoolspring.com', 'api.schoolspring.com']);

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 200;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveHost(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !SCHOOLSPRING_HOST_RE.test(host) || NON_DISTRICT.has(host)) return null;
  return host;
}

function pageUrl(host, page) {
  const q = new URLSearchParams({
    domainName: host,
    keyword: '',
    location: '',
    category: '',
    gradelevel: '',
    jobtype: '',
    organization: '',
    swLat: '',
    swLon: '',
    neLat: '',
    neLon: '',
    page: String(page),
    size: String(PAGE_SIZE),
    sortDateAscending: 'false',
  });
  return `https://api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch?${q}`;
}

export default {
  id: 'schoolspring',

  detect(entry) {
    const host = resolveHost(entry);
    return host ? { url: `https://${host}/` } : null;
  },

  async fetch(entry, ctx) {
    const host = resolveHost(entry);
    if (!host) throw new Error(`schoolspring: cannot derive district host for ${entry.name} (need an https://<district>.schoolspring.com careers_url)`);

    const ctxMax = Number(ctx?.maxPages);
    const ceiling = resolveMaxPages(entry);
    const pagesToFetch = ctxMax > 0 ? Math.min(ceiling, ctxMax) : ceiling;

    const jobs = [];
    const seen = new Set();
    let lastPageFull = false;
    let stoppedOnRepeat = false;
    let pagesFetched = 0;
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const json = await fetchJsonWithRetry(ctx, pageUrl(host, page), { redirect: 'error' });
      const list = parseSchoolSpringPage(json, entry.name, `https://${host}`);
      pagesFetched++;
      let fresh = 0;
      for (const job of list.jobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        fresh++;
      }
      lastPageFull = list.rawCount >= PAGE_SIZE;
      if (!lastPageFull) break;
      if (fresh === 0) {
        stoppedOnRepeat = true;
        break;
      }
    }
    if (lastPageFull && !stoppedOnRepeat && pagesFetched >= ceiling && !(ctxMax > 0 && ctxMax < ceiling)) {
      console.warn(`schoolspring: ${entry.name}: stopped at ${ceiling} pages (${ceiling * PAGE_SIZE} postings); raise max_pages on this entry`);
    }
    return jobs;
  },
};

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

const clean = (s) => decodeEntities(String(s ?? '')).trim();

export function parseSchoolSpringPage(json, companyName, origin) {
  if (json == null) return { jobs: [], rawCount: 0 };
  if (typeof json !== 'object') throw new Error(`schoolspring: unexpected response type ${typeof json}, expected a JSON object`);
  if (Object.keys(json).length === 0) return { jobs: [], rawCount: 0 };
  if (json.success !== true) throw new Error(`schoolspring: API error: ${json.message || 'response did not report success:true'}`);
  const list = json.value?.jobsList;
  if (!Array.isArray(list)) {
    throw new Error(`schoolspring: unexpected response shape, no jobsList array (${json.value && typeof json.value === 'object' ? `value keys: ${Object.keys(json.value).join(', ') || 'none'}` : `top-level keys: ${Object.keys(json).join(', ')}`})`);
  }
  const jobs = [];
  for (const j of list) {
    const id = String(j?.jobId ?? '').trim();
    const title = clean(j?.title);
    if (!/^\d+$/.test(id) || !title) continue;
    const where = clean(j.location);
    const employer = clean(j.employer);
    const job = {
      title,
      url: `${origin}/?jobid=${id}`,
      company: companyName,
      location: [where, employer].filter(Boolean).join(' - '),
    };
    const postedAt = toEpochMs(j.displayDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return { jobs, rawCount: list.length };
}
