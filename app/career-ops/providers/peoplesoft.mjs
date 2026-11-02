import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, DESCRIPTION_CAP } from './_html-to-text.mjs';
import { fetchResponseWithRetry, sleep, BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { intInRange } from './_config-utils.mjs';

const PS_SEARCH_PATH_RE = /^\/psc\/([^/]+)\/EMPLOYEE\/HRMS\/c\/HRS_HRAM_FL\.HRS_CG_SEARCH_FL\.GBL$/i;

const SEARCH_PAGE_PARAM = 'HRS_APP_SCHJOB_FL';
const DETAIL_PAGE_PARAM = 'HRS_APP_JBPST_FL';
const LOAD_MORE_ACTION = 'HRS_AGNT_RSLT_I$hdown$0';

const DEFAULT_MAX_LOAD_MORE = 20;
const MAX_LOAD_MORE_CAP = 100;

const DEFAULT_DETAIL_LIMIT = 25;

const INTER_REQUEST_DELAY_MS = 300;

const HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
};

export function resolveConfig(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    const m = u.pathname.match(PS_SEARCH_PATH_RE);
    if (!m) continue;
    const site = m[1];
    return { origin: u.origin, site, searchUrl: buildSearchUrl(u.origin, site) };
  }
  return null;
}

export function buildSearchUrl(origin, site) {
  const u = new URL(`${origin}/psc/${site}/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL`);
  u.searchParams.set('Page', SEARCH_PAGE_PARAM);
  u.searchParams.set('Action', 'U');
  u.searchParams.set('FOCUS', 'Applicant');
  u.searchParams.set('SiteId', '1');
  return u.href;
}

export function buildDetailUrl(config, jobId, postingSeq) {
  const u = new URL(`${config.origin}/psc/${config.site}/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL`);
  u.searchParams.set('Page', DETAIL_PAGE_PARAM);
  u.searchParams.set('Action', 'U');
  u.searchParams.set('FOCUS', 'Applicant');
  u.searchParams.set('JobOpeningId', jobId);
  u.searchParams.set('PostingSeq', String(postingSeq));
  u.searchParams.set('SiteId', '1');
  return u.href;
}

function assertPeopleSoftUrl(url, config) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`peoplesoft: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`peoplesoft: URL must use HTTPS: ${url}`);
  if (parsed.origin !== config.origin) {
    throw new Error(`peoplesoft: untrusted origin "${parsed.origin}" — must be ${config.origin}`);
  }
  return url;
}

export function createCookieJar() {
  return new Map();
}

export function updateCookieJar(jar, setCookies) {
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

export function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractById(html, id) {
  const str = String(html);
  const idEsc = escapeRegExp(id);
  const idAttrRe = new RegExp(`\\bid=(?:"${idEsc}"|'${idEsc}'|${idEsc}(?=[\\s>]))`);
  const idMatch = idAttrRe.exec(str);
  if (!idMatch) return null;
  const idPos = idMatch.index;
  const tagStart = str.lastIndexOf('<', idPos);
  if (tagStart === -1) return null;
  const tagOpenEnd = str.indexOf('>', idPos);
  if (tagOpenEnd === -1) return null;
  const tagNameMatch = str.slice(tagStart + 1, tagStart + 40).match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagNameMatch) return null;
  const tagName = tagNameMatch[1];
  if (str[tagOpenEnd - 1] === '/') return '';
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');
  tagRe.lastIndex = tagOpenEnd + 1;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(str))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return str.slice(tagOpenEnd + 1, m.index);
    } else {
      depth++;
    }
  }
  return null;
}

export function extractTextById(html, id) {
  const raw = extractById(html, id);
  if (raw === null) return null;
  return decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseAttrs(attrString) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(attrString))) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] !== undefined ? m[2] : true;
    out[name] = (value);
  }
  return out;
}

export function parseFormState(html) {
  const str = String(html);
  const openMatch = /<form\b[^>]*\bname=["']win0["'][^>]*>/i.exec(str);
  if (!openMatch) return null;
  const closeIdx = str.toLowerCase().indexOf('</form>', openMatch.index);
  const formHtml = closeIdx === -1 ? str.slice(openMatch.index) : str.slice(openMatch.index, closeIdx);
  const actionMatch = /\baction=["']([^"']*)["']/i.exec(openMatch[0]);

  const fields = {};

  for (const m of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = parseAttrs(m[1]);
    if (typeof attrs.name !== 'string' || !attrs.name) continue;
    const type = typeof attrs.type === 'string' ? attrs.type.toLowerCase() : 'text';
    if ((type === 'checkbox' || type === 'radio') && attrs.checked === undefined) continue;
    fields[decodeEntities(attrs.name)] = decodeEntities(typeof attrs.value === 'string' ? attrs.value : '');
  }
  for (const m of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = parseAttrs(m[1]);
    if (typeof attrs.name !== 'string' || !attrs.name) continue;
    const optMatch = /<option\b([^>]*)\bselected\b[^>]*>/i.exec(m[2]) || /<option\b([^>]*)>/i.exec(m[2]);
    const optAttrs = optMatch ? parseAttrs(optMatch[1]) : {};
    fields[decodeEntities(attrs.name)] = decodeEntities(typeof optAttrs.value === 'string' ? optAttrs.value : '');
  }
  for (const m of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const attrs = parseAttrs(m[1]);
    if (typeof attrs.name !== 'string' || !attrs.name) continue;
    fields[decodeEntities(attrs.name)] = decodeEntities(m[2]);
  }

  return { action: actionMatch ? actionMatch[1] : null, fields };
}

export function parseReportedTotal(text) {
  if (!text) return null;
  const normalized = String(text).replace(/(\d)[\s\u00a0.,](?=\d{3}(?:\D|$))/g, '$1');
  const ofMatch = normalized.match(/of\s+(\d+)/i);
  if (ofMatch) return Number(ofMatch[1]);
  const numbers = normalized.match(/\d+/g);
  return numbers ? Number(numbers[numbers.length - 1]) : null;
}

export function parsePeopleSoftDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).getUTCDate() !== day) return undefined;
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseSearchPage(html, config) {
  const str = String(html);
  const hasForm = /<form\b[^>]*\bname=["']win0["']/i.test(str);
  if (!hasForm) {
    return { valid: false, errorReason: 'unexpected-page', rows: [], reportedTotal: null, formAction: null, formFields: {} };
  }

  const formState = parseFormState(str) || { action: null, fields: {} };
  const reportedTotal = parseReportedTotal(extractTextById(str, 'win0divHRS_AGNT_RSLT_Irowcnt$0'));

  const rowIndices = [];
  const rowRe = /\bid=(?:["']HRS_AGNT_RSLT_I\$0_row_(\d+)["']|HRS_AGNT_RSLT_I\$0_row_(\d+)(?=[\s>]))/g;
  let rm;
  while ((rm = rowRe.exec(str))) rowIndices.push(rm[1] ?? rm[2]);

  const rows = [];
  for (const idx of rowIndices) {
    const jobId = extractTextById(str, `HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID$${idx}`);
    const title = extractTextById(str, `SCH_JOB_TITLE$${idx}`);
    if (!jobId || !title) continue;
    const postedRaw = extractTextById(str, `SCH_OPENED$${idx}`);
    rows.push({
      jobId,
      title,
      location: extractTextById(str, `LOCATION$${idx}`) || '',
      department: extractTextById(str, `HRS_APP_JBSCH_I_HRS_DEPT_DESCR$${idx}`) || '',
      postedRaw: postedRaw || null,
      postedAt: parsePeopleSoftDate(postedRaw),
    });
  }

  return {
    valid: true,
    errorReason: null,
    rows,
    reportedTotal: reportedTotal !== null && reportedTotal < rows.length ? null : reportedTotal,
    formAction: formState.action,
    formFields: formState.fields,
  };
}

const MAX_REDIRECTS = 10;

async function requestWithSession(ctx, jar, config, method, url, opts = {}) {
  let currentUrl = assertPeopleSoftUrl(url, config);
  let currentMethod = method;
  let currentBody = opts.body;
  const baseHeaders = opts.headers || {};

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = {
      ...HEADERS,
      ...baseHeaders,
      ...(cookieHeader(jar) ? { cookie: cookieHeader(jar) } : {}),
    };
    const res = await fetchResponseWithRetry(
      ctx,
      currentUrl,
      { method: currentMethod, redirect: 'manual', headers, body: currentMethod === 'GET' ? undefined : currentBody },
    );
    const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    updateCookieJar(jar, setCookies);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`peoplesoft: redirect (HTTP ${res.status}) with no Location header from ${currentUrl}`);
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        throw new Error(`peoplesoft: redirect (HTTP ${res.status}) carried an unparseable Location: ${location}`);
      }
      nextUrl = assertPeopleSoftUrl(nextUrl, config);
      if (res.status !== 307 && res.status !== 308) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = nextUrl;
      continue;
    }
    return res.text();
  }
  throw new Error(`peoplesoft: exceeded ${MAX_REDIRECTS} redirects following ${url}`);
}

async function getWithSession(ctx, jar, config, url) {
  return requestWithSession(ctx, jar, config, 'GET', url);
}

async function postWithSession(ctx, jar, config, url, body) {
  return requestWithSession(ctx, jar, config, 'POST', url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export async function createSession(ctx) {
  return { ctx, jar: createCookieJar() };
}

export async function fetchSearchPage(config, session) {
  const html = await getWithSession(session.ctx, session.jar, config, config.searchUrl);
  return parseSearchPage(html, config);
}

function resolveFormActionUrl(action, config) {
  if (!action) return config.searchUrl;
  try {
    return new URL(action, config.origin).href;
  } catch {
    return config.searchUrl;
  }
}

export async function fetchAdditionalResults(state, session) {
  const { config, ctx, jar } = session;
  const fields = { ...state.formFields, ICAction: LOAD_MORE_ACTION };
  const actionUrl = assertPeopleSoftUrl(resolveFormActionUrl(state.formAction, config), config);
  const body = new URLSearchParams(fields).toString();
  const html = await postWithSession(ctx, jar, config, actionUrl, body);
  return parseSearchPage(html, config);
}

export function parseJobDetail(html, expectedJobId) {
  const str = String(html);
  const returnedJobId = extractTextById(str, 'HRS_SCH_WRK2_HRS_JOB_OPENING_ID');
  if (returnedJobId === null) {
    return { valid: false, reason: 'unexpected-page', jobId: null };
  }
  if (returnedJobId.trim() !== String(expectedJobId).trim()) {
    return { valid: false, reason: 'job-id-mismatch', jobId: returnedJobId };
  }

  const title = extractTextById(str, 'HRS_SCH_WRK2_POSTING_TITLE') || '';
  const location = extractTextById(str, 'HRS_SCH_WRK_HRS_DESCRLONG') || '';

  const sectionIndices = [];
  const secRe = /\bid=(?:["']win0divHRS_SCH_PSTDSC_row\$(\d+)["']|win0divHRS_SCH_PSTDSC_row\$(\d+)(?=[\s>]))/g;
  let sm;
  while ((sm = secRe.exec(str))) sectionIndices.push(sm[1] ?? sm[2]);

  const sections = [];
  for (const idx of sectionIndices) {
    const labelRaw = extractById(str, `HRS_SCH_WRK_DESCR100$${idx}lbl`);
    const bodyRaw = extractById(str, `HRS_SCH_PSTDSC_DESCRLONG$${idx}`);
    if (labelRaw === null && bodyRaw === null) continue;
    sections.push({
      label: labelRaw !== null ? htmlToText(labelRaw) : '',
      text: htmlToText(bodyRaw || ''),
    });
  }

  const descriptionText = sections
    .map((s) => (s.label ? `${s.label}\n` : '') + s.text)
    .join('\n\n')
    .trim()
    .slice(0, DESCRIPTION_CAP);

  return {
    valid: true,
    reason: null,
    jobId: returnedJobId,
    title,
    location,
    sections,
    descriptionText,
  };
}

async function fetchJobDetail(config, session, jobId) {
  for (const seq of [1, 2]) {
    const url = assertPeopleSoftUrl(buildDetailUrl(config, jobId, seq), config);
    const html = await getWithSession(session.ctx, session.jar, config, url);
    const detail = parseJobDetail(html, jobId);
    if (detail.valid) return detail;
  }
  return null;
}

function resolveMaxLoadMore(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v - 1, MAX_LOAD_MORE_CAP);
  return DEFAULT_MAX_LOAD_MORE;
}

function parsePeoplesoftEntryConfig(entry) {
  const cfg = (entry && entry.peoplesoft) || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, DEFAULT_DETAIL_LIMIT, 1, 100),
  };
}

export default {
  id: 'peoplesoft',

  detect(entry) {
    const config = resolveConfig(entry);
    return config ? { url: config.searchUrl } : null;
  },

  async fetch(entry, ctx) {
    const config = resolveConfig(entry);
    if (!config) {
      throw new Error(`peoplesoft: cannot resolve a PeopleSoft Candidate Gateway search URL for ${entry.name}`);
    }

    const session = { ctx, jar: createCookieJar(), config };

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxLoadMore = probing ? Math.max(0, ctxMaxPages - 1) : resolveMaxLoadMore(entry);

    const firstPage = await fetchSearchPage(config, session);
    if (!firstPage.valid) {
      throw new Error(
        `peoplesoft: ${entry.name} returned an unrecognized search response (no form[name="win0"]) — ` +
          `likely a login/session-expired/challenge page, not zero postings (reason: ${firstPage.errorReason})`,
      );
    }

    const byId = new Map();
    for (const row of firstPage.rows) byId.set(row.jobId, row);
    let reportedTotal = firstPage.reportedTotal;

    let currentState = firstPage;
    let loadMoreCount = 0;
    let stopCause = null;
    let stopDetail = '';
    while (loadMoreCount < maxLoadMore) {
      if (reportedTotal !== null && byId.size >= reportedTotal) break;
      await sleep(INTER_REQUEST_DELAY_MS, ctx);
      let next;
      const postedStateNum = currentState.formFields?.ICStateNum;
      try {
        next = await fetchAdditionalResults(currentState, session);
      } catch (err) {
        if (probing) throw err;
        stopCause = 'load-more-fetch-failed';
        stopDetail = err.message;
        break;
      }
      loadMoreCount++;
      if (!next.valid) {
        stopCause = 'load-more-response-unrecognized';
        break;
      }
      if (next.reportedTotal !== null) reportedTotal = next.reportedTotal;
      let fresh = 0;
      for (const row of next.rows) {
        if (byId.has(row.jobId)) continue;
        byId.set(row.jobId, row);
        fresh++;
      }
      currentState = next;
      if (fresh === 0) {
        const returnedStateNum = next.formFields?.ICStateNum;
        stopCause = postedStateNum !== undefined && returnedStateNum === postedStateNum
          ? 'load-more-stale-state'
          : 'load-more-no-progress';
        break;
      }
    }

    const reachedKnownTotal = reportedTotal !== null && byId.size >= reportedTotal;
    const cleanlyExhausted = reachedKnownTotal || (reportedTotal === null && stopCause === 'load-more-no-progress');
    const complete = probing || cleanlyExhausted;
    if (!probing && !complete) {
      if (!stopCause) stopCause = 'pagination-ceiling-reached';
      const totalDesc = reportedTotal === null ? 'an unknown total of' : `${reportedTotal} reported`;
      const prefix = `⚠️  peoplesoft: ${entry.name} — parsed ${byId.size} of ${totalDesc} postings; `;
      if (stopCause === 'load-more-fetch-failed') {
        console.error(`${prefix}load-more request failed${stopDetail ? `: ${stopDetail}` : ''}.`);
      } else if (stopCause === 'load-more-response-unrecognized') {
        console.error(`${prefix}a load-more response was not recognizable.`);
      } else if (stopCause === 'load-more-no-progress') {
        console.error(`${prefix}the load-more response contained no new postings.`);
      } else if (stopCause === 'load-more-stale-state') {
        console.error(`${prefix}the load-more response repeated the posted ICStateNum without advancing.`);
      } else {
        console.error(`${prefix}raise max_pages on this entry, or this may be PeopleSoft's own ~100-result anonymous-session cap.`);
      }
    }

    const jobs = [];
    for (const row of byId.values()) {
      const job = {
        title: row.title,
        url: buildDetailUrl(config, row.jobId, 1),
        company: entry.name,
        location: row.location,
      };
      if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
      jobs.push(Object.assign(job, { _jobId: row.jobId }));
    }

    const { fetchDetails, detailLimit } = parsePeoplesoftEntryConfig(entry);
    if (fetchDetails && !probing) {
      const targets = jobs.slice(0, detailLimit);
      for (const job of targets) {
        await sleep(INTER_REQUEST_DELAY_MS, ctx);
        try {
          const detail = await fetchJobDetail(config, session, job._jobId);
          if (detail?.descriptionText) job.description = detail.descriptionText;
        } catch {
        }
      }
    }

    const out = jobs.map(({ _jobId, ...job }) => job);
    if (!probing && !complete) {
      out.peoplesoftIncomplete = {
        complete: false,
        reason: stopCause,
        collected: byId.size,
        reportedTotal,
      };
    }
    return out;
  },
};
