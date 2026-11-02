import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { parseWwrFeed } from './providers/weworkremotely.mjs';
import { atsVendorOf } from './ats-vendor.mjs';

const TIMEOUT_MS = 8_000;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeValue(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  return v.split('/').every((seg) => seg.length > 0 && SAFE_SEGMENT.test(seg) && !seg.includes('..'));
}

const ATS_PROVIDERS = [
  {
    id: 'greenhouse-embedded',
    match(u) {
      if (/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const id = u.searchParams.get('gh_jid');
      return id && /^\d+$/.test(id) ? { id } : null;
    },
    api: ({ id }) => `https://boards.greenhouse.io/embed/job_app?token=${id}`,
    async followEmbed(res, { id }) {
      if (res.status !== 301 && res.status !== 302) return null;
      let target;
      try { target = new URL(res.headers.get('location'), 'https://boards.greenhouse.io'); }
      catch { return null; }
      if (target.protocol !== 'https:' || !/(^|\.)greenhouse\.io$/.test(target.hostname)) return null;
      const board = target.searchParams.get('for');
      if (!isSafeValue(board) || board.includes('/') || target.searchParams.get('token') !== id) return null;
      return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`;
    },
  },
  {
    id: 'greenhouse',
    match(u) {
      if (atsVendorOf(u.href) !== 'greenhouse') return null;
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      return m ? { board: m[1], id: m[2] } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
  },
  {
    id: 'lever',
    match(u) {
      if (atsVendorOf(u.href) !== 'lever') return null;
      const host = u.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
      if (!host) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { apiHost: `api.${host[1]}`, slug: m[1], id: m[2] } : null;
    },
    api: ({ apiHost, slug, id }) => `https://${apiHost}/v0/postings/${slug}/${id}`,
    api404Authoritative: false,
  },
  {
    id: 'ashby',
    match(u) {
      if (atsVendorOf(u.href) !== 'ashby' || u.hostname !== 'jobs.ashbyhq.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/);
      return m ? { org: m[1], jobId: m[2] } : null;
    },
    api: ({ org }) => `https://api.ashbyhq.com/posting-api/job-board/${org}`,
    timeoutMs: 20_000,
    async interpret(res, { jobId }) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      return classifyAshbyBoard(json, jobId);
    },
  },
  {
    id: 'workday',
    match(u) {
      if (atsVendorOf(u.href) !== 'workday') return null;
      const m = `${u.hostname}${u.pathname}`.match(
        /^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/(.+?)\/?$/
      );
      if (!m) return null;
      const [, tenant, shard, site, jobPath] = m;
      return { tenant, shard, site, jobPath };
    },
    api: ({ tenant, shard, site, jobPath }) =>
      `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobPath}`,
    interpretStatuses: [403],
    async interpret(res) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      return classifyWorkday403(json);
    },
  },
  {
    id: 'smartrecruiters',
    match(u) {
      if (u.hostname !== 'jobs.smartrecruiters.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([A-Za-z0-9]+)(?:-[^/]*)?\/?$/);
      return m ? { company: m[1], id: m[2] } : null;
    },
    api: ({ company, id }) => `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
    api404Authoritative: false,
    async interpret(res, { id }) {
      let posting;
      try { posting = await res.json(); } catch { return null; }
      if (String(posting?.id) !== id || typeof posting.active !== 'boolean') return null;
      return posting.active
        ? { result: 'active', code: 'smartrecruiters_api_active', reason: 'SmartRecruiters marks the posting active' }
        : { result: 'expired', code: 'smartrecruiters_api_inactive', reason: 'SmartRecruiters marks the posting inactive' };
    },
  },
  {
    id: 'arbeitsagentur',
    match(u) {
      if (u.hostname !== 'www.arbeitsagentur.de') return null;
      const m = u.pathname.match(/^\/jobsuche\/jobdetail\/([^/]+)\/?$/);
      return m ? { refnr: m[1] } : null;
    },
    api: ({ refnr }) => `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${Buffer.from(refnr).toString('base64url')}`,
    headers: { 'X-API-Key': 'jobboerse-jobsuche' },
    api404Authoritative: false,
    async interpret(res, { refnr }) {
      let posting;
      try { posting = await res.json(); } catch { return null; }
      return posting?.referenznummer === refnr && posting?.stellenangebotsTitel
        ? { result: 'active', code: 'arbeitsagentur_api_active', reason: 'Arbeitsagentur returns the matching job detail' }
        : null;
    },
  },
  {
    id: 'weworkremotely',
    match(u) {
      if (u.hostname !== 'weworkremotely.com' || !/^\/remote-jobs\/[^/]+\/?$/.test(u.pathname)) return null;
      return { slug: u.pathname.split('/')[2] };
    },
    api: () => 'https://weworkremotely.com/remote-jobs.rss',
    accept: 'application/rss+xml',
    api404Authoritative: false,
    async interpret(res, { slug }) {
      let feed;
      try { feed = await res.text(); } catch { return null; }
      if (!/<rss\b/i.test(feed)) return null;
      const listed = parseWwrFeed(feed).some((job) => new URL(job.url).pathname.replace(/\/$/, '') === `/remote-jobs/${slug}`);
      return listed
        ? { result: 'active', code: 'weworkremotely_feed_listed', reason: 'Posting is listed in the current RSS feed' }
        : null;
    },
  },
  {
    id: 'linkedin',
    match(u) {
      if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
      const path = u.pathname.match(/^\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
      if (path) return { id: path[1] };
      const current = u.searchParams.get('currentJobId');
      return current && /^\d+$/.test(current) ? { id: current } : null;
    },
    api: ({ id }) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
    throttleMs: 3_500,
    accept: 'text/html',
    async interpret(res) {
      let html;
      try {
        html = await res.text();
      } catch {
        return null;
      }
      return classifyLinkedInPosting(html);
    },
  },
];

const LINKEDIN_CLOSED_MARKER = /No longer accepting applications/i;
const LINKEDIN_APPLY_CONTROL = /public_jobs_apply-link-onsite|job-details-topcard-apply-modal/;

export function classifyLinkedInPosting(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const closed = LINKEDIN_CLOSED_MARKER.test(html);
  const apply = LINKEDIN_APPLY_CONTROL.test(html);
  if (closed && !apply) {
    return {
      result: 'expired',
      code: 'linkedin_closed_marker',
      reason: 'LinkedIn shows "No longer accepting applications" and no apply control',
    };
  }
  if (apply && !closed) {
    return {
      result: 'active',
      code: 'linkedin_apply_control',
      reason: 'LinkedIn shows an apply control and no closure banner (live)',
    };
  }
  return {
    result: 'uncertain',
    code: 'linkedin_signals_disagree',
    reason: closed
      ? 'LinkedIn shows both a closure banner and an apply control — unrecognised page'
      : 'LinkedIn shows neither a closure banner nor an apply control — unrecognised page',
  };
}

const nextRequestAt = new Map();

export async function throttleProviderRequest(providerId, intervalMs) {
  if (!intervalMs) return 0;
  const now = Date.now();
  const earliest = Math.max(now, nextRequestAt.get(providerId) ?? 0);
  nextRequestAt.set(providerId, earliest + intervalMs);
  const wait = earliest - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return wait;
}

export function classifyAshbyBoard(json, jobId) {
  if (!json || !Array.isArray(json.jobs)) return null;
  const target = String(jobId).toLowerCase();
  const job = json.jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
  if (job && job.isListed !== false) {
    return { result: 'active', code: 'ashby_api_ok', reason: 'Ashby posting is listed on the board (live)' };
  }
  return { result: 'expired', code: 'ashby_api_unlisted', reason: 'Ashby posting not listed on the board — removed/unlisted' };
}

export function classifyWorkday403(json) {
  return json?.httpStatus === 403 && json?.errorCode === 'S22'
    ? { result: 'expired', code: 'workday_api_withdrawn', reason: 'Workday CXS answers 403 S22 — posting withdrawn' }
    : null;
}

export function resolveAtsApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const provider of ATS_PROVIDERS) {
    const parts = provider.match(u);
    if (!parts) continue;
    if (!Object.values(parts).every(isSafeValue)) return null;
    return {
      ats: provider.id,
      apiUrl: provider.api(parts),
      parts,
      timeoutMs: provider.timeoutMs,
      throttleMs: provider.throttleMs,
      accept: provider.accept,
      headers: provider.headers,
      followEmbed: provider.followEmbed,
      interpret: provider.interpret,
      interpretStatuses: provider.interpretStatuses,
      api404Authoritative: provider.api404Authoritative !== false,
    };
  }
  return null;
}

export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

export const JD_TEXT_API_ATS = new Set(['greenhouse', 'greenhouse-embedded', 'lever', 'ashby', 'workday', 'smartrecruiters']);

export async function checkLivenessViaApi(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl, parts, interpret, interpretStatuses, timeoutMs, throttleMs, accept, headers, followEmbed, api404Authoritative } = resolved;

  await throttleProviderRequest(ats, throttleMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: accept || 'application/json', ...headers },
        redirect: followEmbed ? 'manual' : 'error',
        signal: controller.signal,
      });
      if (followEmbed) {
        const jobApiUrl = await followEmbed(res, parts);
        if (!jobApiUrl) return null;
        res = await fetch(jobApiUrl, {
          method: 'GET',
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
      }
    } catch {
      return null;
    }

    if (res.status === 404 || res.status === 410) {
      if (!api404Authoritative) return null;
      return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
    }
    if (interpret && (interpretStatuses || [200]).includes(res.status)) return await interpret(res, parts);
    if (res.status === 200) {
      return { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
