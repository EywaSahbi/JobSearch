import { intInRange } from './_config-utils.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { coerceId } from './_ids.mjs';

const ALLOWED_SMARTRECRUITERS_HOSTS = new Set(['api.smartrecruiters.com']);
const SR_CAREERS_HOSTS = new Set(['careers.smartrecruiters.com', 'jobs.smartrecruiters.com']);
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50;
const SR_DETAIL_BATCH = 5;

function parseSmartRecruitersConfig(entry) {
  const cfg = (entry && entry.smartrecruiters) || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

export function extractDescription(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const parts = [];
  for (const key of ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']) {
    const text = sections[key]?.text;
    if (typeof text === 'string' && text.trim()) parts.push(text);
  }
  if (parts.length === 0) return '';
  return htmlToText(parts.join('\n'));
}

function assertSmartRecruitersUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`smartrecruiters: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`smartrecruiters: URL must use HTTPS: ${url}`);
  if (!ALLOWED_SMARTRECRUITERS_HOSTS.has(parsed.hostname)) {
    throw new Error(`smartrecruiters: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_SMARTRECRUITERS_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveSlug(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!SR_CAREERS_HOSTS.has(parsed.hostname)) continue;
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (slug) return slug;
  }
  return null;
}

function buildPostingsUrl(slug, offset = 0) {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
}

function buildPostingDetailUrl(slug, id) {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${encodeURIComponent(id)}`;
}

function resolveApiUrl(entry) {
  const slug = resolveSlug(entry);
  return slug ? buildPostingsUrl(slug, 0) : null;
}

export default {
  id: 'smartrecruiters',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`smartrecruiters: cannot derive API URL for ${entry.name}`);

    const pageLimit = Math.min(
      SR_MAX_PAGES,
      Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity,
    );

    const all = [];
    for (let page = 0; page < pageLimit; page++) {
      const apiUrl = buildPostingsUrl(slug, page * SR_PAGE_SIZE);
      assertSmartRecruitersUrl(apiUrl);
      const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
      const parsed = parseSmartRecruitersResponse(json, entry.name, slug);
      if (parsed.length === 0) break;
      all.push(...parsed);
      if (parsed.length < SR_PAGE_SIZE) break;
    }

    const { fetchDetails, detailLimit } = parseSmartRecruitersConfig(entry);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (fetchDetails && !probing) {
      const jobs = all.filter((job) => job.id).slice(0, detailLimit);
      for (let i = 0; i < jobs.length; i += SR_DETAIL_BATCH) {
        const batch = jobs.slice(i, i + SR_DETAIL_BATCH);
        await Promise.all(batch.map(async (job) => {
          try {
            const detailUrl = buildPostingDetailUrl(slug, job.id);
            assertSmartRecruitersUrl(detailUrl);
            const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
            const description = extractDescription(detail);
            if (description) job.description = description;
          } catch {
          }
        }));
      }
    }

    return all.map(({ id, ...job }) => job);
  },
};

export function parseSmartRecruitersResponse(json, companyName, companySlug) {
  const items = json?.content;
  if (!Array.isArray(items)) return [];
  return items.map(j => {
    const loc = j.location || {};
    const fullLocation = loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    const remote = loc.remote ? 'Remote' : '';
    const location = [fullLocation, remote].filter(Boolean).join(', ');
    const slugified = (j.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let url = '';
    if (typeof j.ref === 'string') {
      let parsedRef;
      try { parsedRef = new URL(j.ref); } catch { parsedRef = null; }
      if (parsedRef
          && parsedRef.protocol === 'https:'
          && parsedRef.hostname === 'api.smartrecruiters.com'
          && parsedRef.pathname.startsWith('/v1/companies/')) {
        const [refSlug, postings, refId] = parsedRef.pathname
          .slice('/v1/companies/'.length)
          .split('/')
          .filter(Boolean);
        if (refSlug && postings === 'postings' && refId) {
          url = `https://jobs.smartrecruiters.com/${refSlug}/${refId}${slugified ? `-${slugified}` : ''}`;
        }
      }
    }
    if (!url && j.id) {
      const fallbackSlug = companySlug || (companyName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (fallbackSlug) {
        url = `https://jobs.smartrecruiters.com/${fallbackSlug}/${j.id}${slugified ? `-${slugified}` : ''}`;
      }
    }
    const requisitionId = coerceId(j.refNumber);
    const language = coerceId(j.language?.code);
    return {
      title: j.name || '',
      url,
      location,
      company: companyName,
      id: typeof j.id === 'string' || typeof j.id === 'number' ? String(j.id) : undefined,
      ...(requisitionId ? { requisitionId } : {}),
      ...(language ? { language } : {}),
    };
  });
}
