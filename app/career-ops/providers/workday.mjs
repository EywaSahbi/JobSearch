import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';

const STOP_REASON = {
  COMPLETE: 'complete',
  EARLY_STOP: 'early-stop',
  NO_DATE_SKIP: 'no-date-skip',
  FETCH_ERROR: 'fetch-error',
  CAP: 'cap',
};

export const WORKDAY_TRUNCATED_REASON = {
  TRANSIENT: 'transient',
  STRUCTURAL: 'structural',
};

const PAGE_SIZE = 20;

const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CAP = 1500;

const RETRY_POLICY = { retries: 3 };

const INTER_PAGE_DELAY_MS = 250;

const WORKDAY_OFFSET_CEILING = 2000;

const MAX_SPLIT_DEPTH = 2;

const MAX_SPLIT_SLICES = 100;

const SPLIT_PAGE_BUDGET_FACTOR = 5;

const EARLY_STOP_MARGIN_MS = 2 * 86_400_000;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

const WORKDAY_MAINTENANCE_MARKER = 'community.workday.com/maintenance-page';
const WORKDAY_OUTAGE_REDIRECT_RE = /^https:\/\/[a-z0-9.-]+\.myworkday\.com\/wday\/drs\/outage(?:[/?]|$)/i;
const CONFIRMED_DEAD_API_STATUSES = new Set([422, 401, 403]);

async function confirmDeadViaCareersPage(ep, ctx) {
  try {
    const body = await ctx.fetchText(ep.jobBase, {
      redirect: 'manual',
      headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
    });
    return typeof body === 'string' && body.includes(WORKDAY_MAINTENANCE_MARKER);
  } catch (err) {
    if (err.status >= 300 && err.status < 400) return WORKDAY_OUTAGE_REDIRECT_RE.test(err.location || '');
    return typeof err.body === 'string' && err.body.includes(WORKDAY_MAINTENANCE_MARKER);
  }
}

function facetCoverage(facet) {
  const values = Array.isArray(facet?.values) ? facet.values : [];
  let sum = 0;
  let counted = 0;
  for (const v of values) {
    if (!Number.isInteger(v?.count) || v.count < 0) continue;
    sum += v.count;
    counted++;
  }
  return counted > 0 ? sum : null;
}

export function trueTotalFromFacets(facets) {
  let best = null;
  for (const facet of Array.isArray(facets) ? facets : []) {
    const coverage = facetCoverage(facet);
    if (coverage === null) continue;
    if (best === null || coverage > best) best = coverage;
  }
  return best;
}

function normalizedHintValues(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
}

function facetLooksLikeLocation(facet) {
  const identity = `${facet?.facetParameter || ''} ${facet?.descriptor || ''}`.toLowerCase();
  return /location|country|region|state|province|city|remote|geography|geo/.test(identity);
}

function locationValueScore(value, hints) {
  const text = String(value?.descriptor || '').trim().toLowerCase();
  if (!text) return -1;
  const alwaysAllow = normalizedHintValues(hints?.always_allow);
  const allow = normalizedHintValues([...(hints?.allow || []), ...(hints?.positive || [])]);
  const block = normalizedHintValues([...(hints?.block || []), ...(hints?.block_hard || [])]);
  if (block.some((term) => text.includes(term)) && !alwaysAllow.some((term) => text.includes(term))) return -1;
  if (alwaysAllow.some((term) => text.includes(term))) return 3;
  if (allow.some((term) => text.includes(term))) return 2;
  return 0;
}

export function chooseSplitFacet(facets, { exclude = [], locationHints } = {}) {
  const skip = new Set(exclude);
  const candidates = [];
  let best = null;
  for (const facet of Array.isArray(facets) ? facets : []) {
    const facetParameter = facet?.facetParameter;
    if (typeof facetParameter !== 'string' || !facetParameter || skip.has(facetParameter)) continue;
    const values = (Array.isArray(facet.values) ? facet.values : []).filter(
      (v) => typeof v?.id === 'string' && v.id && Number.isInteger(v?.count) && v.count >= 0,
    );
    if (values.length < 2) continue;
    candidates.push({ facet, values });
    const largest = Math.max(...values.map((v) => v.count));
    if (best === null || largest < best.largest || (largest === best.largest && values.length > best.values.length)) {
      best = { facetParameter, values, largest };
    }
  }

  if (locationHints && typeof locationHints === 'object') {
    const locationCandidates = candidates
      .filter(({ facet }) => facetLooksLikeLocation(facet))
      .map(({ facet, values }) => ({
        facetParameter: facet.facetParameter,
        values: values
          .map((value) => ({ value, score: locationValueScore(value, locationHints) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || b.value.count - a.value.count)
          .map(({ value }) => value),
      }))
      .filter(({ values }) => values.length > 0);
    if (locationCandidates.length > 0) {
      locationCandidates.sort((a, b) => b.values.length - a.values.length);
      return locationCandidates[0];
    }
  }

  return best ? { facetParameter: best.facetParameter, values: best.values } : null;
}

export function pageIsPastWindow(pageJobs, sinceMs) {
  if (typeof sinceMs !== 'number') return false;
  const dated = pageJobs.map((j) => j.postedAt).filter((v) => typeof v === 'number');
  if (dated.length === 0) return false;
  return Math.min(...dated) < sinceMs - EARLY_STOP_MARGIN_MS;
}

const CAREERS_RE = /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/;
const CXS_RE = /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/wday\/cxs\/([\w-]+)\/([^/?#]+)(?:\/jobs)?(?:[/?#]|$)/;
const SITE_RE = /^https:\/\/([\w-]+)\.myworkdaysite\.com\/recruiting\/([\w-]+)\/([^/?#]+)/;

function makeEndpoint(origin, tenant, site) {
  return {
    api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    jobBase: `${origin}/${site}`,
    cxsBase: `${origin}/wday/cxs/${tenant}/${site}`,
    origin,
  };
}

function makeSiteEndpoint(host, tenant, site) {
  const origin = `https://${host}`;
  return {
    api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    jobBase: `${origin}/recruiting/${tenant}/${site}`,
    cxsBase: `${origin}/wday/cxs/${tenant}/${site}`,
    origin,
  };
}

function resolveEndpoint(entry) {
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    const cxs = url.match(CXS_RE);
    if (cxs) {
      const [, host, instance, tenant, site] = cxs;
      return makeEndpoint(`https://${host}.${instance}.myworkdayjobs.com`, tenant, site);
    }
    const siteMatch = url.match(SITE_RE);
    if (siteMatch) {
      const [, instance, tenant, siteName] = siteMatch;
      return makeSiteEndpoint(`${instance}.myworkdaysite.com`, tenant, siteName);
    }
    const m = url.match(CAREERS_RE);
    if (!m) continue;
    const [, tenant, instance, site] = m;
    return makeEndpoint(`https://${tenant}.${instance}.myworkdayjobs.com`, tenant, site);
  }
  return null;
}

const REQ_TOKEN_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function reqTokenFromSegment(segment) {
  const underscoreIdx = segment.indexOf('_');
  if (underscoreIdx === -1) return '';
  return stripRepostSuffixKeepCase(segment.slice(underscoreIdx + 1));
}

const REQ_SHAPE_RE = /\d/;

function validReqToken(segment) {
  const token = reqTokenFromSegment(segment);
  if (token.length < 3 || !REQ_TOKEN_CHARS_RE.test(token)) return '';
  return REQ_SHAPE_RE.test(token) ? token : '';
}

function reqTokenFromPath(externalPath) {
  if (typeof externalPath !== 'string') return undefined;
  return validReqToken(externalPath.split('/').filter(Boolean).pop() || '') || undefined;
}

function reqFromWorkday(j) {
  return reqTokenFromPath(j.externalPath);
}

function parsePostedOn(label) {
  if (!label) return undefined;
  if (/posted\s+today/i.test(label)) return Date.now();
  if (/posted\s+yesterday/i.test(label)) return Date.now() - 86_400_000;
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === '+') return undefined;
  return Date.now() - Number(m[1]) * 86_400_000;
}

function locationFromPath(externalPath) {
  const m = String(externalPath || '').match(/\/job\/([^/]+)\//);
  if (!m) return '';
  let segment;
  try { segment = decodeURIComponent(m[1]); } catch { segment = m[1]; }
  return segment.replace(/-/g, ' ');
}

export function stripWorkdayRepostSuffix(raw) {
  const token = raw == null ? '' : String(raw).toLowerCase();
  return stripRepostSuffixKeepCase(token);
}

function stripRepostSuffixKeepCase(token) {
  const m = token.match(/^(.*?)-(\d{1,2})$/);
  if (!m) return token;
  const base = m[1];
  const isDisambiguator = base.includes('-')
    ? /^[a-z-]*\d[a-z0-9_-]*\d{2,}$/i.test(base) && /^[1-9]$/.test(m[2])
    : /^[a-z]*\d[a-z0-9_]*\d{2,}$/i.test(base);
  return isDisambiguator ? base : token;
}

export function isWorkdayJobUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return /\.myworkday(jobs|site)\.com$/.test(parsed.hostname.toLowerCase());
}

export function workdayDedupKey(job) {
  if (!isWorkdayJobUrl(job?.url)) return null;
  const parsed = new URL(job.url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return null;
  const reqId = validReqToken(lastSegment).toLowerCase();
  if (!reqId) return null;
  let scope = parsed.hostname.toLowerCase();
  if (scope.endsWith('.myworkdaysite.com')) {
    const tenant = parsed.pathname.match(/^\/recruiting\/([\w-]+)\//)?.[1];
    if (!tenant) return null;
    scope += `/recruiting/${tenant.toLowerCase()}`;
  }
  return `workday:${scope}:${reqId}`;
}

const MULTI_LOCATION_PLACEHOLDER_RE = /^\s*\d+\s+locations?\s*$/i;

export function isMultiLocationPlaceholder(location) {
  return typeof location === 'string' && MULTI_LOCATION_PLACEHOLDER_RE.test(location);
}

const MAX_DETAIL_REQUESTS = 200;

export function locationsFromDetail(detail) {
  const info = detail?.jobPostingInfo;
  if (!info || typeof info !== 'object') return '';
  const extra = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
  const places = [info.location, ...extra]
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.trim());
  return [...new Set(places)].join(' · ');
}

export function postedAtFromDetail(detail) {
  const raw = detail?.jobPostingInfo?.startDate;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const shape = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(trimmed);
  if (!shape) return undefined;
  const [, y, m, d] = shape;
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  if (asUtc.getUTCFullYear() !== Number(y) || asUtc.getUTCMonth() !== Number(m) - 1 || asUtc.getUTCDate() !== Number(d)) {
    return undefined;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseWorkdayResponse(json, entry) {
  const ep = resolveEndpoint(entry);
  const jobBase = ep?.jobBase || '';
  const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  const jobs = [];
  for (const j of postings) {
    if (j == null) continue;
    if (!j.externalPath || !String(j.title || '').trim()) continue;
    jobs.push({
      title: j.title || '',
      url: jobBase + j.externalPath,
      company: entry.name,
      requisitionId: reqFromWorkday(j),
      location: j.locationsText || locationFromPath(j.externalPath),
      postedAt: parsePostedOn(j.postedOn),
    });
  }
  return jobs;
}

export default {
  id: 'workday',

  detect(entry) {
    const ep = resolveEndpoint(entry);
    return ep ? { url: ep.api } : null;
  },

  dedupKey: workdayDedupKey,

  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`workday: cannot derive CXS endpoint for ${entry.name}`);

    const postOpts = {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': BROWSER_LIKE_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
        origin: ep.origin,
        referer: `${ep.jobBase}/`,
      },
    };
    const makeBody = (offset, appliedFacets) => JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '', appliedFacets });
    const sinceMs = typeof ctx?.sinceMs === 'number' ? ctx.sinceMs : null;
    const maxPages = resolveMaxPages(entry);

    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;

    const pageBudget = maxPages * SPLIT_PAGE_BUDGET_FACTOR;
    let pagesSpent = 0;
    let budgetExhausted = false;

    const isClamped = (total, facets) => {
      if (ctxCap !== Infinity) return false;
      if (total === null || total > WORKDAY_OFFSET_CEILING) return false;
      const trueTotal = trueTotalFromFacets(facets);
      return trueTotal !== null && trueTotal > WORKDAY_OFFSET_CEILING;
    };

    const runQuery = async (appliedFacets) => {
      pagesSpent++;
      const first = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(0, appliedFacets) }, RETRY_POLICY);
      const jobs = parseWorkdayResponse(first, entry);

      const total = typeof first?.total === 'number' ? first.total : null;
      const facets = Array.isArray(first?.facets) ? first.facets : [];
      const firstPostings = Array.isArray(first?.jobPostings) ? first.jobPostings : [];

      let pagesToFetch = total !== null
        ? Math.min(Math.ceil(total / PAGE_SIZE), maxPages)
        : (firstPostings.length >= PAGE_SIZE ? maxPages : 1);
      pagesToFetch = Math.min(pagesToFetch, ctxCap);

      let stopReason = STOP_REASON.COMPLETE;
      if (pageIsPastWindow(jobs, sinceMs)) stopReason = STOP_REASON.EARLY_STOP;
      const sawAnyDatedPosting = jobs.some((j) => typeof j.postedAt === 'number');

      if (stopReason === STOP_REASON.COMPLETE && sinceMs !== null && ctx?.includeUndated !== true
        && !sawAnyDatedPosting && jobs.length > 0) {
        stopReason = STOP_REASON.NO_DATE_SKIP;
      }

      const clamped = stopReason === STOP_REASON.COMPLETE && isClamped(total, facets);

      let page = 1;
      if (stopReason === STOP_REASON.COMPLETE) {
        for (; page < pagesToFetch; page++) {
          if (pagesSpent >= pageBudget) { budgetExhausted = true; break; }
          await sleep(INTER_PAGE_DELAY_MS, ctx);
          pagesSpent++;
          let json;
          try {
            json = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(page * PAGE_SIZE, appliedFacets) }, RETRY_POLICY);
          } catch (err) {
            const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
            const attempts = err.attempts ?? RETRY_POLICY.retries + 1;
            console.error(`⚠️  workday: ${entry.name} truncated at ${page + 1} of ${pagesToFetch} pages after ${attempts} attempts (${jobsSummary}): ${err.message}`);
            stopReason = STOP_REASON.FETCH_ERROR;
            break;
          }
          const pageJobs = parseWorkdayResponse(json, entry);
          jobs.push(...pageJobs);
          if (total === null) {
            const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
            if (postings.length < PAGE_SIZE) break;
          }
          if (pageIsPastWindow(pageJobs, sinceMs)) { stopReason = STOP_REASON.EARLY_STOP; break; }
        }
        if (stopReason === STOP_REASON.COMPLETE && page === pagesToFetch && pagesToFetch === maxPages) {
          stopReason = STOP_REASON.CAP;
        }
      }

      return { jobs, total, facets, stopReason, clamped };
    };

    let root;
    try {
      root = await runQuery({});
    } catch (err) {
      if (CONFIRMED_DEAD_API_STATUSES.has(err.status) && await confirmDeadViaCareersPage(ep, ctx)) {
        const notFound = new Error(`workday: ${entry.name} confirmed dead (maintenance page)`);
        notFound.status = 404;
        throw notFound;
      }
      throw err;
    }
    const { total, stopReason } = root;

    let splitIncomplete = false;
    let splitStructural = false;
    let slicesSpent = 0;
    let jobs = root.jobs;

    if (root.clamped) {
      const seen = new Set();
      const out = [];
      const absorb = (pageJobs) => {
        for (const job of pageJobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          out.push(job);
        }
      };

      const split = async (result, applied, depth, excluded) => {
        absorb(result.jobs);
        if (result.stopReason === STOP_REASON.FETCH_ERROR) {
          splitIncomplete = true;
        } else if (result.stopReason === STOP_REASON.CAP && !result.clamped) {
          splitIncomplete = true;
          splitStructural = true;
        }
        if (!result.clamped) return;

        if (depth >= MAX_SPLIT_DEPTH) { splitIncomplete = true; splitStructural = true; return; }
        const facet = chooseSplitFacet(result.facets, {
          exclude: excluded,
          locationHints: ctx?.locationHints,
        });
        if (!facet) { splitIncomplete = true; splitStructural = true; return; }

        const chosenCoverage = facet.values.reduce((sum, v) => sum + v.count, 0);
        const trueTotal = trueTotalFromFacets(result.facets);
        if (trueTotal !== null) {
          const others = [];
          for (const f of Array.isArray(result.facets) ? result.facets : []) {
            if (f?.facetParameter === facet.facetParameter) continue;
            const coverage = facetCoverage(f);
            if (coverage !== null) others.push(coverage);
          }
          const spread = others.length > 0 ? Math.max(...others) - Math.min(...others) : 0;
          if (trueTotal - chosenCoverage > spread) { splitIncomplete = true; splitStructural = true; }
        }

        for (const value of facet.values) {
          if (slicesSpent >= MAX_SPLIT_SLICES) { splitIncomplete = true; splitStructural = true; break; }
          if (pagesSpent >= pageBudget) { splitIncomplete = true; splitStructural = true; break; }
          slicesSpent++;
          await sleep(INTER_PAGE_DELAY_MS, ctx);
          const nextApplied = { ...applied, [facet.facetParameter]: [value.id] };
          let sliceResult;
          try {
            sliceResult = await runQuery(nextApplied);
          } catch (err) {
            const attempts = err.attempts ?? RETRY_POLICY.retries + 1;
            console.error(`⚠️  workday: ${entry.name} slice ${facet.facetParameter}=${value.id} failed on its first page after ${attempts} attempts: ${err.message}`);
            splitIncomplete = true;
            continue;
          }
          await split(
            sliceResult,
            nextApplied,
            depth + 1,
            [...excluded, facet.facetParameter],
          );
        }
      };

      await split(root, {}, 0, []);
      jobs = out;

      const short = splitIncomplete || budgetExhausted ? ' (still incomplete)' : '';
      console.error(`⚠️  workday: ${entry.name} offset-clamped at ${WORKDAY_OFFSET_CEILING} — recovered ${jobs.length} jobs via ${slicesSpent} facet slices${short}`);
    }

    if (ctxCap === Infinity) {
      const detailOpts = {
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': BROWSER_LIKE_USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
          referer: `${ep.jobBase}/`,
        },
      };
      const placeholders = jobs.filter((j) => isMultiLocationPlaceholder(j.location));
      const pending = placeholders.filter((j) => j.url.startsWith(`${ep.jobBase}/`));
      const unaddressable = placeholders.length - pending.length;
      let resolved = 0;
      let redated = 0;
      let failed = 0;
      let requests = 0;
      let attempted = 0;
      const meteredCtx = Object.create(ctx);
      meteredCtx.fetchJson = (url, opts) => { requests++; return ctx.fetchJson(url, opts); };
      for (const job of pending) {
        if (requests >= MAX_DETAIL_REQUESTS) break;
        const externalPath = job.url.slice(ep.jobBase.length);
        attempted++;
        if (attempted > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
        const remaining = MAX_DETAIL_REQUESTS - requests;
        const policy = { ...RETRY_POLICY, retries: Math.min(RETRY_POLICY.retries, remaining - 1) };
        let detail;
        try {
          detail = await fetchJsonWithRetry(meteredCtx, `${ep.cxsBase}${externalPath}`, detailOpts, policy);
        } catch {
          failed++;
          continue;
        }
        const places = locationsFromDetail(detail);
        if (places === '') { failed++; continue; }
        job.location = places;
        resolved++;
        const started = postedAtFromDetail(detail);
        if (started !== undefined) {
          job.postedAt = started;
          redated++;
        }
      }
      if (placeholders.length > 0) {
        const capped = pending.length > attempted ? `, ${pending.length - attempted} left unresolved by the ${MAX_DETAIL_REQUESTS}-request cap` : '';
        const unreadable = failed > 0 ? `, ${failed} detail document(s) unreadable` : '';
        const unroutable = unaddressable > 0 ? `, ${unaddressable} with no site-relative path` : '';
        const dated = redated > 0 ? `, ${redated} dated exactly from the detail document` : '';
        console.error(`ℹ️  workday: ${entry.name} resolved ${resolved} of ${placeholders.length} multi-location placeholder(s)${unreadable}${unroutable}${capped}${dated}`);
      }
    }

    const syntheticEntries = ctx?.syntheticEntries === true;
    if (stopReason === STOP_REASON.CAP && !root.clamped) {
      const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
      if (!syntheticEntries) {
        console.error(`⚠️  workday: ${entry.name} truncated at max_pages=${maxPages} (${jobsSummary}) — raise max_pages on this entry for more`);
      } else {
        const suspectTag = total !== null && total === maxPages * PAGE_SIZE ? ' (total may be Workday-capped, not real)' : '';
        console.error(`⚠️  workday: ${entry.name} truncated at ${maxPages} pages (${jobsSummary})${suspectTag}`);
      }
    }
    if (stopReason === STOP_REASON.NO_DATE_SKIP) jobs.workdayNoDateSkip = true;
    if (stopReason === STOP_REASON.FETCH_ERROR) jobs.workdayTruncated = WORKDAY_TRUNCATED_REASON.TRANSIENT;
    if (splitIncomplete || budgetExhausted) {
      jobs.workdayTruncated = (splitStructural || budgetExhausted)
        ? WORKDAY_TRUNCATED_REASON.STRUCTURAL
        : WORKDAY_TRUNCATED_REASON.TRANSIENT;
    }

    return jobs;
  },
};
