import { fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const BOARD_HOST = 'jobs.jobvite.com';
const FEED_HOST = 'app.jobvite.com';
const ALLOWED_HOSTS = new Set([BOARD_HOST, FEED_HOST]);

const FEED_TIMEOUT_MS = 45_000;

function assertJobviteHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobvite: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:')
    throw new Error(`jobvite: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`jobvite: untrusted hostname "${parsed.hostname}" — must be ${BOARD_HOST} or ${FEED_HOST}`);
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function resolveSlug(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== BOARD_HOST) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length || segments[0] === 'api') return null;
  return segments[0];
}

export function resolveConfiguredEid(entry) {
  const direct = typeof entry.company_eid === 'string' ? entry.company_eid.trim() : '';
  if (direct) return direct;

  const api = typeof entry.api === 'string' ? entry.api.trim() : '';
  if (!api) return null;
  let parsed;
  try {
    parsed = new URL(api);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) return null;
  const c = parsed.searchParams.get('c');
  return c && c.trim() ? c.trim() : null;
}

export function extractEidFromBoard(html) {
  if (typeof html !== 'string' || !html) return null;
  const m = html.match(/companyEId\s*[:=]\s*['"]([A-Za-z0-9_-]{4,40})['"]/);
  return m ? m[1] : null;
}

function buildFeedUrl(eid) {
  const u = new URL(`https://${FEED_HOST}/CompanyJobs/Xml.aspx`);
  u.searchParams.set('c', eid);
  return u.href;
}

function buildBoardUrl(slug) {
  return `https://${BOARD_HOST}/${encodeURIComponent(slug)}`;
}

function buildBoardFetchUrl(slug) {
  const u = new URL(buildBoardUrl(slug));
  u.searchParams.set('fr', 'true');
  u.searchParams.set('nl', '1');
  return u.href;
}

const RETRY_POLICY = { retries: 2, baseDelayMs: 1_000, maxDelayMs: 15_000 };

function isEmptyBoardRedirect(err, requestUrl) {
  const status = err?.status;
  if (typeof status !== 'number' || status < 300 || status > 399) return false;
  if (!err.location) return false;
  let target;
  try {
    target = new URL(err.location, requestUrl);
  } catch {
    return false;
  }
  return target.hostname === FEED_HOST && target.pathname.toLowerCase().endsWith('/nojobs.htm');
}

export default {
  id: 'jobvite',

  detect(entry) {
    const eid = resolveConfiguredEid(entry);
    if (eid) return { url: buildFeedUrl(eid) };
    const slug = resolveSlug(entry);
    return slug ? { url: buildBoardUrl(slug) } : null;
  },

  async fetch(entry, ctx) {
    let eid = resolveConfiguredEid(entry);

    if (!eid) {
      const slug = resolveSlug(entry);
      if (!slug) throw new Error(`jobvite: cannot derive a company id for ${entry.name} — set company_eid: or an api: URL with ?c=`);
      const boardUrl = buildBoardFetchUrl(slug);
      assertJobviteHost(boardUrl);
      const html = await fetchTextWithRetry(ctx, boardUrl, { redirect: 'error' }, RETRY_POLICY);
      eid = extractEidFromBoard(html);
      if (!eid) {
        throw new Error(
          `jobvite: could not find companyEId on ${boardUrl} for ${entry.name}. ` +
          `Set it explicitly with company_eid: (find it in the board page source as companyEId: '…').`,
        );
      }
    }

    const feedUrl = buildFeedUrl(eid);
    assertJobviteHost(feedUrl);
    try {
      const xml = await fetchTextWithRetry(
        ctx,
        feedUrl,
        { redirect: 'manual', timeoutMs: FEED_TIMEOUT_MS },
        RETRY_POLICY,
      );
      return parseJobviteXml(xml, entry.name);
    } catch (err) {
      if (isEmptyBoardRedirect(err, feedUrl)) return [];
      throw err;
    }
  },
};

function tagText(block, name) {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = block.indexOf(open);
  if (start === -1) return '';
  const from = start + open.length;
  const end = block.indexOf(close, from);
  if (end === -1) return '';

  let value = block.slice(from, end).trim();
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) {
    value = value.slice('<![CDATA['.length, -']]>'.length).trim();
  }
  return value;
}

export function parseJobviteXml(xml, companyName) {
  if (typeof xml !== 'string' || !xml) return [];

  const out = [];

  const OPEN = '<job>';
  const CLOSE = '</job>';
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf(OPEN, cursor);
    if (start === -1) break;
    const from = start + OPEN.length;
    const end = xml.indexOf(CLOSE, from);
    if (end === -1) break;
    cursor = end + CLOSE.length;
    const block = xml.slice(from, end);

    const title = decodeEntities(tagText(block, 'title'));
    if (!title) continue;

    let url = '';
    for (const candidate of [tagText(block, 'detail-url'), tagText(block, 'apply-url')]) {
      if (!candidate) continue;
      try {
        const p = new URL(decodeEntities(candidate));
        if (p.protocol === 'http:') p.protocol = 'https:';
        if (p.protocol === 'https:') { url = p.href; break; }
      } catch {
      }
    }
    if (!url) continue;

    const location = decodeEntities(tagText(block, 'location'));

    const job = { title, url, company: companyName, location };
    const postedAt = toEpochMs(tagText(block, 'date'));
    if (postedAt !== undefined) job.postedAt = postedAt;

    out.push(job);
  }
  return out;
}
