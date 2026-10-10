import './_dns-cache.mjs';
import { isIP } from 'node:net';
import {
  DEFAULT_USER_AGENT,
  BROWSER_LIKE_USER_AGENT,
  MACOS_BROWSER_LIKE_USER_AGENT,
} from '../user-agent.mjs';
import { providerFetchContext, isBlockedAddress, blockedAddressError } from './_ip-guard.mjs';
import { normalizeUrl } from '../url-key.mjs';

export { BROWSER_LIKE_USER_AGENT, MACOS_BROWSER_LIKE_USER_AGENT };

const DEFAULT_TIMEOUT_MS = 10_000;
let proxyAgent;
let proxySignature;

async function proxyFor(url) {
  if (process.env.CAREER_OPS_TRUST_PROXY_EGRESS !== '1') return { dispatcher: undefined, proxyHost: undefined };
  const target = new URL(url);
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY || '';
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY || httpProxy;
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  const proxyUrl = target.protocol === 'https:' ? httpsProxy : httpProxy;
  if (!proxyUrl) return { dispatcher: undefined, proxyHost: undefined };
  for (const configuredProxy of [httpProxy, httpsProxy]) {
    if (!configuredProxy) continue;
    const parsed = new URL(configuredProxy);
    if ((parsed.username || parsed.password) && parsed.protocol !== 'https:') {
      throw new Error('Proxy URLs containing credentials must use HTTPS to protect proxy authentication.');
    }
  }
  const proxyHost = new URL(proxyUrl).hostname.replace(/^\[|\]$/g, '');
  const signature = [process.env.http_proxy, process.env.HTTP_PROXY, process.env.https_proxy,
    process.env.HTTPS_PROXY, process.env.no_proxy, process.env.NO_PROXY].join('\0');
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici').catch((cause) => {
    throw new Error('Trusted proxy egress requires undici; run npm install in the career-ops directory, then retry.', { cause });
  });
  if (signature !== proxySignature) {
    proxyAgent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
    proxySignature = signature;
  }
  return { dispatcher: proxyAgent, proxyHost, fetchImpl: undiciFetch };
}

async function fetchWithTimeout(url, opts = {}, consume, allowManualRedirectResponse = false) {
  const targetHost = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const { dispatcher, proxyHost, fetchImpl } = await proxyFor(url);
  if (dispatcher && isIP(targetHost) && isBlockedAddress(targetHost)) throw blockedAddressError(targetHost, targetHost);
  return providerFetchContext.run({ url: String(url), targetHost, proxyHost },
    () => fetchInContext(url, opts, consume, dispatcher, allowManualRedirectResponse, fetchImpl));
}

async function fetchInContext(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'error', onResponse } = {}, consume, dispatcher, allowManualRedirectResponse = false, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has('user-agent')) requestHeaders.set('user-agent', DEFAULT_USER_AGENT);
    if (!requestHeaders.has('accept-encoding')) requestHeaders.set('accept-encoding', 'gzip, deflate, br');
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body,
        redirect,
        signal: controller.signal,
        dispatcher,
      });
    } catch (err) {
      if (!dispatcher && ['ENOTFOUND', 'EAI_AGAIN'].includes(err?.cause?.code)
        && (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY)) {
        err.message += ' (proxy variables are set but provider requests use direct fetch; set CAREER_OPS_TRUST_PROXY_EGRESS=1 only if your proxy blocks private destination addresses)';
      }
      throw err;
    }
    onResponse?.(res);
    const isInspectableManualRedirect = allowManualRedirectResponse
      && redirect === 'manual'
      && res.status >= 300
      && res.status < 400;
    if (!res.ok && !isInspectableManualRedirect) {
      const responseText = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.body = responseText;
      err.retryAfter = res.headers.get('retry-after');
      err.location = res.headers.get('location');
      throw err;
    }
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.json());
}

export async function fetchTextHead(url, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8192;
  return fetchWithTimeout(url, opts, async (res) => {
    const reader = res.body?.getReader?.();
    if (!reader) return String(await res.text()).slice(0, maxBytes);
    const chunks = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  });
}

export async function fetchText(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.text());
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
export async function fetchResponse(url, opts = {}) {
  return await fetchWithTimeout(url, opts, async (res) => {
    const body = NULL_BODY_STATUSES.has(res.status) ? null : await res.text();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }, true);
}

const JITTER_MS = 250;

const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

const REDIRECT_REFUSAL_CAUSE_MESSAGE = 'unexpected redirect';

export function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

export function isRefusedRedirectError(err) {
  return err?.status === undefined
    && err instanceof TypeError
    && err?.cause?.message === REDIRECT_REFUSAL_CAUSE_MESSAGE;
}

export function isRetryableError(err) {
  const status = err?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (isRefusedRedirectError(err)) return false;
  return status === undefined;
}

async function withRetry(request, ctx, policy = {}) {
  const { retries, baseDelayMs, maxDelayMs } = { ...RETRY_DEFAULTS, ...policy };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (err) {
      lastErr = err;
      if (err !== null && (typeof err === 'object' || typeof err === 'function')) err.attempts = attempt + 1;
      if (attempt === retries || !isRetryableError(err)) throw err;
      const jitterMs = Math.min(JITTER_MS, Math.max(0, maxDelayMs));
      const ceiling = Math.max(0, maxDelayMs - jitterMs);
      const backoff = Math.min(baseDelayMs * 2 ** attempt, ceiling);
      const retryAfterMs = parseRetryAfterMs(err?.retryAfter);
      const delayMs = retryAfterMs !== null
        ? Math.min(retryAfterMs, maxDelayMs * 4)
        : backoff + Math.random() * jitterMs;
      await sleep(delayMs, ctx);
    }
  }
  throw lastErr;
}

export async function fetchJsonWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchJson(url, opts), ctx, policy);
}

export async function fetchTextWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchText(url, opts), ctx, policy);
}

export async function fetchResponseWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchResponse(url, opts), ctx, policy);
}

export function makeHttpCtx(observer) {
  const ctx = {
    transport: 'http',
    fetchJson,
    fetchText,
    fetchResponse,
    normalizePostingUrl: normalizeUrl,
  };
  if (!observer) return ctx;
  for (const method of ['fetchJson', 'fetchText', 'fetchResponse']) {
    const original = ctx[method];
    ctx[method] = (url, opts = {}) => {
      observer.onRequest?.();
      return original(url, {
        ...opts,
        onResponse: response => {
          opts.onResponse?.(response);
          observer.onResponse?.(response.status);
        },
      });
    };
  }
  return ctx;
}
