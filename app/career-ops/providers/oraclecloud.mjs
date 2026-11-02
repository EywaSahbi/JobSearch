import { decodeEntities } from './_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';

const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/i;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const RETRY_POLICY = { retries: 3 };
const INTER_PAGE_DELAY_MS = 250;

const FACETS_LIST = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';

function assertOracleUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`oraclecloud: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`oraclecloud: URL must use HTTPS: ${url}`);
  if (!ORACLE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`oraclecloud: untrusted hostname "${parsed.hostname}" — must match *.fa[.<region>][.ocs].oraclecloud[1-99].com`);
  }
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function resolveSite(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!ORACLE_HOST_RE.test(parsed.hostname)) continue;

    const segs = parsed.pathname.split('/').filter(Boolean);
    const ceIdx = segs.findIndex((s) => s === 'CandidateExperience');
    const lang = ceIdx !== -1 && segs[ceIdx + 1] ? segs[ceIdx + 1] : 'en';
    const sitesIdx = segs.indexOf('sites');
    const siteFromUrl = sitesIdx !== -1 && segs[sitesIdx + 1] ? segs[sitesIdx + 1] : null;

    const overrideSite = typeof entry.siteNumber === 'string' && entry.siteNumber ? entry.siteNumber : null;
    const siteNumber = overrideSite || siteFromUrl || 'CX_1';
    const locationId = entry.locationId != null && `${entry.locationId}` !== ''
      ? `${entry.locationId}`
      : null;

    return { host: parsed.hostname, lang, siteNumber, locationId };
  }
  return null;
}

export function buildApiUrl(site, offset = 0, limit = PAGE_SIZE) {
  const finderParams = [
    `siteNumber=${site.siteNumber}`,
    `facetsList=${FACETS_LIST}`,
    `limit=${limit}`,
    'sortBy=POSTING_DATES_DESC',
    `offset=${offset}`,
  ];
  if (site.locationId) finderParams.push(`locationId=${site.locationId}`);
  const finder = `findReqs;${finderParams.join(',')}`;
  const expand = 'requisitionList.workLocation,requisitionList.secondaryLocations';
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true`
    + `&expand=${encodeURIComponent(expand)}`
    + `&finder=${finder}`
    + `&limit=${limit}&offset=${offset}`;
}

export function buildJobUrl(site, id) {
  return `https://${site.host}/hcmUI/CandidateExperience/${site.lang}/sites/${site.siteNumber}/job/${id}`;
}

function assembleLocation(req) {
  let base = typeof req.PrimaryLocation === 'string' ? req.PrimaryLocation.trim() : '';
  if (!base && Array.isArray(req.workLocation) && req.workLocation.length) {
    const wl = req.workLocation[0] || {};
    base = [wl.TownOrCity, wl.Region, wl.Country].filter((v) => typeof v === 'string' && v.trim()).join(', ');
  }
  const wt = req.WorkplaceTypeCode;
  const remoteHint = wt === 'ORA_REMOTE' ? 'Remote' : wt === 'ORA_HYBRID' ? 'Hybrid' : '';
  return [base, remoteHint].filter(Boolean).join(' · ');
}

export function parseOracleResponse(json, site, companyName) {
  const item = Array.isArray(json?.items) ? json.items[0] : null;
  const list = item && Array.isArray(item.requisitionList) ? item.requisitionList : null;
  if (!list) return [];
  const out = [];
  for (const req of list) {
    if (!req || typeof req !== 'object') continue;
    const id = req.Id != null ? String(req.Id) : (req.RequisitionNumber != null ? String(req.RequisitionNumber) : '');
    const externalUrl = typeof req.ExternalURL === 'string' && req.ExternalURL.trim() ? req.ExternalURL.trim() : '';
    const url = externalUrl || (id ? buildJobUrl(site, id) : '');
    if (!url) continue;
    const job = {
      title: typeof req.Title === 'string' ? req.Title : '',
      url,
      company: companyName,
      location: assembleLocation(req),
    };
    if (typeof req.ShortDescriptionStr === 'string' && req.ShortDescriptionStr.trim()) {
      job.description = decodeEntities(req.ShortDescriptionStr);
    }
    const postedAt = toEpochMs(req.PostedDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    out.push(job);
  }
  return out;
}

export default {
  id: 'oraclecloud',

  detect(entry) {
    try {
      const site = resolveSite(entry);
      return site ? { url: buildApiUrl(site, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: cannot derive API URL for ${entry.name}`);

    const maxPages = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES)
      : MAX_PAGES;

    const all = [];
    let total = null;
    for (let page = 0; page < maxPages; page++) {
      const offset = page * PAGE_SIZE;
      const apiUrl = buildApiUrl(site, offset, PAGE_SIZE);
      assertOracleUrl(apiUrl);
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const json = await fetchJsonWithRetry(ctx, apiUrl, {
        redirect: 'error',
        headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
      }, RETRY_POLICY);

      const parsed = parseOracleResponse(json, site, entry.name);
      all.push(...parsed);

      const item = Array.isArray(json?.items) ? json.items[0] : null;
      if (total === null && item && typeof item.TotalJobsCount === 'number') total = item.TotalJobsCount;
      const listLen = item && Array.isArray(item.requisitionList) ? item.requisitionList.length : 0;

      if (listLen === 0) break;
      if (total !== null) {
        if (offset + PAGE_SIZE >= total) break;
      } else if (listLen < PAGE_SIZE) break;
    }
    return all;
  },
};
