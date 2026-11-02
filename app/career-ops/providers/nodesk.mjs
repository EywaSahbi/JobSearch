import { decodeEntities } from './_html-entities.mjs';

const FEED_URL = 'https://nodesk.co/remote-jobs/index.xml';
const TRUSTED_HOST = 'nodesk.co';

function assertNodeskUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`nodesk: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`nodesk: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`nodesk: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'NoDesk';
}

export default {
  id: 'nodesk',

  detect(entry) {
    return entry?.provider === 'nodesk' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertNodeskUrl(FEED_URL);
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseNodeskFeed(text, fallbackCompany(entry));
  },
};

function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

function cleanUrl(value) {
  if (!value) return '';
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function splitTitle(rawTitle, defaultCompany) {
  const text = rawTitle.trim();
  const lower = text.toLowerCase();
  const idx = lower.lastIndexOf(' at ');
  if (idx > 0) {
    const title = text.slice(0, idx).trim();
    const company = text.slice(idx + 4).trim();
    if (title && company) return { title, company };
  }
  return { title: text, company: defaultCompany };
}

export function parseNodeskFeed(xml, defaultCompany = 'NoDesk') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'NoDesk';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const rawTitle = tagText(item, 'title');
    if (!rawTitle) continue;

    const { title, company } = splitTitle(rawTitle, fallback);
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    const job = {
      title,
      company,
      location: '',
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
