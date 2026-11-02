import { decodeEntities } from './_html-entities.mjs';

const FEED_URL = 'https://larajobs.com/feed';
const TRUSTED_HOST = 'larajobs.com';

function assertLarajobsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`larajobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`larajobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`larajobs: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'LaraJobs';
}

export default {
  id: 'larajobs',

  detect(entry) {
    return entry?.provider === 'larajobs' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertLarajobsUrl(FEED_URL);
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseLarajobsFeed(text, fallbackCompany(entry));
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
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

export function parseLarajobsFeed(xml, defaultCompany = 'LaraJobs') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'LaraJobs';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const company = tagText(item, 'job:company') || tagText(item, 'dc:creator') || fallback;
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    const job = {
      title,
      company,
      location: tagText(item, 'job:location'),
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
