const COMEET_API_HOST = 'www.comeet.co';

function isComeetApiUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === COMEET_API_HOST && parsed.pathname.startsWith('/careers-api/');
}

function assertComeetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`comeet: invalid URL: ${redactToken(url)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`comeet: URL must use HTTPS: ${redactToken(url)}`);
  if (parsed.hostname !== COMEET_API_HOST)
    throw new Error(`comeet: untrusted hostname "${parsed.hostname}" — must be ${COMEET_API_HOST}`);
  if (!parsed.pathname.startsWith('/careers-api/'))
    throw new Error(`comeet: URL path must be the careers-api endpoint: ${redactToken(url)}`);
  return url;
}

function redactToken(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', 'REDACTED');
    return parsed.href;
  } catch {
    return typeof url === 'string' ? url.replace(/([?&]token=)[^&#]*/gi, '$1REDACTED') : url;
  }
}

function resolveApiUrl(entry) {
  if (isComeetApiUrl(entry.api)) return entry.api;
  if (isComeetApiUrl(entry.careers_url)) return entry.careers_url;
  return null;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export default {
  id: 'comeet',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: redactToken(apiUrl) } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`comeet: cannot derive API URL for ${entry.name} (set api: to the full careers-api positions URL)`);
    assertComeetUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parseComeetResponse(json, entry.name);
  },
};

export function parseComeetResponse(json, companyName) {
  const positions = Array.isArray(json) ? json : [];
  return positions
    .map(row => {
      const j = (row && typeof row === 'object') ? row : {};
      let url = '';
      const rawUrl = j.url_active_page || j.url_comeet_hosted_page || '';
      if (typeof rawUrl === 'string' && rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'https:') url = parsed.href;
        } catch {
        }
      }

      const loc = j.location || {};
      const remote = loc.is_remote ? 'Remote' : '';
      const base = (typeof loc.name === 'string' && loc.name.trim()) ? loc.name.trim() : '';
      const location = remote && !/remote/i.test(base)
        ? [base, remote].filter(Boolean).join(', ')
        : base;

      return {
        title: (typeof j.name === 'string' ? j.name.trim() : ''),
        url,
        location,
        company: companyName,
        postedAt: toEpochMs(j.time_updated),
      };
    })
    .filter(job => job.title && job.url);
}
