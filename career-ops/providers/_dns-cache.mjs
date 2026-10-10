import dns from 'node:dns';
import { inProviderFetch, isTrustedProxyLookup, isBlockedAddress, blockedAddressError } from './_ip-guard.mjs';

export const RESOLVER_FAILURE_CODES = new Set([
  'ENOTIMP',
  'EREFUSED',
  'ESERVFAIL',
  'EAI_AGAIN',
]);

export function isResolverFailure(err) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth++) {
    if (RESOLVER_FAILURE_CODES.has((e).code)) return true;
  }
  return false;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;
const DEFAULT_LOOKUPS_PER_MIN = 400;
const DEFAULT_BURST = 20;
const MAX_TIMER_MS = 2_147_483_647;

export function createTokenBucket(options = {}) {
  const ratePerMin = options.ratePerMin ?? DEFAULT_LOOKUPS_PER_MIN;
  const capacity = options.capacity ?? DEFAULT_BURST;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;

  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) {
    throw new RangeError(`ratePerMin must be a finite number > 0, got ${ratePerMin}`);
  }
  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a finite number >= 1, got ${capacity}`);
  }

  const tokensPerMs = ratePerMin / 60_000;
  let tokens = capacity;
  let lastRefill = now();
  const queue = [];
  let timerPending = false;
  let delayed = 0;
  let waitedMs = 0;

  function refill() {
    const t = now();
    tokens = Math.min(capacity, tokens + (t - lastRefill) * tokensPerMs);
    lastRefill = t;
  }

  function schedule() {
    if (timerPending || queue.length === 0) return;
    timerPending = true;
    setTimer(pump, Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil((1 - tokens) / tokensPerMs))));
  }

  function pump() {
    timerPending = false;
    refill();
    try {
      while (queue.length > 0 && tokens >= 1) {
        tokens -= 1;
        const { fn, queuedAt } = (queue.shift());
        delayed++;
        waitedMs += now() - queuedAt;
        fn();
      }
    } finally {
      schedule();
    }
  }

  return {
    take(fn) {
      refill();
      if (queue.length === 0 && tokens >= 1) {
        tokens -= 1;
        fn();
        return;
      }
      queue.push({ fn, queuedAt: now() });
      schedule();
    },
    get pending() { return queue.length; },
    stats() { return { delayed, waitedMs }; },
  };
}

export function createCachedLookup(realLookup, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const lookupsPerMin = options.lookupsPerMin ?? DEFAULT_LOOKUPS_PER_MIN;
  const bucket = lookupsPerMin > 0
    ? createTokenBucket({
      ratePerMin: lookupsPerMin,
      capacity: options.burst ?? DEFAULT_BURST,
      now,
      setTimer: options.setTimer,
    })
    : null;

  const cache = new Map();
  const inflight = new Map();

  function guarded(hostname, callback) {
    if (!inProviderFetch()) return callback;
    return (err, ...rest) => {
      if (err) return callback(err, ...rest);
      const addresses = Array.isArray(rest[0])
        ? rest[0].map((entry) => entry && entry.address)
        : [rest[0]];
      const bad = addresses.find((address) => isBlockedAddress(address));
      if (bad !== undefined && !isTrustedProxyLookup(hostname)) return callback(blockedAddressError(hostname, bad));
      return callback(err, ...rest);
    };
  }

  function cachedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    callback = guarded(hostname, callback);
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    const key = `${hostname}|${opts.family ?? 0}|${opts.all ? 1 : 0}|${opts.hints ?? 0}|${opts.verbatim ?? ''}`;

    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      process.nextTick(callback, ...hit.args);
      return;
    }

    const waiting = inflight.get(key);
    if (waiting) {
      waiting.push(callback);
      return;
    }
    inflight.set(key, [callback]);

    const resolve = () => realLookup(hostname, opts, (err, ...rest) => {
      const callbacks = inflight.get(key) ?? [];
      inflight.delete(key);

      const ttl = err ? (isResolverFailure(err) ? negativeTtlMs : 0) : ttlMs;
      if (ttl > 0) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { expires: now() + ttl, args: err ? [err] : [null, ...rest] });
      }

      for (const cb of callbacks) cb(err, ...rest);
    });

    if (bucket) bucket.take(resolve); else resolve();
  }

  for (const sym of Object.getOwnPropertySymbols(realLookup)) {
    cachedLookup[sym] = realLookup[sym];
  }

  cachedLookup.pacingStats = () => (bucket ? bucket.stats() : { delayed: 0, waitedMs: 0 });

  return cachedLookup;
}

export function lookupsPerMinFromEnv(env = process.env) {
  const raw = env.CAREER_OPS_DNS_LOOKUPS_PER_MIN;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LOOKUPS_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `⚠ CAREER_OPS_DNS_LOOKUPS_PER_MIN=${raw} is not a non-negative number — `
      + `using the default ${DEFAULT_LOOKUPS_PER_MIN} lookups/min`,
    );
    return DEFAULT_LOOKUPS_PER_MIN;
  }
  return n;
}

let patched = null;

export function dnsPacingStats() {
  return patched ? patched.pacingStats() : { delayed: 0, waitedMs: 0 };
}

if (process.env.CAREER_OPS_NO_DNS_CACHE !== '1') {
  patched = createCachedLookup(dns.lookup, { lookupsPerMin: lookupsPerMinFromEnv() });
  dns.lookup = patched;
}
