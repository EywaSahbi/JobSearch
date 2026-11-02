import { safeEncodeURIComponent } from './_safe-url.mjs';

const FEED_BASE = 'https://thehub.io/api/v2/jobsandfeatured';
const TRUSTED_HOST = 'thehub.io';
const DEFAULT_COUNTRY_CODE = 'EU';
const PER_PAGE = 15;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 67;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export function parseThehubConfig(entry) {
  const cfg = (entry && entry.thehub) || {};
  const countryCode = typeof cfg.countryCode === 'string' && cfg.countryCode.trim()
    ? cfg.countryCode.trim()
    : DEFAULT_COUNTRY_CODE;
  return { countryCode, includeRemote: cfg.includeRemote === true };
}

export function normalizeHubJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const id = typeof j.id === 'string' ? j.id.trim() : '';
  if (!id) return null;
  const encodedId = safeEncodeURIComponent(id);
  if (encodedId === null) return null;
  const url = `https://${TRUSTED_HOST}/jobs/${encodedId}`;

  const company =
    j.company && typeof j.company === 'object' && typeof j.company.name === 'string' && j.company.name.trim()
      ? j.company.name.trim()
      : typeof fallbackCompany === 'string' && fallbackCompany.trim()
        ? fallbackCompany.trim()
        : 'The Hub';

  const loc = j.location && typeof j.location === 'object' ? j.location : {};
  const address = typeof loc.address === 'string' ? loc.address.trim() : '';
  const locality = typeof loc.locality === 'string' ? loc.locality.trim() : '';
  const country = typeof loc.country === 'string' ? loc.country.trim() : '';
  const base = address || [locality, country].filter(Boolean).join(', ');
  const location = [base, j.isRemote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  return { title, url, company, location };
}

async function fetchScope(query, maxPages, fallbackCompany, byUrl, ctx, state) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${FEED_BASE}?page=${page}&${query}`;
    let jobs;
    try {
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      jobs = json && json.jobs;
      if (!jobs || !Array.isArray(jobs.docs)) {
        throw new Error(
          `thehub: unexpected API response on page ${page} — expected { jobs: { docs: [...] } }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
    } catch (err) {
      if (!state.succeededOnce) throw err;
      console.error(`  ⚠ thehub: query "${query}" page ${page} failed (${err.message}) — keeping the ${byUrl.size} jobs collected so far`);
      return false;
    }
    state.succeededOnce = true;
    for (const j of jobs.docs) {
      const normalized = normalizeHubJob(j, fallbackCompany);
      if (normalized && !byUrl.has(normalized.url)) byUrl.set(normalized.url, normalized);
    }
    if (jobs.docs.length < PER_PAGE) break;
    if (Number.isInteger(jobs.pages) && page >= jobs.pages) break;
  }
  return true;
}

export default {
  id: 'thehub',

  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const { countryCode, includeRemote } = parseThehubConfig(entry);
    const fallbackCompany = entry?.name;
    const byUrl = new Map();
    const state = { succeededOnce: false };

    const regionOk = await fetchScope(`countryCode=${encodeURIComponent(countryCode)}`, maxPages, fallbackCompany, byUrl, ctx, state);
    if (regionOk && includeRemote) {
      await fetchScope('isRemote=true', maxPages, fallbackCompany, byUrl, ctx, state);
    }

    return [...byUrl.values()];
  },
};
