import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const TRUSTED_HOST = 'itviec.com';
const LIST_URL = 'https://itviec.com/it-jobs';

const DEFAULT_MAX_PAGES = 10;

const MAX_PAGES_CAP = 50;

const INTER_PAGE_DELAY_MS = 750;

const CARD_SPLIT_RE = /data-search--job-selection-job-slug-value=['"]([^'"]+)['"]/gi;

const TITLE_ANCHOR_RE =
  /<h3[^>]*data-search--job-selection-target=['"]jobTitle['"][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i;

const COMPANY_LINK_RE = /href=["'](?:https?:\/\/itviec\.com)?\/companies\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;

const LOCATION_RE = /#map-pin"?><\/use><\/svg>\s*<div[^>]*title=["']([^"']*)["']/i;

const POSTED_LABEL_RE =
  /(?:Posted|Đăng)\s*:?\s*(?:<\/\w+>\s*)?([^.<]{0,40}?(?:ago|trước)|today|hôm nay)/i;

function assertItviecUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`itviec: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`itviec: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`itviec: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

export function visibleText(fragment) {
  return decodeEntities(
    String(fragment ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const CITY_SLUGS = ({
  hcm: 'ho-chi-minh-hcm',
  'ho chi minh': 'ho-chi-minh-hcm',
  'hồ chí minh': 'ho-chi-minh-hcm',
  hanoi: 'ha-noi',
  'ha noi': 'ha-noi',
  'hà nội': 'ha-noi',
  danang: 'da-nang',
  'da nang': 'da-nang',
  'đà nẵng': 'da-nang',
});

export function cityPath(location) {
  const key = String(location ?? '').trim().toLowerCase();
  if (!key) return null;
  if (Object.hasOwn(CITY_SLUGS, key)) return CITY_SLUGS[key];
  for (const [candidate, slug] of Object.entries(CITY_SLUGS)) {
    if (key.includes(candidate)) return slug;
  }
  return null;
}

export function buildListUrl(entry, page) {
  let path = LIST_URL;
  const keywords = String(entry?.searchKeywords ?? '').trim().replace(/\s+/g, '-').toLowerCase();
  if (keywords) path += `/${encodeURIComponent(keywords).replace(/%2F/gi, '')}`;
  const city = cityPath(entry?.searchLocation);
  if (city) path += `/${city}`;
  return page <= 1 ? path : `${path}?page=${page}`;
}

export function parsePostedAt(text, nowMs = Date.now()) {
  const t = String(text ?? '').toLowerCase();
  if (/today|hôm nay/.test(t)) return nowMs;
  const m = /(\d+)\s*(hour|giờ)/.exec(t);
  if (m) return nowMs - Number(m[1]) * 3_600_000;
  const d = /(\d+)\s*(day|ngày)/.exec(t);
  if (d) return nowMs - Number(d[1]) * 86_400_000;
  const w = /(\d+)\s*(week|tuần)/.exec(t);
  if (w) return nowMs - Number(w[1]) * 7 * 86_400_000;
  const mo = /(\d+)\s*(month|tháng)/.exec(t);
  if (mo) return nowMs - Number(mo[1]) * 30 * 86_400_000;
  return undefined;
}

export function parseListingPage(html) {
  const source = String(html ?? '');
  CARD_SPLIT_RE.lastIndex = 0;

  const bySlug = new Map();

  const windows = [];
  let m;
  while ((m = CARD_SPLIT_RE.exec(source)) !== null) {
    if (windows.length > 0) windows[windows.length - 1].end = m.index;
    windows.push({ slug: m[1], start: m.index, end: source.length });
  }

  for (const win of windows) {
    if (bySlug.has(win.slug)) continue;
    const card = source.slice(win.start, win.end);

    const titleMatch = TITLE_ANCHOR_RE.exec(card);
    const title = titleMatch ? visibleText(titleMatch[1]) : '';

    let company = '';
    COMPANY_LINK_RE.lastIndex = 0;
    let cm;
    while ((cm = COMPANY_LINK_RE.exec(card)) !== null) {
      const name = visibleText(cm[1]);
      if (name) { company = name; break; }
    }

    const locMatch = LOCATION_RE.exec(card);
    const location = locMatch ? decodeEntities(locMatch[1]).trim() : '';

    const postedMatch = POSTED_LABEL_RE.exec(card);
    const postedAt = postedMatch ? parsePostedAt(postedMatch[0], Date.now()) : undefined;

    bySlug.set(win.slug, {
      title,
      url: `${LIST_URL}/${win.slug}`,
      company,
      location,
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }

  return [...bySlug.values()].filter((job) => job.title && job.url);
}

export function assertParsedSomething(html, url) {
  if (!/href=["'](?:https?:\/\/itviec\.com)?\/it-jobs\/[a-z0-9-]+-\d+/i.test(String(html ?? ''))) return;
  throw new Error(
    `itviec: ${url} still contains job cards but none could be parsed — the listing markup changed`,
  );
}

export default {
  id: 'itviec',

  detect(entry) {
    return entry?.provider === 'itviec' ? { url: buildListUrl(entry, 1) } : null;
  },

  async fetch(entry, ctx) {
    const entryMaxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const maxPages = Math.min(
      entryMaxPages,
      Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity,
    );

    const jobs = [];
    const seen = new Set();

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const url = assertItviecUrl(buildListUrl(entry, page));
      const html = await fetchTextWithRetry(ctx, url, {
        headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT },
        redirect: 'error',
      });

      const parsed = parseListingPage(html);
      if (parsed.length === 0) {
        if (page === 1) assertParsedSomething(html, url);
        break;
      }

      const before = seen.size;
      for (const job of parsed) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (seen.size === before) break;
    }

    return jobs;
  },
};
