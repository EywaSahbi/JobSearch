import { decodeEntities } from './_html-entities.mjs';

const DEFAULT_CAT_ID = 68;
const TRUSTED_HOST = 'www.higheredjobs.com';

function feedUrlFor(catId) {
  const catID = typeof catId === 'number' && Number.isFinite(catId) ? catId : DEFAULT_CAT_ID;
  return `https://www.higheredjobs.com/rss/categoryFeed.cfm?catID=${catID}`;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'HigherEdJobs';
}

export default {
  id: 'higheredjobs',

  detect(entry) {
    if (entry?.provider !== 'higheredjobs') return null;
    return { url: feedUrlFor(entry.cat_id) };
  },

  async fetch(entry, ctx) {
    const feedUrl = feedUrlFor(entry?.cat_id);
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    assertRssFeed(text);
    return parseHigherEdJobsFeed(text, fallbackCompany(entry));
  },
};

function assertRssFeed(text) {
  if (typeof text === 'string' && /<(?:rss|channel)\b/i.test(text)) return;
  if (typeof text === 'string' && /<html\b/i.test(text)) {
    throw new Error('higheredjobs: RSS endpoint answered a challenge page, not a feed');
  }
  throw new Error('higheredjobs: RSS endpoint answered no feed');
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

function cleanUrl(value) {
  if (!value) return '';
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST;
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function splitDescription(rawDescription, defaultCompany) {
  const text = rawDescription.trim();
  const open = text.lastIndexOf(' (');
  if (open > 0) {
    const close = text.lastIndexOf(')');
    const company = text.slice(0, open).trim();
    const location = close > open ? text.slice(open + 2, close).trim() : text.slice(open + 2).trim();
    if (company) return { company, location };
  }
  return { company: text || defaultCompany, location: '' };
}

export function parseHigherEdJobsFeed(xml, defaultCompany = 'HigherEdJobs') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'HigherEdJobs';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const { company, location } = splitDescription(tagText(item, 'description'), fallback);

    jobs.push({
      title,
      company,
      location,
      url,
      postedAt: toEpochMs(tagText(item, 'pubDate')),
    });
  }

  return jobs;
}