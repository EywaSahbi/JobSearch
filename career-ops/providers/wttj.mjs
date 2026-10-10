const ENV_URL = 'https://www.welcometothejungle.com/api/env';
const SITE_ORIGIN = 'https://www.welcometothejungle.com';
const INDEX = 'wttj_jobs_production_en';
const DEFAULT_MAX_HITS = 100;
const MAX_HITS_CAP = 200;
const FILTERED_MAX_HITS_CAP = 1000;
const FILTERS_MAX_LEN = 1000;

function assertHost(url, host, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`wttj: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`wttj: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== host.toLowerCase()) {
    throw new Error(`wttj: untrusted ${label} hostname "${parsed.hostname}" — must be ${host}`);
  }
  return url;
}

export function parseEnvPayload(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('wttj: /api/env payload has no JSON object');
  let env;
  try {
    env = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('wttj: /api/env payload is not valid JSON');
  }
  const appId = typeof env.PUBLIC_ALGOLIA_APPLICATION_ID === 'string' ? env.PUBLIC_ALGOLIA_APPLICATION_ID.trim() : '';
  const apiKey = typeof env.PUBLIC_ALGOLIA_API_KEY_CLIENT === 'string' ? env.PUBLIC_ALGOLIA_API_KEY_CLIENT.trim() : '';
  if (!/^[A-Z0-9]{6,16}$/i.test(appId)) throw new Error(`wttj: unexpected Algolia app id "${appId}"`);
  if (!apiKey || apiKey.length < 16 || apiKey.length > 500) {
    throw new Error('wttj: unexpected Algolia api key shape');
  }
  return { appId, apiKey };
}

export function normalizeWttjHit(h) {
  if (!h || typeof h !== 'object') return null;
  const title = typeof h.name === 'string' ? h.name.trim() : '';
  const slug = typeof h.slug === 'string' ? h.slug.trim() : '';
  const orgSlug = typeof h.organization?.slug === 'string' ? h.organization.slug.trim() : '';
  if (!title || !slug || !orgSlug) return null;
  if (!/^[a-z0-9_-]+$/i.test(slug) || !/^[a-z0-9_-]+$/i.test(orgSlug)) return null;

  const url = `${SITE_ORIGIN}/en/companies/${orgSlug}/jobs/${slug}`;
  const company =
    typeof h.organization?.name === 'string' && h.organization.name.trim()
      ? h.organization.name.trim()
      : 'Welcome to the Jungle';

  const office = Array.isArray(h.offices) && h.offices.length > 0 ? h.offices[0] : null;
  const parts = [];
  if (office && typeof office.city === 'string' && office.city.trim()) parts.push(office.city.trim());
  if (office && typeof office.country === 'string' && office.country.trim()) parts.push(office.country.trim());
  if (h.remote === 'fulltime') parts.push('Remote');
  const location = parts.join(', ');

  const job = { title, url, company, location };

  const ts = h.published_at_timestamp;
  if (Number.isFinite(ts) && ts > 0) job.postedAt = ts * 1000;

  const min = Number.isFinite(h.salary_yearly_minimum) && h.salary_yearly_minimum > 0 ? h.salary_yearly_minimum : 0;
  const max =
    h.salary_period === 'yearly' && Number.isFinite(h.salary_maximum) && h.salary_maximum > 0
      ? h.salary_maximum
      : 0;
  if (min || max) {
    job.salary = {
      min: min || max,
      max: max || min,
      currency: typeof h.salary_currency === 'string' ? h.salary_currency.trim().toUpperCase() : '',
    };
  }
  return job;
}

function resolveConfig(entry) {
  const cfg = entry?.wttj && typeof entry.wttj === 'object' ? entry.wttj : {};
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    : [];
  const filters = typeof cfg.filters === 'string' && cfg.filters.trim() ? cfg.filters.trim() : '';
  if (filters.length > FILTERS_MAX_LEN) {
    throw new Error(`wttj: \`filters\` is too long (${filters.length} > ${FILTERS_MAX_LEN} chars)`);
  }
  if (queries.length === 0 && !filters) {
    throw new Error(
      'wttj: the WTTJ board is global — narrow it with `wttj: { filters: "…" }` and/or `wttj: { queries: ["…"] }`',
    );
  }
  const effectiveQueries = queries.length > 0 ? queries : [''];
  const cap = filters ? FILTERED_MAX_HITS_CAP : MAX_HITS_CAP;
  const maxHits =
    Number.isInteger(cfg.max_hits) && cfg.max_hits > 0 ? Math.min(cfg.max_hits, cap) : DEFAULT_MAX_HITS;
  return { queries: effectiveQueries, filters, maxHits };
}

export default {
  id: 'wttj',

  detect(entry) {
    return entry?.provider === 'wttj' ? { url: SITE_ORIGIN } : null;
  },

  async fetch(entry, ctx) {
    const { queries, filters, maxHits } = resolveConfig(entry);

    const envText = await ctx.fetchText(assertHost(ENV_URL, 'www.welcometothejungle.com', 'env'), {
      redirect: 'error',
    });
    const { appId, apiKey } = parseEnvPayload(envText);
    const algoliaHost = `${appId}-dsn.algolia.net`;

    const byUrl = new Map();
    for (const query of queries) {
      const url = assertHost(
        `https://${algoliaHost}/1/indexes/${INDEX}/query`,
        algoliaHost,
        'algolia',
      );
      const params = new URLSearchParams({
        query,
        hitsPerPage: String(maxHits),
        attributesToRetrieve:
          'name,slug,organization,offices,remote,published_at_timestamp,salary_yearly_minimum,salary_maximum,salary_period,salary_currency',
      });
      if (filters) params.set('filters', filters);
      const json = (
        await ctx.fetchJson(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'x-algolia-application-id': appId,
            'x-algolia-api-key': apiKey,
            referer: `${SITE_ORIGIN}/`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ params: params.toString() }),
        })
      );
      if (!json || !Array.isArray(json.hits)) {
        throw new Error(
          `wttj: unexpected Algolia response for query "${query}" — expected { hits: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const h of json.hits) {
        const job = normalizeWttjHit(h);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }
    return [...byUrl.values()];
  },
};
