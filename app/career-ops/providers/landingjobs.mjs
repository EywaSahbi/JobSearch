const FEED_URL = 'https://landing.jobs/api/v1/jobs';
const TRUSTED_HOST = 'landing.jobs';

function assertLandingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`landingjobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`landingjobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`landingjobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function companyFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs[0] !== 'at' || !segs[1]) return '';
  return segs[1]
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function normalizeLandingJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) url = parsed.href;
    } catch {
    }
  }
  if (!url) return null;

  const company =
    companyFromUrl(url) ||
    (typeof fallbackCompany === 'string' && fallbackCompany.trim() ? fallbackCompany.trim() : 'Landing.jobs');

  const first = Array.isArray(j.locations) && j.locations[0] && typeof j.locations[0] === 'object' ? j.locations[0] : {};
  const city = typeof first.city === 'string' ? first.city.trim() : '';
  const country = typeof first.country_code === 'string' ? first.country_code.trim() : '';
  const base = [city, country].filter(Boolean).join(', ');
  const location = [base, j.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  const job = { title, url, company, location };
  const postedAt = toEpochMs(j.published_at) ?? toEpochMs(j.created_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export default {
  id: 'landingjobs',

  async fetch(entry, ctx) {
    assertLandingUrl(FEED_URL);
    const json = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!Array.isArray(json)) {
      throw new Error(
        `landingjobs: unexpected API response — expected a JSON array, got ${json === null ? 'null' : typeof json}`,
      );
    }
    const fallbackCompany = entry?.name;
    return json.map(j => normalizeLandingJob(j, fallbackCompany)).filter(Boolean);
  },
};
