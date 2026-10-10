const FEED_BASE = 'https://4dayweek.io/api/jobs';
const TRUSTED_HOST = '4dayweek.io';
const JOB_BASE = `https://${TRUSTED_HOST}/job`;
const PER_PAGE = 25;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function detectFourDayEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider === '4dayweek') return { url: FEED_BASE };
  if (entry.provider) return null;

  for (const value of [entry.api, entry.careers_url]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) {
        return { url: FEED_BASE };
      }
    } catch {
    }
  }
  return null;
}

function assertFourDayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`4dayweek: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`4dayweek: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`4dayweek: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toEpochMs(seconds) {
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function normalize4dwJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;
  if (j.is_expired === true) return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const slug = typeof j.slug === 'string' ? j.slug.trim() : '';
  if (!SLUG_RE.test(slug)) return null;
  const url = `${JOB_BASE}/${encodeURIComponent(slug)}`;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : j.company && typeof j.company === 'object' && typeof j.company.name === 'string' && j.company.name.trim()
        ? j.company.name.trim()
        : typeof fallbackCompany === 'string' && fallbackCompany.trim()
          ? fallbackCompany.trim()
          : '4 Day Week';

  const first = Array.isArray(j.locations) && j.locations[0] && typeof j.locations[0] === 'object' ? j.locations[0] : {};
  const city = typeof first.city === 'string' ? first.city.trim() : '';
  const country = typeof first.country === 'string' ? first.country.trim() : '';
  const base = [city, country].filter(Boolean).join(', ');
  const remote = j.work_arrangement === 'remote' || first.work_arrangement === 'remote';
  const location = [base, remote ? 'Remote' : ''].filter(Boolean).join(', ');

  const job = { title, url, company, location };
  const postedAt = toEpochMs(j.posted);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export default {
  id: '4dayweek',

  detect: detectFourDayEntry,

  async fetch(entry, ctx) {
    assertFourDayUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = `${FEED_BASE}?page=${page}`;
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(
          `4dayweek: unexpected API response on page ${page} — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.jobs) {
        const normalized = normalize4dwJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.has_more === false) break;
      if (json.jobs.length < PER_PAGE) break;
    }
    return out;
  },
};
