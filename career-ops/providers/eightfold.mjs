import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';
import { coerceId } from './_ids.mjs';

const EIGHTFOLD_HOST_RE = /^[a-z0-9-]+\.eightfold\.ai$/i;

const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 200;
const MAX_PAGES_CAP = 1000;
const INTER_PAGE_DELAY_MS = 250;

const RETRY_POLICY = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };
const PCSX_INTER_PAGE_DELAY_MS = 400;
const PCSX_RETRY_POLICY = { retries: 5, baseDelayMs: 2_000, maxDelayMs: 32_000 };

function assertEightfoldUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`eightfold: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`eightfold: URL must use HTTPS: ${url}`);
  if (!EIGHTFOLD_HOST_RE.test(parsed.hostname)) {
    throw new Error(`eightfold: untrusted hostname "${parsed.hostname}" — must match *.eightfold.ai`);
  }
  return url;
}

function epochSecondsToMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

export function resolveTenant(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!EIGHTFOLD_HOST_RE.test(parsed.hostname)) continue;

    const override = typeof entry.domain === 'string' && entry.domain.trim()
      ? entry.domain.trim()
      : null;
    const fromUrl = parsed.searchParams.get('domain');
    const domain = override || (fromUrl && fromUrl.trim() ? fromUrl.trim() : null);

    return { host: parsed.hostname.toLowerCase(), domain };
  }
  return null;
}

export function buildApiUrl(tenant, start = 0, num = PAGE_SIZE) {
  const params = new URLSearchParams();
  if (tenant.domain) params.set('domain', tenant.domain);
  params.set('start', String(start));
  params.set('num', String(num));
  return `https://${tenant.host}/api/apply/v2/jobs?${params.toString()}`;
}

export function buildPcsxUrl(tenant, start = 0) {
  const params = new URLSearchParams();
  if (tenant.domain) params.set('domain', tenant.domain);
  params.set('start', String(start));
  return `https://${tenant.host}/api/pcsx/search?${params.toString()}`;
}

export function normalizePcsxPage(json) {
  const data = json && typeof json === 'object' ? (json).data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) return null;
  const positions = data.positions.map((p) => (p && typeof p === 'object'
    ? { ...p, t_create: p.t_create ?? p.postedTs ?? p.creationTs, ats_job_id: p.ats_job_id ?? p.atsJobId ?? p.displayJobId }
    : p));
  return { positions, count: typeof data.count === 'number' ? data.count : undefined };
}

export function buildJobUrl(tenant, pid) {
  const params = new URLSearchParams();
  params.set('pid', pid);
  if (tenant.domain) params.set('domain', tenant.domain);
  return `https://${tenant.host}/careers?${params.toString()}`;
}

function assembleLocation(p) {
  const parts = [];
  if (typeof p.location === 'string' && p.location.trim()) parts.push(p.location.trim());
  if (Array.isArray(p.locations)) {
    for (const loc of p.locations) {
      if (typeof loc === 'string' && loc.trim()) parts.push(loc.trim());
    }
  }
  return [...new Set(parts)].join(' · ');
}

export function parseEightfoldResponse(json, tenant, companyName) {
  if (!json || typeof json !== 'object') return [];
  const positions = (json).positions;
  if (!Array.isArray(positions)) return [];

  const out = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;

    const title = (typeof p.name === 'string' && p.name.trim())
      ? p.name.trim()
      : (typeof p.posting_name === 'string' ? p.posting_name.trim() : '');
    if (!title) continue;

    let url = '';
    const canonical = typeof p.canonicalPositionUrl === 'string' ? p.canonicalPositionUrl.trim() : '';
    if (canonical) {
      try {
        const parsed = new URL(canonical);
        if (parsed.protocol === 'https:') url = parsed.href;
      } catch {
      }
    }
    if (!url) {
      const pid = coerceId(p.id) ?? coerceId(p.position_id);
      if (pid) url = buildJobUrl(tenant, pid);
    }
    if (!url) continue;

    const job = {
      title,
      url,
      company: companyName,
      location: assembleLocation(p),
    };
    const postedAt = epochSecondsToMs(p.t_create) ?? epochSecondsToMs(p.t_update);
    if (postedAt !== undefined) job.postedAt = postedAt;

    const ext = coerceId(p.id) ?? coerceId(p.position_id);
    if (ext) job.externalId = ext;
    const req = coerceId(p.ats_job_id);
    if (req) job.requisitionId = req;

    out.push(job);
  }
  return out;
}

function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

export default {
  id: 'eightfold',

  detect(entry) {
    try {
      const tenant = resolveTenant(entry);
      return tenant ? { url: buildApiUrl(tenant, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`eightfold: cannot derive API URL for ${entry.name}`);

    const maxPages = resolveMaxPages(entry, ctx);
    const all = [];
    let total = null;
    let api = 'v2';
    let rateLimited = false;

    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      if (page > 0) await sleep(api === 'pcsx' ? PCSX_INTER_PAGE_DELAY_MS : INTER_PAGE_DELAY_MS, ctx);

      const request = async (which) => {
        const url = which === 'pcsx' ? buildPcsxUrl(tenant, start) : buildApiUrl(tenant, start, PAGE_SIZE);
        assertEightfoldUrl(url);
        return (await fetchJsonWithRetry(
          (ctx),
          url,
          {
            redirect: 'error',
            headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
          },
          which === 'pcsx' ? PCSX_RETRY_POLICY : RETRY_POLICY,
        ));
      };

      let json;
      try {
        json = await request(api);
      } catch (err) {
        const status = (err)?.status;
        if (api === 'v2' && page === 0 && status === 403) {
          let pcsxJson = null;
          try {
            pcsxJson = await request('pcsx');
          } catch (probeErr) {
            if ([403, 404, 410].includes((probeErr)?.status)) throw err;
            throw probeErr;
          }
          const page0 = normalizePcsxPage(pcsxJson);
          if (!page0) {
            throw new Error(
              `eightfold: ${entry.name} answered 403 on /api/apply/v2/jobs and an unrecognized body on /api/pcsx/search — neither API is readable`,
              { cause: err },
            );
          }
          api = 'pcsx';
          json = { positions: page0.positions, ...(page0.count === undefined ? {} : { count: page0.count }) };
        } else if (status === 429 && all.length > 0) {
          rateLimited = true;
          break;
        } else {
          throw err;
        }
      }

      if (api === 'pcsx' && !(json && typeof json === 'object' && 'positions' in json)) {
        const normalized = normalizePcsxPage(json);
        if (!normalized) {
          throw new Error(`eightfold: ${entry.name} returned an unrecognized /api/pcsx/search body at start=${start}`);
        }
        json = { positions: normalized.positions, ...(normalized.count === undefined ? {} : { count: normalized.count }) };
      }

      all.push(...parseEightfoldResponse(json, tenant, entry.name));

      const positions = Array.isArray(json?.positions) ? json.positions : [];
      if (total === null && typeof json?.count === 'number' && Number.isFinite(json.count)) {
        total = json.count;
      }

      if (positions.length === 0 || positions.length < PAGE_SIZE) break;
      if (total !== null && start + PAGE_SIZE >= total) break;
    }

    if (rateLimited) {
      console.error(`⚠️  eightfold: ${entry.name} stopped early on HTTP 429 (${all.length}${total === null ? '' : ` of ${total}`} jobs) — the board is partial, not empty`);
      (all).eightfoldTruncated = true;
    } else if (total !== null && all.length < total && maxPages * PAGE_SIZE < total) {
      console.error(`⚠️  eightfold: ${entry.name} truncated at max_pages=${maxPages} (${all.length} of ${total} jobs) — raise max_pages on this entry for more`);
    }

    return all;
  },
};
