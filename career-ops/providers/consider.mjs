import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const ENDPOINT_PATH = '/api-boards/search-jobs';
const DEFAULT_SIZE = 500;
const HANDSHAKE_TIMEOUT_MS = 8_000;

function resolveOrigin(entry) {
  let parsed;
  try {
    parsed = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || host.includes(':')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host === 'localhost' || host === 'localhost.localdomain') return null;
  if (host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (!host.includes('.')) return null;
  return parsed.origin;
}

async function acquireCsrfHandshake(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/jobs`, {
      headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html,*/*' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return { cookie: null, csrfToken: null };
    const html = await res.text();

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/).filter(Boolean);

    const cookie = setCookies
      .map(c => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ') || null;

    const m = html.match(/"csrfToken"\s*:\s*"([^"]{8,})"/);
    const csrfToken = m ? m[1] : null;

    return { cookie, csrfToken };
  } catch {
    return { cookie: null, csrfToken: null };
  } finally {
    clearTimeout(timer);
  }
}

function locationString(job) {
  if (Array.isArray(job.locations) && job.locations.length) {
    return job.locations.filter(l => typeof l === 'string').join(', ');
  }
  if (Array.isArray(job.normalizedLocations) && job.normalizedLocations.length) {
    return job.normalizedLocations.map(l => l?.label || l?.value).filter(Boolean).join(', ');
  }
  return job.remote ? 'Remote' : '';
}

export default {
  id: 'consider',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return entry.consider_board && origin ? { url: origin + ENDPOINT_PATH } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`consider: ${entry.name} needs an https careers_url on a public host`);
    if (!entry.consider_board) throw new Error(`consider: ${entry.name} needs a 'consider_board' id in portals.yml`);
    const size = Number.isInteger(entry.consider_size) && entry.consider_size > 0 ? entry.consider_size : DEFAULT_SIZE;

    const { cookie, csrfToken } = await (
      typeof ctx._acquireHandshake === 'function'
        ? ctx._acquireHandshake(origin)
        : acquireCsrfHandshake(origin)
    );

    const csrfHeaders = {};
    if (cookie) csrfHeaders.cookie = cookie;
    if (csrfToken) csrfHeaders['x-csrf-token'] = csrfToken;

    const json = await ctx.fetchJson(origin + ENDPOINT_PATH, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        referer: origin + '/jobs',
        ...csrfHeaders,
      },
      body: JSON.stringify({
        meta: { size },
        board: { id: String(entry.consider_board), isParent: true },
        query: { promoteFeatured: true },
      }),
    });

    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs
      .map(j => {
        const rawUrl = j.url || j.applyUrl || '';
        if (!rawUrl) return null;
        let url;
        try {
          url = new URL(rawUrl, origin).toString();
        } catch {
          return null;
        }
        return {
          title: j.title || '',
          url,
          company: j.companyName || entry.name,
          location: locationString(j),
          postedAt: toEpochMs(j.timeStamp),
        };
      })
      .filter(Boolean);
  },
};
