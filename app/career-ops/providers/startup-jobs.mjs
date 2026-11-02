import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

const FEED_HOST = 'startup.jobs';
const FEED_PATH = '/feeds/jobs';

function assertStartupJobsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`startup-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`startup-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== FEED_HOST) {
    throw new Error(`startup-jobs: untrusted hostname "${parsed.hostname}" - must be ${FEED_HOST}`);
  }
  return url;
}

function buildFeedUrl(entry) {
  const cfg = entry?.startup_jobs && typeof entry.startup_jobs === 'object' ? entry.startup_jobs : {};
  const params = new URLSearchParams();
  if (typeof cfg.role === 'string' && cfg.role.trim()) params.set('role', cfg.role.trim());
  if (typeof cfg.workplace === 'string' && cfg.workplace.trim()) params.set('workplace', cfg.workplace.trim());
  const qs = params.toString();
  return `https://${FEED_HOST}${FEED_PATH}${qs ? `?${qs}` : ''}`;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitTitleCompany(rawTitle) {
  const idx = rawTitle.lastIndexOf(' at ');
  if (idx === -1) return null;
  const title = rawTitle.slice(0, idx).trim();
  const company = rawTitle.slice(idx + 4).trim().replace(/^bei\s+/i, '');
  if (!title || !company) return null;
  return { title, company };
}

function extractLocation(description) {
  if (!description) return '';
  const lines = description.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1];
  const sep = last.indexOf(' · ');
  return (sep === -1 ? last : last.slice(0, sep)).trim();
}

export default {
  id: 'startup-jobs',

  detect(entry) {
    return entry?.provider === 'startup-jobs' ? { url: buildFeedUrl(entry) } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertStartupJobsUrl(buildFeedUrl(entry));
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseStartupJobsFeed(text);
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
    if (parsed.protocol !== 'https:' || parsed.hostname !== FEED_HOST) return '';
    return `https://${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '';
  }
}

const ENVELOPE_RE = /<rss\b[^>]*>[\s\S]*<channel\b[^>]*>[\s\S]*<\/channel>[\s\S]*<\/rss>/i;

function maskCdataAndComments(str) {
  return str.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, (m) => '#'.repeat(m.length));
}

export function parseStartupJobsFeed(xml) {
  if (typeof xml !== 'string') {
    throw new Error(`startup-jobs: unexpected feed response — expected an <rss><channel> envelope, got: ${typeof xml}`);
  }

  const maskedXml = maskCdataAndComments(xml);

  if (!ENVELOPE_RE.test(maskedXml)) {
    throw new Error(`startup-jobs: unexpected feed response — expected an <rss><channel> envelope, got: ${xml.length}-char body`);
  }

  const maskedChannelBody = (maskedXml.match(/<channel\b[^>]*>([\s\S]*)<\/channel>/i) || [, ''])[1];
  const openItems = (maskedChannelBody.match(/<item\b/gi) || []).length;
  const closedItems = (maskedChannelBody.match(/<\/item>/gi) || []).length;
  if (openItems !== closedItems) {
    throw new Error(`startup-jobs: malformed feed — ${openItems} <item> open tag(s) but ${closedItems} </item> close tag(s) (truncated response?)`);
  }

  const jobs = [];
  const blocks = [];
  for (const m of maskedXml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/gi)) {
    blocks.push(xml.slice(m.index, m.index + m[0].length));
  }

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const rawTitle = tagText(item, 'title');
    if (!rawTitle) continue;

    const split = splitTitleCompany(rawTitle);
    if (!split) continue;
    const { title, company } = split;
    const description = tagText(item, 'description');
    const postedAt = toEpochMs(tagText(item, 'pubDate'));

    const job = {
      title,
      company,
      location: extractLocation(description),
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    const descriptionText = htmlToText(description);
    if (descriptionText) job.description = descriptionText;
    jobs.push(job);
  }

  return jobs;
}
