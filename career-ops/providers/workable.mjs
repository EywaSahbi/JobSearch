import { decodeEntities } from './_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT, isRetryableError, parseRetryAfterMs, sleep } from './_http.mjs';

const ALLOWED_WORKABLE_HOSTS = new Set(['apply.workable.com']);

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const WORKABLE_HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://apply.workable.com',
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

const GIVE_UP_RETRY_AFTER_MS = 30_000;

async function fetchWithRetry(ctx, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw err;
      const retryAfterMs = parseRetryAfterMs(err?.retryAfter);
      if (retryAfterMs !== null && retryAfterMs > GIVE_UP_RETRY_AFTER_MS) throw err;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const delayMs = retryAfterMs !== null ? retryAfterMs : (backoff + Math.random() * 250);
      await sleep(delayMs, ctx);
    }
  }
  throw lastErr;
}

let workableQueue = Promise.resolve();
function serialized(fn) {
  const result = workableQueue.then(fn, fn);
  workableQueue = result.then(() => undefined, () => undefined);
  return result;
}

function assertWorkableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workable: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workable: URL must use HTTPS: ${url}`);
  if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) {
    throw new Error(`workable: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_WORKABLE_HOSTS].join(', ')}`);
  }
  return url;
}

export function resolveWorkableSlug(entry) {
  const raw = entry && typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'apply.workable.com') return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0];
  if (!slug || !SLUG_RE.test(slug)) return null;
  return slug;
}

const widgetUrlFor = (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
const feedUrlFor = (slug) => `https://apply.workable.com/${slug}/jobs.md`;

export default {
  id: 'workable',

  detect(entry) {
    const slug = resolveWorkableSlug(entry);
    return slug ? { url: widgetUrlFor(slug) } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveWorkableSlug(entry);
    if (!slug) throw new Error(`workable: cannot derive feed URL for ${entry.name}`);

    const referer = `https://apply.workable.com/${slug}/`;

    return serialized(async () => {
      const apiUrl = assertWorkableUrl(widgetUrlFor(slug));
      let payload = null;
      try {
        payload = await fetchWithRetry(ctx, () => ctx.fetchJson(apiUrl, {
          redirect: 'error',
          headers: { ...WORKABLE_HEADERS, referer },
        }));
      } catch {
        payload = null;
      }
      if (payload && Array.isArray(payload.jobs)) {
        return parseWorkableWidget(payload, entry.name);
      }

      const feedUrl = assertWorkableUrl(feedUrlFor(slug));
      const text = await fetchWithRetry(ctx, () => ctx.fetchText(feedUrl, {
        redirect: 'error',
        headers: { ...WORKABLE_HEADERS, referer },
      }));
      return parseWorkableMarkdown(text, entry.name);
    });
  },
};

function safeJobUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const LOCATION_SEPARATOR = ' · ';

function formatLocation(job) {
  const parts = [job?.city, job?.country].filter(v => typeof v === 'string' && v.trim());
  const joined = parts.map(v => v.trim()).join(', ');
  if (joined) return joined;
  return job?.telecommuting ? 'Remote' : '';
}

function toPlainText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseWorkableWidget(payload, companyName) {
  if (!payload || !Array.isArray(payload.jobs)) return [];
  const jobs = [];
  const byUrl = new Map();
  for (const raw of payload.jobs) {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    if (!title) continue;

    const url = safeJobUrl(raw?.shortlink) || safeJobUrl(raw?.url);
    if (!url) continue;

    const location = formatLocation(raw);

    const merged = byUrl.get(url);
    if (merged) {
      if (location) merged.locations.add(location);
      continue;
    }

    const job = { title, url, location, company: companyName };

    const description = toPlainText(raw?.description);
    if (description) job.description = description;

    const stamp = Date.parse(raw?.published_on || raw?.created_at || '');
    if (Number.isFinite(stamp)) job.postedAt = stamp;

    jobs.push(job);
    byUrl.set(url, { job, locations: new Set(location ? [location] : []) });
  }

  for (const { job, locations } of byUrl.values()) {
    job.location = [...locations].join(LOCATION_SEPARATOR);
  }
  return jobs;
}

export function parseWorkableMarkdown(text, companyName) {
  if (typeof text !== 'string') return [];
  const jobs = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const location = cols[3] || '';
    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : '';
    if (url.endsWith('.md')) url = url.slice(0, -3);
    if (!url) continue;

    const safe = safeJobUrl(url);
    if (!safe) continue;

    jobs.push({ title, url: safe, location, company: companyName });
  }
  return jobs;
}
