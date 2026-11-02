import { htmlToText } from './_html-to-text.mjs';

const RECRUITEE_HOST_RE = /^[a-z0-9][a-z0-9-]*\.recruitee\.com$/;

function assertRecruiteeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`recruitee: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`recruitee: URL must use HTTPS: ${url}`);
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`recruitee: untrusted hostname "${parsed.hostname}" — must match <slug>.recruitee.com`);
  }
  return url;
}

function resolveApiUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!RECRUITEE_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/api/offers/`;
}

export default {
  id: 'recruitee',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`recruitee: cannot derive API URL for ${entry.name}`);
    assertRecruiteeUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parseRecruiteeResponse(json, entry.name);
  },
};

const RECRUITEE_SAMPLE_TITLE_RE = /\(sample\)/i;

function isRecruiteeSamplePosting(j) {
  const title = typeof j?.title === 'string' ? j.title : '';
  return RECRUITEE_SAMPLE_TITLE_RE.test(title);
}

function containsWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function assembleLocation(j) {
  const names = Array.isArray(j.locations)
    ? j.locations.map(l => {
        const name = typeof l?.name === 'string' ? l.name.trim() : '';
        if (!name) return '';
        const parts = [name];
        const city = typeof l?.city === 'string' ? l.city.trim() : '';
        if (city && !containsWholeWord(name, city)) parts.push(city);
        const country = typeof l?.country === 'string' ? l.country.trim() : '';
        if (country && !containsWholeWord(name, country)) parts.push(country);
        return parts.join(', ');
      }).filter(Boolean)
    : [];
  const distinctNames = [...new Set(names)];
  if (distinctNames.length > 1) {
    const hasRemote = distinctNames.some(n => n.toLowerCase().includes('remote'));
    return j.remote && !hasRemote ? [...distinctNames, 'Remote'].join(' · ') : distinctNames.join(' · ');
  }
  const city = j.city || '';
  const country = j.country || '';
  const remote = j.remote ? 'Remote' : '';
  if (typeof j.location === 'string' && j.location.trim()) {
    const loc = j.location.trim();
    return typeof country === 'string' && country.trim() && !containsWholeWord(loc, country.trim())
      ? `${loc}, ${country.trim()}`
      : loc;
  }
  return [city, country, remote].filter(Boolean).join(', ');
}

export function parseRecruiteeResponse(json, companyName) {
  const offers = json?.offers;
  if (!Array.isArray(offers)) return [];
  const out = [];
  for (const j of offers) {
    if (!j || typeof j !== 'object') continue;
    if (isRecruiteeSamplePosting(j)) continue;
    const title = typeof j.title === 'string' ? j.title.trim() : '';
    if (!title) continue;

    let url = '';
    for (const candidate of [j.careers_url, j.url]) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:') {
          url = parsed.href;
          break;
        }
      } catch {
      }
    }
    if (!url) continue;

    const location = assembleLocation(j);
    const description = htmlToText(j.description);

    out.push({
      title,
      url,
      location,
      company: companyName,
      ...(description ? { description } : {}),
    });
  }
  return out;
}
