import { htmlToText } from './_html-to-text.mjs';
import { coerceId } from './_ids.mjs';

const LEGACY_BOARD_HOSTS = new Set(['boards.greenhouse.io', 'boards.eu.greenhouse.io']);

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  let slug = match ? match[1] : null;
  if (!slug) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && LEGACY_BOARD_HOSTS.has(parsed.hostname)) {
        slug = parsed.pathname.split('/').find(Boolean) ?? null;
      }
    } catch {
    }
  }
  if (!slug || slug === 'embed') {
    try {
      slug = new URL(assertGreenhouseUrl(url)).searchParams.get('for');
    } catch {
    }
  }
  if (!slug || slug === 'embed') return null;
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => WORK_MODEL.test(p));
}

export function officesUrlFor(apiUrl) {
  const m = apiUrl.match(/^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/);
  return m ? `${m[1]}/offices` : null;
}

export function buildOfficeMap(json) {
  const map = new Map();
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const name = typeof office.name === 'string' ? office.name.trim() : '';
      if (name) {
        for (const dept of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(dept?.jobs) ? dept.jobs : []) {
            if (!job || job.id == null) continue;
            if (!map.has(job.id)) map.set(job.id, new Set());
            map.get(job.id).add(name);
          }
        }
      }
      walk(office.children);
    }
  };
  walk(json?.offices);
  return map;
}

export function contentToText(content) {
  return htmlToText(content);
}

export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    const listUrl = new URL(apiUrl);
    listUrl.searchParams.set('content', 'true');
    const listHref = assertGreenhouseUrl(listUrl.href);
    const json = (await ctx.fetchJson(listHref, { redirect: 'error' }));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const usable = jobs.filter(j => j.absolute_url);

    let officeMap = null;
    if (usable.some(j => isWorkModelOnly(j.location?.name))) {
      const officesUrl = officesUrlFor(apiUrl);
      if (officesUrl) {
        try {
          assertGreenhouseUrl(officesUrl);
          officeMap = buildOfficeMap(await ctx.fetchJson(officesUrl, { redirect: 'error' }));
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`⚠️  greenhouse: ${entry.name} /offices enrichment failed — ${cause} (keeping work-model-only locations)`);
          officeMap = null;
        }
      }
    }

    return usable.map((j) => {
      let location = j.location?.name || '';
      if (officeMap && isWorkModelOnly(location)) {
        const offices = officeMap.get(j.id);
        if (offices && offices.size > 0) location = [location, ...[...offices].sort()].join(' · ');
      }
      const description = contentToText(j.content);
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        externalId: coerceId(j.id),
        requisitionId: coerceId(j.requisition_id),
        location,
        ...(description ? { description } : {}),
        postedAt: toEpochMs(j.first_published),
      };
    });
  },
};
