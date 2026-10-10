import { createDecipheriv } from 'crypto';
import { sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const API_PATH = '/api/outer/ats-apply/website/jobs/v2';
const ALLOWED_HOSTS = new Set(['app.mokahr.com', 'hire-r1.mokahr.com']);
const AES_IV = Buffer.from('de7c21ed8d6f50fe', 'utf8');
const MAX_LIMIT = 50;
const DEFAULT_KEYWORDS = [''];
const DEFAULT_MAX_PAGES = 10;
const INTER_PAGE_DELAY_MS = 400;

const TENANT_PATH_RE = /^\/(?:social-recruitment|campus-recruitment|apply)\/([^/]+)\/(\d+)\/?$/;
const ROBOTS_EXCLUDED_PATHS = new Set([
  '/social-recruitment/lingjuninvest/46355',
  '/social-recruitment/shopee/74378',
]);

function parseTenantUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null;
  const m = TENANT_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const siteId = Number(m[2]);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return null;
  const pathname = u.pathname.replace(/\/$/, '');
  if (ROBOTS_EXCLUDED_PATHS.has(pathname)) return null;
  return { orgId: m[1], siteId, baseUrl: `${u.origin}${pathname}`, apiUrl: `${u.origin}${API_PATH}` };
}

export function decryptMokaHrEnvelope(envelope) {
  if (!envelope?.data || !envelope?.necromancer) {
    throw new Error('mokahr: response missing data/necromancer — not the expected envelope shape');
  }
  const key = Buffer.from(envelope.necromancer, 'utf8');
  if (key.length !== 16) {
    throw new Error(`mokahr: necromancer key is ${key.length} bytes, expected 16 (aes-128-cbc)`);
  }
  const ciphertext = Buffer.from(envelope.data, 'base64');
  const decipher = createDecipheriv('aes-128-cbc', key, AES_IV);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function unwrapMokaHrResponse(envelope) {
  const data = envelope?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return envelope;
  return decryptMokaHrEnvelope(envelope);
}

export function parseMokaHrJobs(decrypted, companyName, tenantBaseUrl) {
  const list = decrypted?.data?.jobs;
  if (!Array.isArray(list)) return [];

  const jobs = [];
  for (const j of list) {
    const title = j?.title;
    const id = j?.id;
    if (!title || id == null) continue;
    const encodedId = safeEncodeURIComponent(id);
    if (encodedId === null) continue;
    const cities = Array.isArray(j.locations)
      ? j.locations
        .map((l) => [l?.provinceName, l?.cityName].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('/')
      : '';
    const createdAt = typeof j.createdAt === 'string' ? j.createdAt.trim() : '';
    const ts = /(?:Z|[+-]\d{2}:\d{2})$/i.test(createdAt) ? Date.parse(createdAt) : NaN;
    jobs.push({
      title,
      url: `${tenantBaseUrl}#/job/${encodedId}`,
      company: companyName,
      location: cities,
      description: [
        j.commitment && `类型: ${j.commitment}`,
        j.department?.name && `部门: ${j.department.name}`,
        htmlToText(j.jobDescription),
      ].filter(Boolean).join('\n').slice(0, 4000),
      postedAt: Number.isFinite(ts) ? ts : undefined,
    });
  }
  return jobs;
}

export default {
  id: 'mokahr',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    if (!parseTenantUrl(url)) return null;
    return { url };
  },

  async fetch(entry, ctx) {
    const tenant = parseTenantUrl(entry.careers_url);
    if (!tenant) {
      throw new Error(`mokahr: careers_url must be an allowed HTTPS tenant URL on ${[...ALLOWED_HOSTS].join(' or ')} with a positive site ID`);
    }

    const keywords = Array.isArray(entry.keywords) && entry.keywords.length
      ? entry.keywords
      : DEFAULT_KEYWORDS;
    const entryMaxPages = Number(entry.max_pages) > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES;
    const maxPages = Math.min(entryMaxPages, Number(ctx?.maxPages) > 0 ? Number(ctx.maxPages) : Infinity);

    const seen = new Map();
    let firstRequest = true;
    let succeededOnce = false;

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        if (firstRequest) firstRequest = false;
        else await sleep(INTER_PAGE_DELAY_MS, ctx);
        const offset = (page - 1) * MAX_LIMIT;

        let envelope;
        try {
          envelope = (await ctx.fetchJson(tenant.apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              siteId: tenant.siteId,
              orgId: tenant.orgId,
              locale: 'zh-CN',
              limit: MAX_LIMIT,
              offset,
              ...(keyword ? { keyword } : {}),
            }),
            redirect: 'error',
          }));
        } catch (err) {
          if (!succeededOnce) throw err;
          console.error(`  ⚠ mokahr: keyword "${keyword}" page ${page} failed (${err.message}) — keeping the ${seen.size} jobs collected so far`);
          return [...seen.values()];
        }

        let decrypted;
        try {
          decrypted = unwrapMokaHrResponse(envelope);
          if (decrypted?.success === false) {
            throw new Error(`API error: ${decrypted.msg || decrypted.code || 'success=false'}`);
          }
        } catch (err) {
          if (!succeededOnce) throw err;
          console.error(`  ⚠ mokahr: keyword "${keyword}" page ${page} failed (${err.message}) — keeping the ${seen.size} jobs collected so far`);
          return [...seen.values()];
        }

        succeededOnce = true;
        const rawJobs = Array.isArray(decrypted?.data?.jobs) ? decrypted.data.jobs : [];
        if (rawJobs.length === 0) break;
        const jobs = parseMokaHrJobs(decrypted, entry.name || tenant.orgId, tenant.baseUrl);

        for (const job of jobs) {
          if (!seen.has(job.url)) seen.set(job.url, job);
        }

        if (rawJobs.length < MAX_LIMIT) break;
      }
    }

    return [...seen.values()];
  },
};
