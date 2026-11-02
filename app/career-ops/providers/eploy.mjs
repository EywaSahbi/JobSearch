import { intInRange } from './_config-utils.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const FEED_PATH = '/live-jobs.xml';
const JOB_PATH_RE = /^\/vacancies\/(\d+)\/([^/?#]+)\.html\/?$/i;
const DETAIL_BATCH = 3;
const DETAIL_PACE_MS = 250;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveCareersOrigin(entry) {
  let parsed;
  try {
    parsed = new URL(text(entry?.careers_url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || host.includes(':')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (host === 'localhost' || host === 'localhost.localdomain') return null;
  if (host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (!host.includes('.')) return null;
  return new URL(`https://${host}`);
}

function buildFeedUrl(origin) {
  return new URL(FEED_PATH, origin).href;
}

function isAllowedJobUrl(url, origin) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const sameHost = host === origin.hostname.toLowerCase();
  const eployHost = host.endsWith('.eploy.net') && host !== 'eploy.net';
  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && !url.port
    && !url.search
    && !url.hash
    && (sameHost || eployHost)
    && JOB_PATH_RE.test(url.pathname);
}

const ACRONYMS = new Map([
  ['ai', 'AI'], ['api', 'API'], ['cio', 'CIO'], ['cto', 'CTO'], ['eu', 'EU'],
  ['hcm', 'HCM'], ['hr', 'HR'], ['it', 'IT'], ['ml', 'ML'], ['qa', 'QA'],
  ['uk', 'UK'], ['ui', 'UI'], ['ux', 'UX'],
]);

export function titleFromSlug(slug) {
  let decoded;
  try { decoded = decodeURIComponent(slug); } catch { decoded = slug; }
  return decoded.split(/--+/).map((segment) => segment
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => {
      const acronym = ACRONYMS.get(word.toLowerCase());
      return acronym || (word ? word[0].toUpperCase() + word.slice(1) : '');
    })
    .join(' ')
    .trim())
    .filter(Boolean)
    .join(' - ');
}

export function parseEploySitemap(xml, origin, company) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  if (!/<urlset\b[^>]*>/i.test(xml)) {
    throw new Error('eploy: unexpected live-jobs.xml response (expected an XML urlset)');
  }

  const jobs = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi)) {
    const rawLoc = match[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i)?.[1];
    if (!rawLoc) continue;
    let parsed;
    try { parsed = new URL(decodeEntities(rawLoc.trim())); } catch { continue; }
    if (!isAllowedJobUrl(parsed, origin)) continue;
    const path = parsed.pathname.match(JOB_PATH_RE);
    const vacancyId = path?.[1];
    if (!vacancyId || seen.has(vacancyId)) continue;
    const title = titleFromSlug(path[2]);
    if (!title) continue;
    seen.add(vacancyId);
    jobs.push({ title, url: parsed.href, company, location: '' });
  }
  return jobs;
}

function locationFromAddress(address) {
  if (!address || typeof address !== 'object') return '';
  const country = typeof address.addressCountry === 'object'
    ? text(address.addressCountry?.name)
    : text(address.addressCountry);
  return [...new Set([
    text(address.addressLocality), text(address.addressRegion), country,
  ].filter(Boolean))].join(', ');
}

function isJobPosting(value) {
  const type = value?.['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flattenJsonLd(value['@graph'])];
}

export function parseEployDetail(html) {
  if (typeof html !== 'string' || !html.trim()) return {};
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const posting = flattenJsonLd(parsed).find(isJobPosting);
    if (!posting) continue;
    const jobLocations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
    const location = jobLocations.map((item) => locationFromAddress(item?.address)).filter(Boolean).join('; ');
    const date = Date.parse(text(posting.datePosted));
    return {
      title: text(posting.title),
      location,
      description: htmlToText(posting.description),
      ...(Number.isFinite(date) ? { postedAt: date } : {}),
    };
  }

  const locationBlock = html.match(/id=["'][^"']*VacV_(?:All)?Location(?:ID)?[^"']*["'][\s\S]{0,1200}?class=["']content["'][^>]*>([\s\S]*?)<\/div\s*>/i)?.[1] || '';
  const metaDescription = html.match(/<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([\s\S]*?)["'])[^>]*>/i)?.[1] || '';
  return {
    location: htmlToText(locationBlock),
    description: htmlToText(metaDescription),
  };
}

function parseConfig(entry) {
  const cfg = entry?.eploy || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

export default {
  id: 'eploy',

  detect(entry) {
    if (entry?.provider !== 'eploy') return null;
    const origin = resolveCareersOrigin(entry);
    return origin ? { url: buildFeedUrl(origin) } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveCareersOrigin(entry);
    if (!origin) {
      throw new Error(`eploy: entry "${entry?.name || '(unnamed)'}" needs a public HTTPS careers_url`);
    }
    const feedUrl = buildFeedUrl(origin);
    const xml = await fetchTextWithRetry(ctx, feedUrl, { redirect: 'error', timeoutMs: 15_000 });
    const jobs = parseEploySitemap(xml, origin, text(entry?.name));

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const { fetchDetails, detailLimit } = parseConfig(entry);
    if (!fetchDetails || probing) return jobs;

    const candidates = jobs.slice(0, detailLimit);
    for (let i = 0; i < candidates.length; i += DETAIL_BATCH) {
      const batch = candidates.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async (job) => {
        try {
          const detailUrl = new URL(job.url);
          if (!isAllowedJobUrl(detailUrl, origin)) return;
          const html = await fetchTextWithRetry(ctx, detailUrl.href, { redirect: 'error', timeoutMs: 15_000 });
          const detail = parseEployDetail(html);
          if (text(detail.title)) job.title = text(detail.title);
          if (text(detail.location)) job.location = text(detail.location);
          if (text(detail.description)) job.description = text(detail.description);
          if (Number.isFinite(detail.postedAt)) job.postedAt = detail.postedAt;
        } catch {
        }
      }));
      if (i + DETAIL_BATCH < candidates.length) await sleep(DETAIL_PACE_MS, ctx);
    }
    return jobs;
  },
};
