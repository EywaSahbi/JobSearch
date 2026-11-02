import { fetchJsonWithRetry, fetchTextWithRetry, sleep } from './_http.mjs';
import { intInRange } from './_config-utils.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const HOST_RE = /^recruiting\d*\.ultipro\.(?:com|ca)$/i;

const PATH_RE = /^\/([^/]+)\/JobBoard\/([^/]+)(?:\/|$)/;

const PAGE_SIZE = 50;

const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CAP = 1500;

const RETRY_POLICY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

const INTER_PAGE_DELAY_MS = 250;

function resolveTenant(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!HOST_RE.test(parsed.hostname)) continue;
    const m = parsed.pathname.match(PATH_RE);
    if (!m) continue;
    const [, tenant, boardId] = m;
    if (!tenant || !boardId) continue;
    return { origin: `https://${parsed.hostname}`, tenant, boardId };
  }
  return null;
}

export function assertUltiproUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ultipro: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ultipro: URL must use HTTPS: ${url}`);
  if (!HOST_RE.test(parsed.hostname)) {
    throw new Error(`ultipro: untrusted hostname "${parsed.hostname}" — must match recruiting[N].ultipro.com/.ca`);
  }
  return url;
}

function buildListUrl(origin, tenant, boardId) {
  return `${origin}/${tenant}/JobBoard/${boardId}/JobBoardView/LoadSearchResults`;
}

function buildDetailUrl(origin, tenant, boardId, opportunityId) {
  const seg = safeEncodeURIComponent(opportunityId);
  if (seg === null) return null;
  return `${origin}/${tenant}/JobBoard/${boardId}/OpportunityDetail?opportunityId=${seg}`;
}

function buildListBody(skip, top) {
  return {
    opportunitySearch: {
      Top: top,
      Skip: skip,
      QueryString: '',
      OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      Filters: [],
    },
    matchCriteria: {
      PreferredJobs: [],
      Educations: [],
      LicenseAndCertifications: [],
      Skills: [],
      hasNoLicenses: false,
      SkippedSkills: [],
    },
  };
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function extractLocations(locations) {
  if (!Array.isArray(locations)) return '';
  const out = [];
  for (const loc of locations) {
    let label = '';
    if (typeof loc === 'string') {
      label = loc.trim();
    } else if (loc && typeof loc === 'object') {
      const city = String(loc.Address?.City || '').trim();
      const state = String(loc.Address?.State?.Code || '').trim();
      label = [city, state].filter(Boolean).join(', ');
      if (!label) label = String(loc.LocalizedName || '').trim();
    }
    if (label && !out.includes(label)) out.push(label);
  }
  return out.join(' / ');
}

export function parseListPage(json, cfg) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(json.opportunities)) {
    const shape = json && typeof json === 'object' && !Array.isArray(json)
      ? `keys: ${Object.keys(json).join(', ') || '(none)'}`
      : `type: ${Array.isArray(json) ? 'array' : typeof json}`;
    throw new Error(`ultipro: unrecognized LoadSearchResults response for ${cfg.companyName} — ${shape}`);
  }
  const raw = json.opportunities;
  const total = typeof json.totalCount === 'number' ? json.totalCount : null;
  const jobs = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.Id === 'number' ? String(item.Id) : (typeof item.Id === 'string' ? item.Id.trim() : '');
    const title = typeof item.Title === 'string' ? item.Title.trim() : '';
    if (!id || !title) continue;
    const seg = safeEncodeURIComponent(id);
    if (seg === null) continue;
    const url = `${cfg.origin}/${cfg.tenant}/JobBoard/${cfg.boardId}/OpportunityDetail?opportunityId=${seg}`;
    const row = {
      title,
      url,
      company: cfg.companyName,
      location: extractLocations(item.Locations),
    };
    const postedAt = toEpochMs(item.PostedDate);
    if (postedAt !== undefined) row.postedAt = postedAt;
    const description = htmlToText(item.BriefDescription);
    if (description) row.description = description;
    jobs.push(Object.assign(row, { _id: id }));
  }
  return { jobs, total, raw };
}

export function extractCandidateOpportunityDetail(html, expectedId) {
  if (typeof html !== 'string' || !html) return { status: 'not-found' };
  const marker = 'CandidateOpportunityDetail(';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return { status: 'not-found' };
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) throw new Error('ultipro: detail marker has no JSON object');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        let detail;
        try {
          detail = JSON.parse(html.slice(start, i + 1));
        } catch (err) {
          throw new Error(`ultipro: malformed detail JSON — ${ (err).message}`);
        }
        if (!detail || !detail.Id || !detail.Title) {
          throw new Error('ultipro: malformed UKG detail — missing Id/Title');
        }
        if (String(detail.Id) !== String(expectedId)) {
          throw new Error(`ultipro: detail ID mismatch — expected ${expectedId}, got ${detail.Id}`);
        }
        return { status: 'ok', detail };
      }
    }
  }
  throw new Error('ultipro: unbalanced detail JSON');
}

function parseUltiproConfig(entry) {
  const cfg = (entry && entry.ultipro) || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

export default {
  id: 'ultipro',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: buildListUrl(tenant.origin, tenant.tenant, tenant.boardId) } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`ultipro: cannot derive tenant/boardId for ${entry.name}`);
    const { origin, tenant: tenantId, boardId } = tenant;
    const cfg = { origin, tenant: tenantId, boardId, companyName: entry.name };
    const listUrl = assertUltiproUrl(buildListUrl(origin, tenantId, boardId));

    const maxPages = resolveMaxPages(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const pageLimit = Math.min(maxPages, ctxCap);

    const jobs = [];
    const seen = new Set();
    let skip = 0;
    let total = null;
    let cappedIncomplete = false;

    for (let page = 0; page < pageLimit; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const body = JSON.stringify(buildListBody(skip, PAGE_SIZE));
      const json = await fetchJsonWithRetry(ctx, listUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      }, RETRY_POLICY);

      const { jobs: pageJobs, total: pageTotal, raw } = parseListPage(json, cfg);
      if (pageTotal !== null) total = pageTotal;

      if (raw.length === 0) break;

      let fresh = 0;
      for (const job of pageJobs) {
        const { _id, ...clean } = (job);
        if (seen.has(_id)) continue;
        seen.add(_id);
        fresh++;
        jobs.push(Object.assign(clean, { _id }));
      }

      const shortPage = raw.length < PAGE_SIZE;
      if (fresh === 0) {
        if (!shortPage && ctxCap === Infinity) {
          cappedIncomplete = true;
          console.error(`⚠️  ultipro: ${entry.name} pagination made no progress on a full page; results may be incomplete`);
        }
        break;
      }
      if (shortPage) break;

      skip += raw.length;

      if (page === pageLimit - 1) cappedIncomplete = true;
    }

    const truncated = cappedIncomplete && ctxCap === Infinity;
    if (truncated) {
      const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
      console.error(`⚠️  ultipro: ${entry.name} truncated at max_pages=${maxPages} (${jobsSummary}) — raise max_pages on this entry for more`);
    }

    const { fetchDetails, detailLimit } = parseUltiproConfig(entry);
    const probing = ctxCap !== Infinity;
    if (fetchDetails && !probing) {
      const targets = jobs.slice(0, detailLimit);
      for (const job of (targets)) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        try {
          const detailUrl = buildDetailUrl(origin, tenantId, boardId, job._id);
          if (!detailUrl) continue;
          assertUltiproUrl(detailUrl);
          const html = await fetchTextWithRetry(ctx, detailUrl, { redirect: 'error' }, RETRY_POLICY);
          const result = extractCandidateOpportunityDetail(html, job._id);
          if (result.status !== 'ok') continue;
          const description = htmlToText(result.detail.Description);
          if (description) job.description = description;
        } catch {
        }
      }
    }

    const result = jobs.map(({ _id, ...job }) => job);
    if (truncated) (result).ultiproTruncated = true;
    return result;
  },
};
