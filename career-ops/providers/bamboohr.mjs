import { safeEncodeURIComponent } from './_safe-url.mjs';

const BAMBOOHR_HOST_RE = /^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/;

function assertBambooHRUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`bamboohr: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`bamboohr: URL must use HTTPS: ${url}`);
  if (!BAMBOOHR_HOST_RE.test(parsed.hostname)) {
    throw new Error(`bamboohr: untrusted hostname "${parsed.hostname}" — must match <tenant>.bamboohr.com`);
  }
  return url;
}

function resolveOrigin(entry) {
  const rawApi = typeof entry.api === 'string' ? entry.api : '';
  const rawCareers = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const raw = (rawApi || rawCareers).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!BAMBOOHR_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}`;
}

export default {
  id: 'bamboohr',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: `${origin}/careers/list` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`bamboohr: cannot derive API URL for ${entry.name}`);
    const apiUrl = `${origin}/careers/list`;
    assertBambooHRUrl(apiUrl);
    try {
      const json = (await ctx.fetchJson(apiUrl, { redirect: 'manual' }));
      return parseBambooHRResponse(json, entry.name, origin);
    } catch (err) {
      if (typeof err?.status === 'number' && err.status >= 300 && err.status < 400) {
        if (/^https?:\/\/(www\.)?bamboohr\.com\/?$/i.test(String(err.location || ''))) {
          const deadErr = new Error(`bamboohr: /careers/list redirected (${err.status} -> ${err.location}) — no such tenant`);
          deadErr.status = 404;
          throw deadErr;
        }
        if (await isLiveWithNoOpenings(origin, ctx)) return [];
        const deadErr = new Error(`bamboohr: /careers/list redirected (${err.status} -> ${err.location}) — no usable public postings`);
        deadErr.status = 404;
        throw deadErr;
      }
      throw err;
    }
  },

  async enrichDate(job, ctx) {
    const detailUrl = `${job.url}/detail`;
    assertBambooHRUrl(detailUrl);
    const json = (await ctx.fetchJson(detailUrl, { redirect: 'error' }));
    const ts = Date.parse(json?.result?.jobOpening?.datePosted || '');
    if (!Number.isNaN(ts)) job.postedAt = ts;
  },
};

async function isLiveWithNoOpenings(origin, ctx) {
  const url = `${origin}/jobs/embed2.php?version=1.0.0&format=json`;
  try {
    const json = (await ctx.fetchJson(url, { redirect: 'error' }));
    return json?.success === true && Array.isArray(json.departments) && json.departments.length === 0;
  } catch {
    return false;
  }
}

export function parseBambooHRResponse(json, companyName, origin) {
  const rows = json?.result;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(j => j && j.jobOpeningName && String(j.id ?? '').trim().length > 0)
    .map(j => {
      const loc = j.location || {};
      const remote = j.isRemote ? 'Remote' : '';
      const location = [loc.city, loc.state, remote].filter(Boolean).join(', ');
      const id = String(j.id).trim();
      const encodedId = safeEncodeURIComponent(id);
      if (encodedId === null) return null;
      return {
        title: String(j.jobOpeningName),
        url: `${origin}/careers/${encodedId}`,
        company: companyName,
        location,
      };
    })
    .filter(Boolean);
}
