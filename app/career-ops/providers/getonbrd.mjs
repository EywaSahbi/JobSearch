const FEED_HOST = 'https://www.getonbrd.com';
const TRUSTED_HOST = 'www.getonbrd.com';
const DEFAULT_CATEGORY = 'programming';
const CATEGORY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const MAX_CATEGORIES = 12;

function feedBase(category) {
  return `${FEED_HOST}/api/v0/categories/${category}/jobs`;
}

export function resolveCategories(entry) {
  const raw = entry?.categories !== undefined ? entry.categories : entry?.category;
  if (raw === undefined || raw === null) return [DEFAULT_CATEGORY];

  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const c of list) {
    if (typeof c !== 'string' || !CATEGORY_SLUG_RE.test(c.trim())) {
      throw new Error(
        `getonbrd: invalid category ${JSON.stringify(c)} — expected a slug like "programming" or "machine-learning-ai"`,
      );
    }
    const slug = c.trim();
    if (!out.includes(slug)) out.push(slug);
  }
  if (!out.length) {
    throw new Error('getonbrd: `categories` is empty — omit it to use the "programming" default');
  }
  if (out.length > MAX_CATEGORIES) {
    throw new Error(
      `getonbrd: ${out.length} categories configured — cap is ${MAX_CATEGORIES} (each one costs up to max_pages requests)`,
    );
  }
  return out;
}

function assertGetonbrdUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`getonbrd: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`getonbrd: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`getonbrd: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export function normalizeGetonbrdJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object' || !j.attributes || typeof j.attributes !== 'object') return null;
  const attr = j.attributes;

  const title = typeof attr.title === 'string' ? attr.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = j.links && typeof j.links.public_url === 'string' ? j.links.public_url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) url = parsed.href;
    } catch {
    }
  }
  if (!url) return null;

  const name = attr.company?.data?.attributes?.name;
  const company =
    typeof name === 'string' && name.trim() ? name.trim() : fallbackCompany || 'Get on Board';

  let location = '';
  if (attr.remote === true) {
    location = 'Remote';
  } else if (Array.isArray(attr.countries)) {
    location = attr.countries
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim())
      .join(', ');
  } else if (typeof attr.countries === 'string') {
    location = attr.countries.trim();
  }

  const job = { title, url, company, location };
  if (Number.isFinite(attr.published_at) && attr.published_at > 0) job.postedAt = attr.published_at * 1000;
  return job;
}

export default {
  id: 'getonbrd',

  async fetch(entry, ctx) {
    const categories = resolveCategories(entry);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];
    const seen = new Set();

    for (const category of categories) {
      const base = assertGetonbrdUrl(feedBase(category));

      for (let page = 1; page <= maxPages; page++) {
        const url = `${base}?per_page=${PER_PAGE}&expand[]=company&page=${page}`;
        const json = await ctx.fetchJson(url, { redirect: 'error' });
        if (!json || !Array.isArray(json.data)) {
          throw new Error(
            `getonbrd: unexpected API response for category "${category}" on page ${page} — expected { data: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
          );
        }
        for (const j of json.data) {
          const normalized = normalizeGetonbrdJob(j, fallbackCompany);
          if (!normalized || seen.has(normalized.url)) continue;
          seen.add(normalized.url);
          out.push(normalized);
        }
        if (json.data.length < PER_PAGE) break;
      }
    }
    return out;
  },
};
