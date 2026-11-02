import { safeEncodeURIComponent } from './_safe-url.mjs';

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { intInRange } from './_config-utils.mjs';
import { htmlToText } from './_html-to-text.mjs';

const ADP_HOST = 'workforcenow.adp.com';
const API_BASE = `https://${ADP_HOST}/mascsr/default/careercenter/public/events/staffing/v1`;

const PAGE_SIZE = 20;

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
    if (parsed.hostname.toLowerCase() !== ADP_HOST) continue;
    const cid = parsed.searchParams.get('cid');
    const ccId = parsed.searchParams.get('ccId');
    if (cid && ccId) return { cid, ccId };
  }
  return null;
}

function buildListUrl(cid, ccId, skip) {
  const u = new URL(`${API_BASE}/job-requisitions`);
  u.searchParams.set('cid', cid);
  u.searchParams.set('ccId', ccId);
  u.searchParams.set('$skip', String(skip));
  u.searchParams.set('$top', String(PAGE_SIZE));
  return u.href;
}

function buildDetailUrl(itemId, cid, ccId) {
  const u = new URL(`${API_BASE}/job-requisitions/${safeEncodeURIComponent(itemId)}`);
  u.searchParams.set('cid', cid);
  u.searchParams.set('ccId', ccId);
  u.searchParams.set('lang', 'en_US');
  u.searchParams.set('locale', 'en_US');
  return u.href;
}

function assertAdpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`adp-workforcenow: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`adp-workforcenow: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== ADP_HOST) {
    throw new Error(`adp-workforcenow: untrusted hostname "${parsed.hostname}" — must be ${ADP_HOST}`);
  }
  return url;
}

function findCustomField(customFieldGroup, groupKey, codeValue) {
  const list = customFieldGroup?.[groupKey];
  if (!Array.isArray(list)) return null;
  return list.find((f) => f?.nameCode?.codeValue === codeValue) ?? null;
}

export function extractExternalJobId(customFieldGroup) {
  const field = findCustomField(customFieldGroup, 'stringFields', 'ExternalJobID');
  const v = field?.stringValue;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function toEpochMs(value) {
  if (!value) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function extractPostedAt(job) {
  const direct = toEpochMs(job?.postDate);
  if (direct !== undefined) return direct;
  const field = findCustomField(job?.customFieldGroup, 'dateFields', 'PostingDate');
  return toEpochMs(field?.dateValue);
}

export function extractLocation(job) {
  const list = Array.isArray(job?.requisitionLocations) ? job.requisitionLocations : [];
  const out = [];
  for (const loc of list) {
    const nameCode = loc?.nameCode;
    let label = (nameCode?.shortName || nameCode?.longName || '').trim();
    if (!label) {
      const addr = loc?.address;
      const city = (addr?.cityName || '').trim();
      const region = (addr?.countrySubdivisionLevel1?.codeValue || '').trim();
      const country = (addr?.country?.codeValue || '').trim();
      label = [city, region, country].filter(Boolean).join(', ');
    }
    if (label && !out.includes(label)) out.push(label);
  }
  return out.join(' / ');
}

export function extractSalary(job) {
  const range = job?.payGradeRange;
  const minAmt = range?.minimumRate?.amountValue;
  const maxAmt = range?.maximumRate?.amountValue;
  const min = typeof minAmt === 'number' && Number.isFinite(minAmt) ? minAmt : null;
  const max = typeof maxAmt === 'number' && Number.isFinite(maxAmt) ? maxAmt : null;
  if (min !== null || max !== null) {
    const currency = range?.minimumRate?.currencyCode || range?.maximumRate?.currencyCode || '';
    return {
      ...(min !== null ? { min } : {}),
      ...(max !== null ? { max } : {}),
      ...(typeof currency === 'string' && currency ? { currency } : {}),
    };
  }

  const salaryRange = findCustomField(job?.customFieldGroup, 'stringFields', 'SalaryRange')?.stringValue;
  const symbolOrCode = findCustomField(job?.customFieldGroup, 'stringFields', 'CurrencySymbolOrCode')?.stringValue;
  if (typeof salaryRange === 'string' && salaryRange.trim()) {
    if (/\bhour(?:ly)?\b|\bper\s+hour\b/i.test(salaryRange)) return null;
    const nums = (salaryRange.match(/[\d,]+(?:\.\d+)?/g) || [])
      .map((n) => Number(n.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n));
    if (nums.length > 0) {
      return {
        min: Math.min(...nums),
        max: Math.max(...nums),
        currency: typeof symbolOrCode === 'string' && /^[A-Z]{3}$/.test(symbolOrCode.trim())
          ? symbolOrCode.trim()
          : '',
      };
    }
  }
  return null;
}

export function buildPostingUrl(cid, ccId, itemId, externalJobId) {
  const jobId = externalJobId || itemId;
  if (safeEncodeURIComponent(jobId) === null || safeEncodeURIComponent(itemId) === null) return null;
  const u = new URL(`https://${ADP_HOST}/mascsr/default/mdf/recruitment/recruitment.html`);
  u.searchParams.set('cid', cid);
  u.searchParams.set('ccId', ccId);
  u.searchParams.set('lang', 'en_US');
  u.searchParams.set('type', 'JS');
  u.searchParams.set('jobId', jobId);
  u.searchParams.set('jwId', itemId);
  return u.href;
}

export function parseListPage(json, cfg) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('adp-workforcenow: unrecognized job-requisitions response');
  }
  if (!Array.isArray(json.jobRequisitions) && (!json.meta || typeof json.meta !== 'object' || Array.isArray(json.meta))) {
    throw new Error('adp-workforcenow: unrecognized job-requisitions response');
  }
  if (json.meta && typeof json.meta === 'object' && !Array.isArray(json.meta)
    && typeof json.meta.totalNumber === 'number' && json.meta.totalNumber > 0
    && !Array.isArray(json.jobRequisitions)) {
    throw new Error('adp-workforcenow: response has a positive totalNumber but no jobRequisitions array');
  }
  const raw = Array.isArray(json.jobRequisitions) ? json.jobRequisitions : [];
  const total = typeof json?.meta?.totalNumber === 'number' ? json.meta.totalNumber : null;
  const jobs = [];
  for (const job of raw) {
    if (!job || typeof job !== 'object') continue;
    const itemId = typeof job.itemID === 'string' ? job.itemID.trim() : '';
    const title = typeof job.requisitionTitle === 'string' ? job.requisitionTitle.trim() : '';
    if (!itemId || !title) continue;
    const externalJobId = extractExternalJobId(job.customFieldGroup);
    const url = buildPostingUrl(cfg.cid, cfg.ccId, itemId, externalJobId);
    if (!url) continue;
    const row = {
      title,
      url,
      company: cfg.companyName,
      location: extractLocation(job),
    };
    const postedAt = extractPostedAt(job);
    if (postedAt !== undefined) row.postedAt = postedAt;
    const salary = extractSalary(job);
    if (salary) row.salary = salary;
    jobs.push(Object.assign(row, { _itemId: itemId }));
  }
  return { jobs, total, raw };
}

function parseAdpConfig(entry) {
  const cfg = (entry && entry.adpWorkforcenow) || {};
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
  id: 'adp-workforcenow',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: buildListUrl(tenant.cid, tenant.ccId, 1) } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`adp-workforcenow: cannot derive cid/ccId for ${entry.name}`);
    const { cid, ccId } = tenant;
    const cfg = { cid, ccId, companyName: entry.name };

    const maxPages = resolveMaxPages(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const pageLimit = Math.min(maxPages, ctxCap);

    const jobs = [];
    const seen = new Set();
    let skip = 1;
    let total = null;
    let cappedIncomplete = false;

    for (let page = 0; page < pageLimit; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const listUrl = assertAdpUrl(buildListUrl(cid, ccId, skip));
      const json = await fetchJsonWithRetry(ctx, listUrl, { redirect: 'error' }, RETRY_POLICY);

      if (json && typeof json === 'object' && !Array.isArray(json.jobRequisitions) && json.meta === undefined) {
        throw new Error(`adp-workforcenow: unrecognized job-requisitions response for ${entry.name} — keys: ${Object.keys(json).join(', ') || '(none)'}`);
      }

      const { jobs: pageJobs, total: pageTotal, raw } = parseListPage(json, cfg);
      if (pageTotal !== null) total = pageTotal;

      if (raw.length === 0) break;

      let fresh = 0;
      for (const job of pageJobs) {
        const { _itemId, ...clean } = (job);
        if (seen.has(_itemId)) continue;
        seen.add(_itemId);
        fresh++;
        jobs.push(Object.assign(clean, { _itemId }));
      }
      if (fresh === 0) break;

      skip += raw.length;
      if (raw.length < PAGE_SIZE) break;
      if (page === pageLimit - 1) cappedIncomplete = true;
    }

    const truncated = cappedIncomplete && ctxCap === Infinity;
    if (truncated) {
      const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
      console.error(`⚠️  adp-workforcenow: ${entry.name} truncated at max_pages=${maxPages} (${jobsSummary}) — raise max_pages on this entry for more`);
    }

    const { fetchDetails, detailLimit } = parseAdpConfig(entry);
    const probing = ctxCap !== Infinity;
    if (fetchDetails && !probing) {
      const targets = jobs.slice(0, detailLimit);
      for (const target of targets) {
        const job = (target);
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        try {
          const detailUrl = assertAdpUrl(buildDetailUrl(job._itemId, cid, ccId));
          const detail = await fetchJsonWithRetry(ctx, detailUrl, { redirect: 'error' }, RETRY_POLICY);
          const description = htmlToText(detail?.requisitionDescription);
          if (description) job.description = description;
        } catch {
        }
      }
    }

    const result = jobs.map(({ _itemId, ...job }) => job);
    if (truncated) (result).adpTruncated = true;
    return result;
  },
};
