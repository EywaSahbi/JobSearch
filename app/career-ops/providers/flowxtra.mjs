const JOBS_ENDPOINT = 'https://app.flowxtra.com/api/central/jobs';
const TRUSTED_ENDPOINT_HOST = 'app.flowxtra.com';
const TRUSTED_APPLY_HOST = 'flowxtra.com';
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;

function assertFlowxtraEndpointUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`flowxtra: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`flowxtra: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_ENDPOINT_HOST) {
    throw new Error(`flowxtra: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_ENDPOINT_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeFlowxtraJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = typeof j.urlJobApplay === 'string' ? j.urlJobApplay.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_APPLY_HOST) url = parsed.href;
    } catch {
    }
  }
  if (!url) return null;

  const company =
    typeof j.name_company === 'string' && j.name_company.trim()
      ? j.name_company.trim()
      : fallbackCompany || 'Flowxtra';

  const parts = [j.city_company, j.state_company, j.country_company]
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim());
  const remote = j.workplace === 'Remote' ? 'Remote' : '';
  const location = [...parts, remote].filter(Boolean).join(', ');

  const job = { title, url, company, location };
  const postedAt = toEpochMs(j.date_share);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export default {
  id: 'flowxtra',

  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = `${JOBS_ENDPOINT}?status=Live&per_page=${PER_PAGE}&page=${page}`;
      assertFlowxtraEndpointUrl(url);
      const json = (await ctx.fetchJson(url, { redirect: 'error' }));
      const rows = json?.data?.data;
      if (!Array.isArray(rows)) {
        throw new Error(
          `flowxtra: unexpected API response on page ${page} — expected { data: { data: [...] } }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of rows) {
        const normalized = normalizeFlowxtraJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (!json.data.next_page_url || rows.length < PER_PAGE) break;
    }
    return out;
  },
};
