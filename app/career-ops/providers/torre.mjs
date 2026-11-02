const SEARCH_ENDPOINT = 'https://search.torre.co/opportunities/_search';
const TRUSTED_API_HOST = 'search.torre.co';
const POSTING_BASE = 'https://torre.ai/post/';
const PAGE_SIZE = 20;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const EXPERIENCE_LEVELS = new Set([
  'potential-to-develop',
  '1-plus-year',
  '2-plus-years',
  '3-plus-years',
  '5-plus-years',
]);
const DEFAULT_EXPERIENCE = '1-plus-year';

function assertTorreUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`torre: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`torre: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_API_HOST) {
    throw new Error(`torre: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_API_HOST}`);
  }
  return url;
}

export function buildTorreQuery(entry) {
  const body = {};

  const search = typeof entry?.search === 'string' ? entry.search.trim() : '';
  if (search) {
    const configured = typeof entry?.experience === 'string' ? entry.experience.trim() : '';
    if (configured && !EXPERIENCE_LEVELS.has(configured)) {
      throw new Error(
        `torre: invalid experience "${configured}" — must be one of: ${[...EXPERIENCE_LEVELS].join(', ')}`,
      );
    }
    body['skill/role'] = { text: search, experience: configured || DEFAULT_EXPERIENCE };
  }

  if (entry?.remote_only === true) body.remote = { term: true };

  return body;
}

export function normalizeTorreOpportunity(o, fallbackCompany) {
  if (!o || typeof o !== 'object') return null;

  const title = typeof o.objective === 'string' ? o.objective.trim() : '';
  if (!title) return null;

  if (typeof o.status === 'string' && o.status.trim() && o.status.trim() !== 'open') return null;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!ID_RE.test(id)) return null;
  const url = `${POSTING_BASE}${id}`;

  let company = '';
  if (Array.isArray(o.organizations)) {
    const named = o.organizations.find(
      (org) => org && typeof org.name === 'string' && org.name.trim(),
    );
    if (named) company = named.name.trim();
  }
  if (!company) company = fallbackCompany || 'Torre';

  const countries = Array.isArray(o.locations)
    ? o.locations.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : [];
  let location = countries.join(', ');
  if (o.remote === true) location = location ? `Remote — ${location}` : 'Remote';

  const job = { title, url, company, location };

  if (typeof o.created === 'string' && o.created.trim()) {
    const ms = Date.parse(o.created);
    if (Number.isFinite(ms)) job.postedAt = ms;
  }

  return job;
}

export default {
  id: 'torre',

  async fetch(entry, ctx) {
    assertTorreUrl(SEARCH_ENDPOINT);
    const body = JSON.stringify(buildTorreQuery(entry));
    const fallbackCompany = entry?.name;

    const url = `${SEARCH_ENDPOINT}?offset=0&size=${PAGE_SIZE}`;
    const json = await ctx.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
    });

    if (!json || !Array.isArray(json.results)) {
      throw new Error(
        `torre: unexpected API response — expected { results: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
      );
    }

    const out = [];
    const seen = new Set();
    for (const o of json.results) {
      const normalized = normalizeTorreOpportunity(o, fallbackCompany);
      if (!normalized || seen.has(normalized.url)) continue;
      seen.add(normalized.url);
      out.push(normalized);
    }
    return out;
  },
};
