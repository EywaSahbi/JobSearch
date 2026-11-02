import { decodeEntities } from './_html-entities.mjs';

const TRUSTED_HOST = 'hiringroom.com';

function assertHiringRoomUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hiringroom: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`hiringroom: URL must use HTTPS: ${url}`);
  const host = parsed.hostname.toLowerCase();
  if (host !== TRUSTED_HOST && !host.endsWith(`.${TRUSTED_HOST}`)) {
    throw new Error(`hiringroom: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST} or a subdomain`);
  }
  return parsed;
}

export default {
  id: 'hiringroom',

  detect(entry) {
    const url = entry?.careers_url || '';
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`)) return { url };
    } catch {
    }
    return null;
  },

  async fetch(entry, ctx) {
    const listUrl = entry.careers_url || '';
    const parsed = assertHiringRoomUrl(listUrl);
    const html = await ctx.fetchText(parsed.href, { redirect: 'error' });
    const company = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'HiringRoom';
    return parseHiringRoomJobs(html, parsed.origin, company);
  },
};

export function parseHiringRoomJobs(html, origin, company = 'HiringRoom') {
  if (typeof html !== 'string') return [];
  const fromJsonLd = parseJsonLdJobs(html, origin, company);
  if (fromJsonLd.length > 0) return fromJsonLd;
  const jobs = [];
  const seen = new Set();

  const anchorRe = /href="(\/jobs\/get_vacancy\/[a-f0-9]+)"/gi;
  const matches = [...html.matchAll(anchorRe)];

  for (let k = 0; k < matches.length; k++) {
    const href = matches[k][1];
    if (/\/candidates\//i.test(href)) continue;

    const start = matches[k].index ?? 0;
    const end = k + 1 < matches.length ? (matches[k + 1].index ?? html.length) : html.length;
    const block = html.slice(start, end);

    const titleM = block.match(/name__vacancy[^>]*>([\s\S]*?)<\/h4>/i);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!title) continue;

    const url = origin + href;
    if (seen.has(url)) continue;
    seen.add(url);

    const locM = block.match(/hr-Location-pin[^>]*><\/i>\s*([^<]+)/i);
    const location = locM ? decodeEntities(locM[1]).replace(/\s+/g, ' ').trim() : '';

    jobs.push({ title, url, company, location });
  }

  return jobs;
}

const VACANCY_PATH_RE = /^\/jobs\/get_vacancy\/[a-f0-9]+$/i;

function htmlToText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

function jsonLdLocation(loc) {
  const place = Array.isArray(loc) ? loc[0] : loc;
  const address = place && typeof place === 'object' ? (place).address : undefined;
  if (typeof address === 'string') return decodeEntities(address).replace(/\s+/g, ' ').trim();
  if (address && typeof address === 'object') {
    return ['addressLocality', 'addressRegion', 'addressCountry']
      .map(k => address[k])
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim())
      .join(', ');
  }
  return '';
}

function parseJsonLdJobs(html, origin, company) {
  const host = new URL(origin).hostname.toLowerCase();
  const jobs = [];
  const seen = new Set();
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const [, body] of html.matchAll(scriptRe)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    const items = Array.isArray(data?.itemListElement) ? data.itemListElement : [];
    for (const el of items) {
      const posting = el?.item;
      if (!posting || posting['@type'] !== 'JobPosting') continue;
      const title = typeof posting.title === 'string' ? htmlToText(posting.title) : '';
      if (!title) continue;

      let parsed;
      try {
        parsed = new URL(String(posting.url));
      } catch {
        continue;
      }
      if (parsed.hostname.toLowerCase() !== host || !VACANCY_PATH_RE.test(parsed.pathname)) continue;
      const url = origin + parsed.pathname;
      if (seen.has(url)) continue;
      seen.add(url);

      const job = { title, url, company, location: jsonLdLocation(posting.jobLocation) };
      if (typeof posting.description === 'string') {
        const description = htmlToText(posting.description);
        if (description) job.description = description;
      }
      const postedAt = Date.parse(String(posting.datePosted));
      if (Number.isFinite(postedAt)) job.postedAt = postedAt;
      jobs.push(job);
    }
  }
  return jobs;
}
