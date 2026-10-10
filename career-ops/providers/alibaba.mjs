import { randomUUID } from 'crypto';
import { sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const API_HOST = 'talent.alibaba.com';
const API = `https://${API_HOST}/position/search`;
const DETAIL = `https://${API_HOST}/off-campus/position-detail?positionId=`;
const PAGE_SIZE = 100;
const DEFAULT_KEYWORDS = [''];
const DEFAULT_MAX_PAGES = 50;
const INTER_PAGE_DELAY_MS = 300;

function formatExperience(exp) {
  if (!exp || typeof exp !== 'object') return '';
  const from = Number.isFinite(exp.from) ? exp.from : null;
  const to = Number.isFinite(exp.to) ? exp.to : null;
  if (from != null && to != null) return `${from}-${to}年`;
  if (from != null) return `${from}年以上`;
  if (to != null) return `${to}年以下`;
  return '';
}

function buildBody(key, pageIndex) {
  return JSON.stringify({
    channel: 'group_official_site',
    language: 'zh',
    batchId: '',
    categories: '',
    deptCodes: [],
    key,
    pageIndex,
    pageSize: PAGE_SIZE,
    regions: '',
    subCategories: '',
  });
}

export function parseAlibabaResponse(json, companyName) {
  const list = json?.content?.datas;
  const total = Number(json?.content?.totalCount) || 0;
  if (!Array.isArray(list)) return { jobs: [], total };

  const jobs = [];
  for (const p of list) {
    const title = p.name || '';
    const id = p.id;
    if (!title || id == null) continue;
    const encodedId = safeEncodeURIComponent(id);
    if (encodedId === null) continue;
    const experience = formatExperience(p.experience);
    jobs.push({
      title,
      url: DETAIL + encodedId,
      company: companyName,
      location: Array.isArray(p.workLocations) ? p.workLocations.filter(Boolean).join('/') : '',
      description: [
        Array.isArray(p.categories) && p.categories.length && `类别: ${p.categories.filter(Boolean).join('/')}`,
        experience && `经验: ${experience}`,
        p.description,
        p.requirement,
      ].filter(Boolean).join('\n').slice(0, 4000),
      postedAt: Number(p.publishTime) || Number(p.modifyTime) || undefined,
    });
  }
  return { jobs, total };
}

export default {
  id: 'alibaba',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== API_HOST) return null;
    return { url };
  },

  async fetch(entry, ctx) {
    const keywords = Array.isArray(entry.keywords) && entry.keywords.length
      ? entry.keywords
      : DEFAULT_KEYWORDS;
    const entryMaxPages = Number(entry.max_pages) > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES;
    const maxPages = Math.min(entryMaxPages, Number(ctx?.maxPages) > 0 ? Number(ctx.maxPages) : Infinity);

    const csrfToken = randomUUID();

    const seen = new Map();
    let firstRequest = true;
    let succeededOnce = false;

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        if (firstRequest) firstRequest = false;
        else await sleep(INTER_PAGE_DELAY_MS, ctx);
        let json;
        try {
          json = (await ctx.fetchJson(API, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'cookie': `XSRF-TOKEN=${csrfToken}`,
              'x-xsrf-token': csrfToken,
            },
            body: buildBody(keyword, page),
            redirect: 'error',
          }));
          if (json?.success === false) {
            throw new Error(`API error: ${json.errorMsg || json.errorCode || 'success=false'}`);
          }
        } catch (err) {
          if (!succeededOnce) throw err;
          console.error(`  ⚠ alibaba: keyword "${keyword}" page ${page} failed (${err.message}) — keeping the ${seen.size} jobs collected so far`);
          return [...seen.values()];
        }
        succeededOnce = true;
        const { jobs, total } = parseAlibabaResponse(json, entry.name || '阿里巴巴');
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (!seen.has(job.url)) seen.set(job.url, job);
        }

        if (page * PAGE_SIZE >= total) break;
      }
    }

    return [...seen.values()];
  },
};
