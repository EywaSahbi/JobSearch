import { classifyLiveness } from './liveness-core.mjs';
import { BROWSER_LIKE_USER_AGENT } from './user-agent.mjs';

const NAVIGATE_TIMEOUT_MS = 15_000;
const HYDRATION_POLL_MS = 250;
const HYDRATION_MAX_POLLS = 16;
const HYDRATING_CODES = new Set(['insufficient_content', 'no_apply_control']);
const FRAME_CONTENT_TIMEOUT_MS = 6_000;
const FRAME_CONTENT_POLL_MS = 500;

const BAMBOOHR_HOSTS = [/(^|\.)bamboohr\.com$/];

function isBambooHrHost(hostname) {
  return BAMBOOHR_HOSTS.some((pattern) => pattern.test(hostname));
}

export function sameOrigin(frameUrl, pageUrl) {
  try {
    const a = new URL(frameUrl);
    const b = new URL(pageUrl);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export const LIVENESS_CONTEXT_OPTIONS = {
  userAgent: BROWSER_LIKE_USER_AGENT,
  locale: 'en-US',
};

export async function newLivenessPage(browser) {
  const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
  return context.newPage();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function jitteredDelayMs(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/,
  /^localhost\.localdomain$/,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^::$/,
  /^fc[0-9a-f]{2}:/,
  /^fe80:/,
];

function normalizeHost(rawHostname) {
  if (!rawHostname) return '';
  let h = String(rawHostname).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function extractMappedIPv4(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

export function rejectPrivateOrInvalid(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { code: 'invalid_url', reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { code: 'unsupported_protocol', reason: `unsupported protocol ${parsed.protocol}` };
  }
  const host = normalizeHost(parsed.hostname);
  const mappedIPv4 = extractMappedIPv4(host);
  const candidates = mappedIPv4 ? [host, mappedIPv4] : [host];
  for (const candidate of candidates) {
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return { code: 'blocked_host', reason: `blocked host ${parsed.hostname}` };
    }
  }
  return null;
}

const dnsCache = new Map();

async function resolveViaDns(hostname) {
  const dns = await import('dns/promises');
  const [ipv4, ipv6, lookupList] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
    dns.lookup(hostname, { all: true }).catch(() => [])
  ]);
  return Array.from(new Set([
    ...ipv4,
    ...ipv6,
    ...lookupList.map(item => item.address)
  ]));
}

let hostResolver = resolveViaDns;

export function setHostResolver(resolver) {
  const previous = hostResolver;
  hostResolver = resolver ?? resolveViaDns;
  dnsCache.clear();
  return () => {
    hostResolver = previous;
    dnsCache.clear();
  };
}

async function resolveDnsCached(hostname) {
  if (dnsCache.has(hostname)) {
    const cached = dnsCache.get(hostname);
    if (cached instanceof Error) throw cached;
    return cached;
  }
  try {
    const addresses = await hostResolver(hostname);
    if (addresses.length === 0) {
      const missing = new Error(`DNS resolution returned no addresses for ${hostname}`);
      missing.livenessCode = 'dns_no_addresses';
      throw missing;
    }
    dnsCache.set(hostname, addresses);
    return addresses;
  } catch (err) {
    dnsCache.set(hostname, err);
    throw err;
  }
}

export async function validateUrlSecurity(urlString) {
  const url = new URL(urlString.endsWith('.') ? urlString.slice(0, -1) : urlString);
  const hostname = url.hostname;
  const host = normalizeHost(hostname);
  const addresses = await resolveDnsCached(host);
  for (const ip of addresses) {
    const norm = normalizeHost(ip);
    const mapped = extractMappedIPv4(norm);
    const candidates = mapped ? [norm, mapped] : [norm];
    for (const candidate of candidates) {
      if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(candidate))) {
        throw new Error(`Access denied: Egress guard blocked private target IP ${ip}`);
      }
    }
  }
}

export async function installLivenessRouteGuard(page) {
  if (page && typeof page.route === 'function' && !page._routeInterceptorRegistered) {
    page._routeInterceptorRegistered = true;
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      const errGuard = rejectPrivateOrInvalid(requestUrl);
      if (errGuard) {
        console.warn(`Blocked request to restricted destination: ${requestUrl}`);
        page._blockedByGuard = errGuard;
        return route.abort('blockedbyclient');
      }
      try {
        await validateUrlSecurity(requestUrl);
        return route.continue();
      } catch (err) {
        console.warn(`Blocked request to restricted destination (DNS): ${requestUrl} - ${err.message}`);
        const request = typeof route?.request === 'function' ? route.request() : null;
        const canTell =
          typeof request?.isNavigationRequest === 'function' &&
          typeof request?.frame === 'function' &&
          typeof page?.mainFrame === 'function';
        const isMainDocument = canTell
          ? request.isNavigationRequest() && request.frame() === page.mainFrame()
          : true;
        if (err?.livenessCode !== 'dns_no_addresses' || isMainDocument) {
          page._blockedByGuard = { code: 'blocked_host', reason: err.message };
        }
        return route.abort('blockedbyclient');
      }
    });
  }
}

export async function checkUrlLiveness(page, url, { extraSettleMs = 0 } = {}) {
  const guardError = rejectPrivateOrInvalid(url);
  if (guardError) {
    return { result: 'uncertain', code: guardError.code, reason: guardError.reason };
  }
  if (page) {
    page._blockedByGuard = null;
  }
  await installLivenessRouteGuard(page);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
    const status = response?.status() ?? 0;

    if (extraSettleMs > 0) await page.waitForTimeout(extraSettleMs);

    const extractApplyControls = () => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
      );

      return candidates
        .filter((element) => {
          if (element.closest('nav, header, footer')) return false;
          if (element.closest('[aria-hidden="true"]')) return false;

          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (!element.getClientRects().length) return false;

          return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        })
        .map((element) => {
          const label = [
            element.innerText,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return label;
        })
        .filter(Boolean);
    };

    const supportsFrames = typeof page?.frames === 'function' && typeof page?.mainFrame === 'function';

    const childFrames = (topUrl) =>
      !supportsFrames
        ? []
        : page.frames().filter((frame) => {
            if (frame === page.mainFrame()) return false;
            try {
              return sameOrigin(frame.url() || '', topUrl);
            } catch {
              return false;
            }
          });

    const readPage = async () => {
      const finalUrl = page.url();
      let bodyText = await page.evaluate(() => document.body?.innerText ?? '');
      let applyControls = await page.evaluate(extractApplyControls);
      for (const frame of childFrames(finalUrl)) {
        try {
          const text = await frame.evaluate(() => document.body?.innerText ?? '');
          if (text && text.trim()) bodyText += '\n' + text;
          applyControls = applyControls.concat(await frame.evaluate(extractApplyControls));
        } catch {
        }
      }
      return { finalUrl, bodyText, applyControls };
    };

    const pollPage = async (pageStatus) => {
      let reading = null;
      let hydrating = true;
      let lastError = null;
      for (let poll = 0; ; poll += 1) {
        try {
          reading = await readPage();
          lastError = null;
          const { code } = classifyLiveness({ status: pageStatus, requestedUrl: url, ...reading });
          hydrating = HYDRATING_CODES.has(code);
          if (!hydrating) break;
        } catch (err) {
          lastError = err;
        }
        if (page._blockedByGuard || poll >= HYDRATION_MAX_POLLS) break;
        await page.waitForTimeout(HYDRATION_POLL_MS);
      }
      if (lastError && hydrating) throw lastError;
      if (hydrating && childFrames(reading.finalUrl).length > 0) {
        await waitForFramesToFill(reading.finalUrl);
        reading = await readPage();
      }
      return reading;
    };

    const waitForFramesToFill = async (topUrl) => {
      const deadline = Date.now() + FRAME_CONTENT_TIMEOUT_MS;
      for (;;) {
        let anyEmpty = false;
        for (const frame of childFrames(topUrl)) {
          try {
            const probe = await frame.evaluate(() => document.body?.innerText ?? '');
            if (!probe.trim()) anyEmpty = true;
          } catch {
          }
        }
        if (!anyEmpty || Date.now() >= deadline) break;
        await page.waitForTimeout(FRAME_CONTENT_POLL_MS);
      }
    };

    const reading = await pollPage(status);
    const { finalUrl } = reading;
    let verdict = classifyLiveness({ status, requestedUrl: url, ...reading });

    if (verdict.code === 'insufficient_content' && typeof page.reload === 'function') {
      let host = '';
      try { host = new URL(finalUrl || url).hostname; } catch { }
      if (isBambooHrHost(host)) {
        try {
          const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
          const reloadStatus = reloadResponse?.status() ?? status;
          const reloaded = await pollPage(reloadStatus);
          const reloadVerdict = classifyLiveness({ status: reloadStatus, requestedUrl: url, ...reloaded });
          const stillNotFound = reloadVerdict.code === 'insufficient_content' || reloadVerdict.code === 'listing_page';
          verdict = !stillNotFound
            ? { ...reloadVerdict, reason: `${reloadVerdict.reason} (after BambooHR reload retry)` }
            : {
                result: 'uncertain',
                code: 'bamboohr_render_retry_failed',
                reason: 'BambooHR page did not render content even after a reload retry — not trusted as evidence of removal',
              };
        } catch (err) {
          verdict = {
            result: 'uncertain',
            code: 'bamboohr_render_retry_failed',
            reason: `BambooHR reload retry failed: ${err.message.split('\n')[0]}`,
          };
        }
      }
    }

    if (page && page._blockedByGuard) {
      return { result: 'uncertain', code: page._blockedByGuard.code, reason: page._blockedByGuard.reason };
    }

    return verdict;
  } catch (err) {
    if (page && page._blockedByGuard) {
      return { result: 'uncertain', code: page._blockedByGuard.code, reason: page._blockedByGuard.reason };
    }
    return {
      result: 'uncertain',
      code: 'navigation_error',
      reason: `navigation error: ${err.message.split('\n')[0]}`,
    };
  }
}

const CHALLENGE_CODES = new Set(['bot_challenge', 'access_blocked']);

export function isChallengeResult(result) {
  return result?.result === 'uncertain' && CHALLENGE_CODES.has(result.code);
}

export function createHeadedPageProvider(chromium) {
  let browser = null;
  let page = null;
  let launchFailed = false;
  const isCachedPageUsable = () => {
    if (!page) return false;
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) return false;
    return true;
  };

  return {
    async get() {
      if (page && !isCachedPageUsable()) {
        if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
          try {
            await browser.close();
          } catch {
          }
        }
        page = null;
        browser = null;
      }
      if (page) return page;
      if (launchFailed) return null;
      try {
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
        page = await context.newPage();
        return page;
      } catch {
        launchFailed = true;
        browser = null;
        page = null;
        return null;
      }
    },
    async close() {
      if (browser) {
        try {
          await browser.close();
        } catch {
        }
      }
      browser = null;
      page = null;
    },
  };
}

export async function checkUrlLivenessWithFallback(page, url, { getHeadedPage } = {}) {
  const first = await checkUrlLiveness(page, url);
  if (!getHeadedPage || !isChallengeResult(first)) {
    return first;
  }
  const headedPage = await getHeadedPage();
  if (!headedPage) {
    return first;
  }
  const second = await checkUrlLiveness(headedPage, url, { extraSettleMs: 3_000 });
  if (isChallengeResult(second)) {
    return { ...second, reason: `${second.reason} (headed retry also blocked)` };
  }
  return second;
}
