import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const TRUSTED_HOST = 'careerviet.vn';
const BASE_URL = 'https://careerviet.vn/viec-lam';

const DEFAULT_MAX_PAGES = 10;

const MAX_PAGES_CAP = 50;

const INTER_PAGE_DELAY_MS = 750;

const CARD_SPLIT_RE = /id=["']job-item-([A-Za-z0-9]+)["']/g;

const TITLE_LINK_RE = /<a class=["']job_link["'][^>]*title=["']([^"']*)["'][^>]*href=["']([^"']+)["']/i;

const COMPANY_RE = /<a class=["']company-name["'][^>]*title=["']([^"']*)["']/i;

const LOCATION_RE = /<div class=["']location["'][^>]*>(?:(?!<\/div>)[\s\S])*?<li>([^<]*)<\/li>/i;

const UPDATED_DATE_RE = /Cập nhật(?:<!--[\s\S]*?-->)?\s*:?\s*(?:<\/span>)?\s*<time>([\d/-]+)<\/time>/i;

function assertCareerVietUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`careerviet: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`careerviet: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`careerviet: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
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
  hcm: 'tai-ho-chi-minh-kl8',
  'ho chi minh': 'tai-ho-chi-minh-kl8',
  'hồ chí minh': 'tai-ho-chi-minh-kl8',
});

export function citySegment(location) {
  const key = String(location ?? '').trim().toLowerCase();
  if (!key) return null;
  if (Object.hasOwn(CITY_SLUGS, key)) return CITY_SLUGS[key];
  for (const [candidate, slug] of Object.entries(CITY_SLUGS)) {
    if (key.includes(candidate)) return slug;
  }
  return null;
}

export function buildListUrl(entry, page) {
  const keywords = String(entry?.searchKeywords ?? '').trim().replace(/\s+/g, '-').toLowerCase();
  const city = citySegment(entry?.searchLocation);

  let slug;
  if (keywords && city) slug = `${encodeURIComponent(keywords).replace(/%2F/gi, '')}-${city}`;
  else if (keywords) slug = `${encodeURIComponent(keywords).replace(/%2F/gi, '')}-k`;
  else slug = 'tat-ca-viec-lam';

  const suffix = page <= 1 ? '-vi.html' : `-trang-${page}-vi.html`;
  return `${BASE_URL}/${slug}${suffix}`;
}

export function parsePostedAt(text) {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return undefined;
  const [, d, mo, y] = m;
  const ms = Date.parse(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00+07:00`);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseListingPage(html) {
  const source = String(html ?? '');
  CARD_SPLIT_RE.lastIndex = 0;

  const byId = new Map();

  const windows = [];
  let m;
  while ((m = CARD_SPLIT_RE.exec(source)) !== null) {
    if (windows.length > 0) windows[windows.length - 1].end = m.index;
    windows.push({ id: m[1], start: m.index, end: source.length });
  }

  for (const win of windows) {
    if (byId.has(win.id)) continue;
    const card = source.slice(win.start, win.end);

    const titleMatch = TITLE_LINK_RE.exec(card);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
    const href = titleMatch ? titleMatch[2] : '';
    if (!title || !href) continue;

    let url;
    try {
      const resolved = new URL(decodeEntities(href), `https://${TRUSTED_HOST}`);
      if (resolved.protocol !== 'https:' || resolved.hostname !== TRUSTED_HOST) continue;
      url = resolved.toString();
    } catch {
      continue;
    }

    const companyMatch = COMPANY_RE.exec(card);
    const company = companyMatch ? decodeEntities(companyMatch[1]).trim() : '';

    const locMatch = LOCATION_RE.exec(card);
    const location = locMatch ? visibleText(locMatch[1]) : '';

    const dateMatch = UPDATED_DATE_RE.exec(card);
    const postedAt = dateMatch ? parsePostedAt(dateMatch[1]) : undefined;

    byId.set(win.id, {
      title,
      url,
      company,
      location,
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }

  return [...byId.values()];
}

export function assertParsedSomething(html, url) {
  if (!/id=["']job-item-[A-Za-z0-9]+["']/.test(String(html ?? ''))) return;
  throw new Error(
    `careerviet: ${url} still contains job cards but none could be parsed — the listing markup changed`,
  );
}

export default {
  id: 'careerviet',

  detect(entry) {
    return entry?.provider === 'careerviet' ? { url: buildListUrl(entry, 1) } : null;
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

      const url = assertCareerVietUrl(buildListUrl(entry, page));
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
