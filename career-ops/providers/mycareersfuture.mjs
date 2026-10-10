import { intInRange } from './_config-utils.mjs';
import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { fetchJsonWithRetry } from './_http.mjs';

const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 20;

export function parseConfig(entry) {
  const cfg = (entry && entry.mycareersfuture) || {};
  const keywords = [...new Set(
    (Array.isArray(cfg.keywords) ? cfg.keywords : [])
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim()),
  )];
  return {
    keywords,
    size: intInRange(cfg.size, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    maxPages: intInRange(entry && entry.max_pages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP),
  };
}

const TRUSTED_JOB_HOST = 'www.mycareersfuture.gov.sg';

export function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:'
      && parsed.hostname === TRUSTED_JOB_HOST
      && parsed.port === ''
      && parsed.username === ''
      && parsed.password === ''
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

export function normalizeJob(r) {
  const id = r && r.metadata && r.metadata.jobPostId;
  const title = String((r && r.title) || '').trim();
  const url = cleanUrl(r && r.metadata && r.metadata.jobDetailsUrl);
  if (!id || !title || !url) return null;
  const company = String(
    (r.hiringCompany && r.hiringCompany.name)
    || (r.postedCompany && r.postedCompany.name)
    || '',
  ).trim();
  const districts = Array.isArray(r.address && r.address.districts) ? r.address.districts : [];
  const location = districts.map((d) => d && d.location).filter(Boolean).join(', ');
  const result = { title, url, company, location, id: String(id) };
  const posted = Date.parse((r.metadata && r.metadata.newPostingDate) || '');
  if (Number.isFinite(posted)) result.postedAt = posted;
  return result;
}

const API_URL = 'https://api.mycareersfuture.gov.sg/v2/search';

export default {
  id: 'mycareersfuture',

  detect(entry) {
    return entry?.provider === 'mycareersfuture' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const { size, maxPages: configuredMaxPages, keywords: ownKeywords } = parseConfig(entry);
    let keywords = ownKeywords;
    if (!keywords.length) keywords = resolveProfileKeywords();
    if (!keywords.length) {
      throw new Error(`mycareersfuture: entry "${entry?.name || '(unnamed)'}" has no mycareersfuture.keywords[] and no config/profile.yml target_roles to fall back to`);
    }

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pageLimit = probing ? Math.min(ctx.maxPages, configuredMaxPages) : configuredMaxPages;

    const fetchKeyword = async (keyword) => {
      const out = [];
      for (let page = 0; page < pageLimit; page++) {
        const json = await fetchJsonWithRetry(ctx, `${API_URL}?limit=${size}&page=${page}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ search: keyword, sortBy: ['new_posting_date'], page }),
          redirect: 'error',
          timeoutMs: 12_000,
        });
        const results = Array.isArray(json && json.results) ? json.results : [];
        out.push(...results);
        if (results.length < size) break;
      }
      return out;
    };

    const byId = new Map();
    const errors = [];
    let succeeded = 0;
    for (const keyword of keywords) {
      let raw;
      try {
        raw = await fetchKeyword(keyword);
        succeeded++;
      } catch (err) {
        if (probing) throw err;
        errors.push(`"${keyword}": ${(err && err.message) || err}`);
        continue;
      }
      for (const r of raw) {
        const job = normalizeJob(r);
        if (job && !byId.has(job.id)) byId.set(job.id, job);
      }
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`mycareersfuture: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byId.values()].map(({ id, ...job }) => job);
  },
};
