import { decodeEntities } from './_html-entities.mjs';

const PERSONIO_HOST_RE = /^[a-z0-9][a-z0-9-]*\.jobs\.personio\.(de|com)$/;

function assertPersonioUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`personio: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`personio: URL must use HTTPS: ${url}`);
  if (!PERSONIO_HOST_RE.test(parsed.hostname))
    throw new Error(`personio: untrusted hostname "${parsed.hostname}" — must match <slug>.jobs.personio.(de|com)`);
  return url;
}

const PERSONIO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

function resolveHost(entry) {
  if (typeof entry.personio === 'string') {
    const slug = entry.personio.trim();
    if (PERSONIO_SLUG_RE.test(slug)) return `${slug}.jobs.personio.de`;
  }
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!PERSONIO_HOST_RE.test(parsed.hostname)) return null;
  return parsed.hostname;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export default {
  id: 'personio',

  detect(entry) {
    const host = resolveHost(entry);
    return host ? { url: `https://${host}/xml` } : null;
  },

  async fetch(entry, ctx) {
    const host = resolveHost(entry);
    if (!host) throw new Error(`personio: cannot derive feed URL for ${entry.name}`);
    const feedUrl = `https://${host}/xml`;
    assertPersonioUrl(feedUrl);
    try {
      const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
      return parsePersonioXml(text, entry.name, host);
    } catch (err) {
      if (err?.status !== 404) throw err;
      const pageUrl = `https://${host}/?language=en`;
      assertPersonioUrl(pageUrl);
      const html = await ctx.fetchText(pageUrl, { redirect: 'error' });
      return parsePersonioHtml(html, entry.name, host);
    }
  },
};

function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function stripTags(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, '');
  } while (s !== prev);
  return s;
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? extractText(m[1]) : '';
}

export function parsePersonioXml(xml, companyName, host) {
  if (typeof xml !== 'string') return [];
  const jobs = [];
  const stripped = xml.replace(/<jobDescriptions\b[^>]*>[\s\S]*?<\/jobDescriptions>/gi, '');
  const blocks = stripped.match(/<position\b[^>]*>[\s\S]*?<\/position>/g) || [];
  for (const scalar of blocks) {
    const title = tagText(scalar, 'name');
    if (!title) continue;

    const id = tagText(scalar, 'id');
    if (!/^\d+$/.test(id)) continue;

    const offices = [];
    const seen = new Set();
    for (const om of scalar.matchAll(/<office\b[^>]*>([\s\S]*?)<\/office>/g)) {
      const name = extractText(om[1]);
      if (name && !seen.has(name)) {
        seen.add(name);
        offices.push(name);
      }
    }

    jobs.push({
      title,
      url: `https://${host}/job/${id}`,
      location: offices.join(', '),
      company: companyName,
      postedAt: toEpochMs(tagText(scalar, 'createdAt')),
    });
  }
  return jobs;
}

export function parsePersonioHtml(html, companyName, host) {
  if (typeof html !== 'string') return [];
  const jobs = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1];
    if (!/\bclass="[^"]*\bjob-box\b[^"]*"/.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref="\/job\/(\d+)(?:\?[^"]*)?"/);
    if (!hrefMatch) continue;
    const id = hrefMatch[1];
    if (seen.has(id)) continue;
    const block = m[2];

    const titleMatch = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const title = decodeEntities(stripTags(titleMatch[1])).trim();
    if (!title) continue;

    const locMatch = block.match(/<span\b[^>]*class="[^"]*jobMetaText[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const location = locMatch ? decodeEntities(stripTags(locMatch[1])).trim() : '';

    seen.add(id);
    jobs.push({
      title,
      url: `https://${host}/job/${id}`,
      location,
      company: companyName,
    });
  }
  return jobs;
}
