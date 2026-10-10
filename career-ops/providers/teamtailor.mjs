import { decodeEntities } from './_html-entities.mjs';

const TEAMTAILOR_HOST_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.teamtailor\.com$/i;

function assertFeedUrl(url, { explicit = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`teamtailor: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`teamtailor: URL must use HTTPS: ${url}`);
  if (!explicit && !TEAMTAILOR_HOST_RE.test(parsed.hostname)) {
    throw new Error(`teamtailor: untrusted hostname "${parsed.hostname}" — must be <slug>.teamtailor.com (or set "provider: teamtailor" to use a branded careers domain)`);
  }
  return url;
}

function resolveFeedUrl(entry, { explicit = false } = {}) {
  const raw = entry?.api || entry?.careers_url || '';
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!explicit && !TEAMTAILOR_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/jobs.rss`;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Teamtailor';
}

export default {
  id: 'teamtailor',

  detect(entry) {
    const url = resolveFeedUrl(entry, { explicit: false });
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const explicit = entry?.provider === 'teamtailor';
    const feedUrl = resolveFeedUrl(entry, { explicit });
    if (!feedUrl) throw new Error(`teamtailor: cannot derive jobs.rss URL for ${fallbackCompany(entry)}`);
    assertFeedUrl(feedUrl, { explicit });
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseTeamtailorFeed(text, fallbackCompany(entry));
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

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function resolveLocation(item) {
  const city = tagText(item, 'tt:city');
  const country = tagText(item, 'tt:country');
  const place = [city, country].filter(Boolean).join(', ');
  if (place) return place;
  const remote = tagText(item, 'remoteStatus').toLowerCase();
  return remote === 'fully' || remote === 'temporary' ? 'Remote' : '';
}

export function parseTeamtailorFeed(xml, defaultCompany = 'Teamtailor') {
  if (typeof xml !== 'string') return [];
  const company = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'Teamtailor';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    const job = {
      title,
      company,
      location: resolveLocation(item),
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
