import { fetchJsonWithRetry } from './_http.mjs';

const FEED_BASE = 'https://speedrun-talent-network.com/api/v1/jobs';
const TRUSTED_HOST = 'speedrun-talent-network.com';
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 6;
const MAX_PAGES_CAP = 1000;

function assertFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`a16z-speedrun-talent: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`a16z-speedrun-talent: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`a16z-speedrun-talent: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveQuery(entry) {
  if (typeof entry?.q === 'string' && entry.q.trim()) return entry.q.trim();
  if (Array.isArray(entry?.keywords) && entry.keywords.length > 0) {
    const joined = entry.keywords.filter((k) => typeof k === 'string' && k.trim()).join(' ').trim();
    if (joined) return joined;
  }
  return null;
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeSpeedrunJob(j, fallbackCompany) {
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
    typeof j.company === 'string' && j.company.trim()
      ? j.company.trim()
      : typeof fallbackCompany === 'string' && fallbackCompany.trim()
        ? fallbackCompany.trim()
        : 'a16z speedrun talent network';

  const base = typeof j.location === 'string' ? j.location.trim() : '';
  const location = [base, j.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  const job = { title, url, company, location };
  const postedAt = toEpochMs(j.published_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

export default {
  id: 'a16z-speedrun-talent',

  detect(entry) {
    for (const candidate of [entry?.careers_url, entry?.api]) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) {
          return { url: candidate };
        }
      } catch {
      }
    }
    return null;
  },

  async fetch(entry, ctx) {
    assertFeedUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry);
    const q = resolveQuery(entry);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ page: String(page), source: 'career-ops' });
      if (q) params.set('q', q);
      const url = `${FEED_BASE}?${params}`;
      const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(
          `a16z-speedrun-talent: unexpected API response on page ${page} — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.jobs) {
        const normalized = normalizeSpeedrunJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.jobs.length === 0) break;
      if (Number.isInteger(json.total_pages) && json.total_pages > 0) {
        if (page + 1 >= json.total_pages) break;
      } else if (json.jobs.length < PER_PAGE) {
        break;
      }
      if (page + 1 >= maxPages && Number.isInteger(json.total_pages) && json.total_pages > maxPages) {
        const name = typeof fallbackCompany === 'string' && fallbackCompany ? fallbackCompany : 'a16z speedrun talent network';
        console.error(
          `⚠️  a16z-speedrun-talent: ${name} truncated at max_pages=${maxPages} (${out.length} of ${Number.isInteger(json.total) ? json.total : 'many'} jobs) — raise max_pages on this entry or narrow with q: for more`,
        );
      }
    }
    return out;
  },
};
