import { fetchTextWithRetry, BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { resolveProfileKeywords } from './_profile-keywords.mjs';

const FEED_URL = 'https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed';
const TRUSTED_HOST = 'www.jobbank.gc.ca';

const PAGE_SIZE = 100;

const DEFAULT_MAX_PAGES = 5;

const MAX_PAGES_CAP = 20;

const INTER_REQUEST_DELAY_MS = 5000;

export function parseJobBankConfig(entry) {
  const cfg = (entry && entry.jobbankca) || {};
  const keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  return { keywords };
}

export function buildFeedUrl(keyword, page) {
  const params = new URLSearchParams({ searchstring: keyword, locationstring: '', page: String(page) });
  return `${FEED_URL}?${params.toString()}`;
}

export function assertJobBankUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobbankca: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobbankca: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`jobbankca: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

function attrsOf(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(["'])((?:(?!\2)[\s\S])*)\2/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[3];
  return attrs;
}

function linkHref(block) {
  const links = (block.match(/<link(?=[\s/>])[^>]*>/gi) || []).map(attrsOf);
  const alternate = links.find((a) => (a.rel || '').toLowerCase() === 'alternate') || links[0];
  return alternate && alternate.href ? decodeEntities(alternate.href).trim() : '';
}

function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST ? parsed.href : '';
  } catch {
    return '';
  }
}

function stripTags(s) {
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  return out.replace(/[<>]/g, '');
}

function summaryField(summaryHtml, label) {
  const re = new RegExp(`<strong>${label}:</strong>\\s*([\\s\\S]*?)\\s*(?:<br\\s*/?>|$)`, 'i');
  const m = summaryHtml.match(re);
  return m ? stripTags(decodeEntities(m[1])).trim() : '';
}

export function parseJobBankFeed(xml) {
  const jobs = [];
  const entries = String(xml ?? '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];

  for (const entry of entries) {
    const url = cleanUrl(linkHref(entry));
    if (!url) continue;

    const title = tagText(entry, 'title');
    if (!title) continue;

    const summaryRaw = tagText(entry, 'summary');
    const company = summaryField(summaryRaw, 'Employer');
    const location = summaryField(summaryRaw, 'Location');

    const updatedRaw = tagText(entry, 'updated');
    const postedAt = updatedRaw ? Date.parse(updatedRaw) : NaN;

    jobs.push({
      title,
      company,
      location,
      url,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    });
  }

  return jobs;
}

export default {
  id: 'jobbankca',

  detect(entry) {
    return entry?.provider === 'jobbankca' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    let { keywords } = parseJobBankConfig(entry);
    if (!keywords.length) keywords = resolveProfileKeywords();
    if (!keywords.length) {
      throw new Error(`jobbankca: entry "${entry?.name || '(unnamed)'}" has no jobbankca.keywords[] and no config/profile.yml target_roles to fall back to`);
    }

    const entryMaxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const maxPages = Math.min(
      entryMaxPages,
      Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity,
    );

    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;

    for (const keyword of keywords) {
      let keywordFailed = false;
      for (let page = 1; page <= maxPages; page++) {
        await sleep(INTER_REQUEST_DELAY_MS, ctx);

        const url = assertJobBankUrl(buildFeedUrl(keyword, page));
        let xml;
        try {
          xml = await fetchTextWithRetry(ctx, url, {
            headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT },
            redirect: 'error',
          });
        } catch (err) {
          if (page === 1) {
            keywordFailed = true;
            errors.push(`"${keyword}": ${(err && err.message) || err}`);
          }
          break;
        }

        const rawEntryCount = (String(xml ?? '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || []).length;
        const parsed = parseJobBankFeed(xml);
        for (const job of parsed) {
          if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        if (rawEntryCount < PAGE_SIZE) break;
      }
      if (!keywordFailed) succeeded++;
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`jobbankca: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byUrl.values()];
  },
};
