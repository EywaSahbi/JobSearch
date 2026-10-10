const PINPOINT_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pinpointhq\.com$/;

function assertPinpointUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`pinpoint: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`pinpoint: URL must use HTTPS: ${url}`);
  if (!PINPOINT_HOST_RE.test(parsed.hostname)) {
    throw new Error(`pinpoint: untrusted hostname "${parsed.hostname}" — must match <slug>.pinpointhq.com`);
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
  if (!PINPOINT_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/postings.json`;
}

export default {
  id: 'pinpoint',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`pinpoint: cannot derive API URL for ${entry.name}`);
    assertPinpointUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parsePinpointResponse(json, entry.name);
  },
};

const PINPOINT_DEMO_VIDEO_MARKER = 'youtube.com/embed/https://www.youtube.com/embed/pFxm6fszrpw';

function isPinpointDemoPosting(j) {
  const description = typeof j?.description === 'string' ? j.description : '';
  return description.includes(PINPOINT_DEMO_VIDEO_MARKER);
}

export function parsePinpointResponse(json, companyName) {
  const postings = json?.data;
  if (!Array.isArray(postings)) return [];
  return postings
    .map(j => {
      if (isPinpointDemoPosting(j)) return null;

      const title = typeof j?.title === 'string' ? j.title.trim() : '';
      if (!title) return null;

      let url = '';
      const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'https:') url = parsed.href;
        } catch {
        }
      }
      if (!url) return null;

      const loc = j?.location && typeof j.location === 'object' ? j.location : {};
      const name = typeof loc.name === 'string' ? loc.name.trim() : '';
      const city = typeof loc.city === 'string' ? loc.city.trim() : '';
      const province = typeof loc.province === 'string' ? loc.province.trim() : '';
      const location = name || [city, province].filter(Boolean).join(', ');

      return { title, url, location, company: companyName };
    })
    .filter(Boolean);
}
