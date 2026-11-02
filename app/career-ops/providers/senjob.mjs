import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const TRUSTED_HOST = 'senjob.com';
const LIST_URL = 'https://senjob.com/offres-d-emploi.php';

const DEFAULT_MAX_PAGES = 10;

const MAX_PAGES_CAP = 50;

const INTER_PAGE_DELAY_MS = 250;

const POSTING_LINK_RE = /href="(https:\/\/senjob\.com\/jobseekers\/[^"]*?_e_(\d+)\.html)"/i;

const POSTING_ANCHOR_RE =
  /<a\s[^>]*href="https:\/\/senjob\.com\/jobseekers\/[^"]*?_e_\d+\.html"[^>]*>([\s\S]*?)<\/a>/i;

const HIDDEN_ISO_DATE_RE = /display:\s*none;?\s*"?>\s*(\d{4}-\d{2}-\d{2})\s*</i;

function assertSenjobUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`senjob: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`senjob: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`senjob: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
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

export function buildListUrl(page) {
  return page <= 1 ? LIST_URL : `${LIST_URL}?page=${page}`;
}

export function parseListingPage(html) {
  const byId = new Map();

  for (const row of String(html ?? '').split(/<tr\b/i)) {
    const link = POSTING_LINK_RE.exec(row);
    if (!link) continue;
    const [, url, id] = link;

    let record = byId.get(id);
    if (!record) {
      record = { title: '', url, company: '', location: '' };
      byId.set(id, record);
    }

    const anchor = POSTING_ANCHOR_RE.exec(row);
    if (anchor && !record.title) {
      record.title = visibleText(anchor[1]);
      record.location = visibleText(row.slice(anchor.index + anchor[0].length))
        .split(/Publi[ée]/i)[0]
        .replace(/^[\s|:-]+|[\s|:-]+$/g, '');
    }

    const date = HIDDEN_ISO_DATE_RE.exec(row);
    if (date && record.postedAt === undefined) {
      const ms = Date.parse(`${date[1]}T00:00:00Z`);
      if (Number.isFinite(ms)) record.postedAt = ms;
    }
  }

  return [...byId.values()].filter((job) => job.title && job.url);
}

export function assertParsedSomething(html, url) {
  if (!/\/jobseekers\/[^"]*?_e_\d+\.html/i.test(String(html ?? ''))) return;
  throw new Error(
    `senjob: ${url} still contains posting links but none could be parsed — the listing markup changed`,
  );
}

export default {
  id: 'senjob',

  detect(entry) {
    return entry?.provider === 'senjob' ? { url: LIST_URL } : null;
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

      const url = assertSenjobUrl(buildListUrl(page));
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
