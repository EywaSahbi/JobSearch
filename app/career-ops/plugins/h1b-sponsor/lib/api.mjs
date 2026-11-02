const DEFAULT_BASE = 'https://api.surakshith.com/immigration/v1';

let resolvedBase;

export function apiBase() {
  if (resolvedBase === undefined) resolvedBase = resolveBase();
  return resolvedBase;
}

function resolveBase() {
  const raw = process.env.H1B_API_BASE;
  if (raw === undefined) return DEFAULT_BASE;
  const trimmed = String(raw).trim();
  if (!trimmed) {
    throw new Error('H1B_API_BASE is set but empty. Unset it to use the default endpoint.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`H1B_API_BASE is not a valid URL: ${trimmed}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('H1B_API_BASE must not embed credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('H1B_API_BASE must not contain a query string or a fragment.');
  }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(parsed.hostname);
  const allowedScheme = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback);
  if (!allowedScheme) {
    throw new Error(`H1B_API_BASE must use https, or http on loopback: ${trimmed}`);
  }
  return trimmed.replace(/\/+$/, '');
}
const USER_AGENT = 'career-ops-plugin-h1b-sponsor/1.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_READ_BYTES = 1024 * 1024;

function buildHeaders(token) {
  const h = { 'Accept': 'application/json', 'User-Agent': USER_AGENT };
  if (typeof token === 'string' && token.trim()) {
    h['Authorization'] = `Bearer ${token.trim()}`;
  }
  return h;
}

function parseRetryAfter(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return 1_000;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return 1_000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body, maxRedirects = MAX_REDIRECTS, allowedOrigins } = {}, consume) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const allowed = (Array.isArray(allowedOrigins) && allowedOrigins.length > 0 ? allowedOrigins : [apiBase()])
    .map(o => new URL(o));
  try {
    let requestUrl = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(requestUrl, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      if (res.status < 300 || res.status > 399) {
        return consume ? await consume(res) : res;
      }

      const loc = res.headers.get('location');
      if (!loc) return consume ? await consume(res) : res;

      const next = new URL(loc, requestUrl);
      if (!allowed.some(a => a.host === next.host && a.protocol === next.protocol)) {
        const e = new Error(`H-1B API redirected off-host: ${next.protocol}//${next.host}`);
        e.code = 'REDIRECT_OFF_HOST';
        throw e;
      }
      if (hop >= maxRedirects) {
        const e = new Error(`H-1B API exceeded ${maxRedirects} redirects: ${url}`);
        e.code = 'REDIRECT_LOOP';
        throw e;
      }
      requestUrl = next.href;
    }
  } finally {
    clearTimeout(t);
  }
}

export async function readBoundedText(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { }
    return { oversized: true };
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = typeof res.text === 'function' ? await res.text() : '';
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes > maxBytes ? { oversized: true } : { text };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const size = Number(value.byteLength);
      if (!Number.isFinite(size)) {
        await reader.cancel().catch(() => {});
        return { oversized: true };
      }
      total += size;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { oversized: true };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { }
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(joined) };
}

async function requestJson(url, opts, { allow404 } = {}) {
  const token = opts.token;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const headers = buildHeaders(token);

  const attempt = () => fetchWithTimeout(url, { headers, timeoutMs }, async res => {
    if (res.status === 429) return { kind: 'rate', waitMs: parseRetryAfter(res) };
    if (allow404 && res.status === 404) return { kind: 'missing' };
    if (!res.ok) {
      let text = '';
      try {
        const read = await readBoundedText(res, MAX_READ_BYTES);
        if (!read.oversized) text = read.text;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
      }
      return { kind: 'http', status: res.status, statusText: res.statusText, text };
    }
    let read;
    try {
      read = await readBoundedText(res, MAX_READ_BYTES);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return { kind: 'badjson' };
    }
    if (read.oversized) return { kind: 'toobig' };
    try {
      return { kind: 'json', body: JSON.parse(read.text) };
    } catch {
      return { kind: 'badjson' };
    }
  });

  const timeoutError = (label) => {
    const e = new Error(`H-1B API timeout${label} after ${timeoutMs}ms: ${url}`);
    e.code = 'TIMEOUT';
    return e;
  };

  let out;
  try {
    out = await attempt();
  } catch (err) {
    if (err && err.name === 'AbortError') throw timeoutError('');
    throw err;
  }

  if (out.kind === 'rate') {
    await sleep(Math.min(out.waitMs, MAX_RETRY_WAIT_MS));
    try {
      out = await attempt();
    } catch (err) {
      if (err && err.name === 'AbortError') throw timeoutError(' on retry');
      throw err;
    }
    if (out.kind === 'rate') {
      const e = new Error(`H-1B API rate limited: ${url}`);
      e.code = 'RATE_LIMIT';
      throw e;
    }
  }

  if (out.kind === 'missing') return null;

  if (out.kind === 'toobig') {
    const e = new Error(`H-1B API response exceeded ${MAX_READ_BYTES} bytes: ${url}`);
    e.code = 'BODY_TOO_LARGE';
    throw e;
  }

  if (out.kind === 'http') {
    const e = new Error(`H-1B API ${out.status} ${out.statusText}: ${url}${out.text ? ` -- ${out.text.slice(0, 200)}` : ''}`);
    e.code = 'HTTP_ERROR';
    e.status = out.status;
    throw e;
  }

  if (out.kind === 'badjson') {
    const e = new Error(`H-1B API returned non-JSON body: ${url}`);
    e.code = 'BAD_JSON';
    throw e;
  }

  return out.body;
}

export function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const SUFFIX_CANON = new Map([
  ['corporation', 'corp'],
  ['incorporated', 'inc'],
  ['limited', 'ltd'],
  ['company', 'co'],
]);

export function plausibleMatch(query, candidateName) {
  const tokens = s => {
    const t = String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const merged = [];
    for (let i = 0; i < t.length; i++) {
      let j = i;
      while (t[j].length === 1 && j + 1 < t.length && t[j + 1].length === 1) j++;
      if (j > i) { merged.push(t.slice(i, j + 1).join('')); i = j; } else { merged.push(t[i]); }
    }
    const out = merged[0] === 'the' ? merged.slice(1) : merged.slice();
    if (out.length > 0) {
      const canon = SUFFIX_CANON.get(out[out.length - 1]);
      if (canon) out[out.length - 1] = canon;
    }
    return out;
  };
  const q = tokens(query);
  const c = tokens(candidateName);
  if (q.length === 0 || c.length === 0) return false;
  const isPrefix = (shorter, longer) =>
    shorter.length <= longer.length && shorter.every((t, i) => t === longer[i]);
  return isPrefix(q, c) || isPrefix(c, q);
}

export function pickBestMatch(name, results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const target = normalize(name);
  const exact = results.find(r => r && normalize(r.name) === target);
  if (exact) return exact;
  const plausible = results.find(r => r && plausibleMatch(name, r.name));
  if (plausible) return plausible;
  return null;
}

export async function resolveEmployer(name, opts = {}) {
  const q = String(name || '').trim();
  if (q.length < 2) return null;

  const url = `${apiBase()}/employers/search?q=${encodeURIComponent(q)}`;
  const body = await requestJson(url, opts, { allow404: true });
  if (!body) return null;

  const results = Array.isArray(body.results) ? body.results : [];
  const match = pickBestMatch(q, results);
  if (!match || !match.id) return null;

  return { id: String(match.id), displayName: String(match.name || q) };
}

export async function searchEmployers(name, opts = {}) {
  const q = String(name || '').trim();
  if (q.length < 2) return { total: 0, results: [] };

  const url = `${apiBase()}/employers/search?q=${encodeURIComponent(q)}`;
  const body = await requestJson(url, opts, { allow404: true });
  if (!body || !Array.isArray(body.results)) return { total: 0, results: [] };

  const results = body.results
    .filter(r => r && r.id)
    .map(r => ({ id: String(r.id), name: String(r.name || '') }));
  const total = Number.isFinite(body.total) ? body.total : results.length;
  return { total, results };
}

export function num(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeProfile(raw) {
  if (raw == null || typeof raw !== 'object') return raw;
  const employer = (raw.employer && typeof raw.employer === 'object') ? raw.employer : {};
  const years = (raw.years && typeof raw.years === 'object') ? raw.years : {};
  const filings = (raw.filings && typeof raw.filings === 'object') ? raw.filings : {};
  const gc = (raw.green_card && typeof raw.green_card === 'object') ? raw.green_card : {};
  const redFlagsRaw = (raw.red_flags && typeof raw.red_flags === 'object') ? raw.red_flags : {};
  const staffing = (redFlagsRaw.staffing_shop && typeof redFlagsRaw.staffing_shop === 'object')
    ? redFlagsRaw.staffing_shop
    : null;

  const nPwd = num(gc.pwd);
  const nPerm = num(gc.perm);
  const evidence = gc.evidence;
  const doesGc = evidence === 'present'
    || (nPwd !== null && nPwd > 0)
    || (nPerm !== null && nPerm > 0);

  const firstYear = num(years.first);
  const lastYear = num(years.last);

  const nCertified = num(filings.certified);
  const nLcaTotal = num(filings.lca);
  const nLca = nLcaTotal ?? nCertified ?? 0;

  return {
    n_lca: nLca ?? 0,
    n_certified: nCertified ?? null,
    n_pwd: nPwd ?? 0,
    n_perm: nPerm ?? 0,
    does_gc: doesGc === true,
    first_year: firstYear,
    last_year: lastYear,
    red_flags: {
      staffing_shop: staffing
        ? {
            value: staffing.value === true,
            share: typeof staffing.share === 'number' ? staffing.share : null,
            n_secondary: staffing.n_secondary ?? null,
            n_total: staffing.n_total ?? null,
            basis: staffing.basis ?? null,
          }
        : null,
    },
    employer_name: employer.name ?? null,
    employer_id: employer.id ?? employer.ein ?? null,
  };
}

export async function getEmployerProfile(id, opts = {}) {
  const sanitized = String(id || '').trim();
  if (!sanitized) throw new Error('getEmployerProfile: id is required');
  const url = `${apiBase()}/employers/${encodeURIComponent(sanitized)}`;
  const raw = await requestJson(url, opts, { allow404: false });
  return normalizeProfile(raw);
}
