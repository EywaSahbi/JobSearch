import { htmlToText, DESCRIPTION_CAP } from './_html-to-text.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const CHANNEL_RE = /^[a-z0-9_]{5,32}$/i;
const MAX_PAGES_CAP = 10;
const DEFAULT_SINCE_DAYS = 30;
const TITLE_CAP = 120;
const PAGE_DELAY_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const NON_APPLY_HOSTS = /(^|\.)(t\.me|telegram\.me|telegram\.org|telegra\.ph|telega\.in|vk\.com|vk\.cc|max\.ru|ok\.ru|facebook\.com|fb\.com|instagram\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|tiktok\.com|threads\.net|store\.steampowered\.com|play\.google\.com|apps\.apple\.com|substack\.com|medium\.com|habr\.com|github\.com)$/i;
const SHORTENER_HOSTS = /(^|\.)(goo\.gl|bit\.ly|t\.co|cjl\.ist|clck\.ru|tglink\.io|tinyurl\.com|cutt\.ly|is\.gd|ow\.ly|rb\.gy|surl\.li)$/i;
const FORM_HOSTS = /(^|\.)(forms\.gle|docs\.google\.com|forms\.yandex\.ru|typeform\.com|tally\.so|airtable\.com|notion\.site|notion\.so)$/i;
const BOARD_HOSTS = /(^|\.)(getmatch\.ru|finder\.work|geekjob\.ru|geeklink\.io|linkedin\.com|hh\.ru|career\.habr\.com|djinni\.co|indeed\.com|glassdoor\.com|weworkremotely\.com|remoteok\.com|arbeitnow\.com|cryptojobslist\.com|relocate\.me|lemon\.io)$/i;
const VACANCY_EVIDENCE_RE = /\/(vacanc|job|position|opening|career|apply|hiring)|[-_/](?!(?:19|20)\d{2}(?=[/?#]|$))\d{4,}(?=[/?#]|$)|\/j\/[A-Z0-9]{6,}(?=[/?#]|$)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TRACKING_PARAM_RE = /^(utm_|ref$|referrer$|source$|src$|s$|from$|campaign$|fbclid$|gclid$|yclid$|mc_|_hs|igshid$|trk$)/i;
const LISTING_ROOT_RE = /^\/(jobs|vacancies|careers|career|vacancy|vakansii|job)$/i;
const LOCALE_ROOT_RE = /^(\/[a-z]{2}(-[a-z]{2})?)?$/i;

const EMPLOYER_LABEL_RE = /^[^\p{L}\p{N}]{0,3}\s*(?:компания|компанія|company|работодатель|employer|hiring company)\s*[:：]\s*(.{2,80})$/iu;
const ANONYMOUS_RE = /(?:название скрыто|компания скрыта|name hidden|undisclosed|confidential|\bour client\b|наш(?:его|им|ему)? клиент|для клиента)/i;
const LOCATIONISH_RE = /\b(remote|удал[её]нк\w*|hybrid|onsite|office|офис|full[- ]?time|part[- ]?time|москва|спб|berlin|london|germany|europe|usa)\b/i;
const DATE_LIKE_RE = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/i;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const HASHTAG_LINE_RE = /^#\S+(?:\s+#\S+)*$/u;
const ROLE_WORD_RE = /(?<![\p{L}\p{N}])(senior|middle|junior|lead|principal|staff|head|chief|intern|trainee|engineer|developer|manager|analyst|designer|architect|specialist|consultant|director|recruiter|scientist|product\s+owner|qa|tester|devops|sre|инженер|разработчик|менеджер|специалист|аналитик|директор|архитектор|рекрутер|стажер|стажёр|тестировщик|тимлид|владелец|руководитель|маркетолог|программист)(?![\p{L}\p{N}])/iu;

function headline(lines) {
  const first = lines[0] || '';
  if (first.length <= TITLE_CAP) return first;
  const cut = first.slice(0, TITLE_CAP);
  const space = cut.lastIndexOf(' ');
  return `${space > TITLE_CAP / 3 ? cut.slice(0, space) : cut}…`;
}

function plausibleEmployer(name, fromTitle) {
  const n = name.replace(ZERO_WIDTH_RE, '').trim();
  if (n.length < 2 || n.length > 60) return '';
  if (n.split(/\s+/).length > 4) return '';
  if (/[,:;!?]/.test(n) || /\.$/.test(n)) return '';
  if (LOCATIONISH_RE.test(n) || ANONYMOUS_RE.test(n)) return '';
  if (fromTitle && (DATE_LIKE_RE.test(n) || /\d/.test(n))) return '';
  if (!/\p{Lu}/u.test(n)) return '';
  return n;
}

export function employerName(lines) {
  let m;
  for (const line of lines.slice(0, 40)) {
    if ((m = line.match(EMPLOYER_LABEL_RE))) return plausibleEmployer(m[1].replace(/\s*[|(].*$/, ''), false);
  }
  const first = lines[0] || '';
  const second = lines[1] || '';
  if ((m = first.match(/^.{3,140}?\s+@\s+(.{2,60})$/))) return plausibleEmployer(m[1], true);
  if (!/\|.*\|/.test(first) && (m = first.match(/^.{3,140}?\s+\|\s+([^|]{2,60})$/))) {
    const pipeEmployer = plausibleEmployer(m[1], true);
    const isBareRoleWord = new RegExp(`^${ROLE_WORD_RE.source}$`, ROLE_WORD_RE.flags).test(pipeEmployer);
    if (pipeEmployer && !isBareRoleWord) return pipeEmployer;
  }
  if ((m = second.match(/^(?:в|at)\s+([^—–,(]{2,60}?)\s*(?:[—–]|$)/u))) return plausibleEmployer(m[1], true);
  if (HASHTAG_LINE_RE.test(first) && second) {
    const hashtagEmployer = plausibleEmployer(second, false);
    if (hashtagEmployer && !ROLE_WORD_RE.test(hashtagEmployer)) return hashtagEmployer;
  }
  return '';
}

export function classifyLink(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!host || NON_APPLY_HOSTS.test(host) || SHORTENER_HOSTS.test(host) || FORM_HOSTS.test(host)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return /\/jobs\/view\//.test(path) ? 'board' : null;
  const identifying = [...u.searchParams.keys()].some((k) => !TRACKING_PARAM_RE.test(k));
  if (LOCALE_ROOT_RE.test(path) && !identifying) return null;
  if (LISTING_ROOT_RE.test(path) && !identifying) return null;
  if (!VACANCY_EVIDENCE_RE.test(path) && !identifying) return null;
  return BOARD_HOSTS.test(host) ? 'board' : 'employer';
}

export function applicationLink(hrefs) {
  const seen = new Set();
  const qualified = [];
  for (const href of hrefs) {
    const kind = classifyLink(href);
    if (!kind) continue;
    const key = vacancyKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    qualified.push({ url: href, kind });
  }
  if (qualified.length === 0) return null;
  for (const kind of ['employer', 'board']) {
    if (qualified.filter((q) => q.kind === kind).length > 1) return null;
  }
  return qualified.find((q) => q.kind === 'employer') || qualified[0];
}

function vacancyKey(href) {
  const u = new URL(href);
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM_RE.test(k)).sort();
  return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}?${new URLSearchParams(keep)}`;
}

export function parseChannelPage(html, channel) {
  if (typeof html !== 'string' || !html) return { posts: [], noPreview: false, textPosts: 0 };
  const chunks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  const posts = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (/\bservice_message\b/.test(chunk)) continue;
    const post = chunk.match(/data-post="([^"/]+)\/(\d+)"/);
    if (!post || post[1].toLowerCase() !== channel.toLowerCase()) continue;
    const id = Number(post[2]);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    const textM = chunk.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!textM) continue;
    const lines = textM[1].split(/<br\s*\/?>/i).map((l) => htmlToText(l).replace(ZERO_WIDTH_RE, '')).filter(Boolean);
    const title = headline(lines);
    if (!title) continue;
    const hrefs = [...textM[1].matchAll(/href="([^"]+)"/g)].map((h) => decodeEntities(decodeEntities(h[1])));
    const timeM = chunk.match(/<time datetime="([^"]+)"/);
    const postedAt = timeM ? Date.parse(timeM[1]) : NaN;
    seen.add(id);
    posts.push({
      id,
      url: `https://t.me/${channel}/${id}`,
      title,
      description: lines.join('\n'),
      lines,
      hrefs,
      postedAt: Number.isFinite(postedAt) ? postedAt : undefined,
    });
  }
  const noPreview = posts.length === 0 && /<meta property="og:title" content="Telegram: Contact @/i.test(html);
  const own = Math.max(chunks.length, (html.match(new RegExp(`data-post="${channel}/`, 'gi')) || []).length);
  const withText = (html.match(/tgme_widget_message_text/g) || []).length;
  const service = (html.match(/\bservice_message\b/g) || []).length;
  const textPosts = Math.max(0, Math.min(own, withText) - service);
  return { posts, noPreview, textPosts };
}

export function postToJob(post) {
  const company = employerName(post.lines);
  if (!company) return null;
  if (ANONYMOUS_RE.test(post.lines.slice(0, 3).join('\n'))) return null;
  const link = applicationLink(post.hrefs);
  if (!link) return null;
  let title = post.title;
  if (HASHTAG_LINE_RE.test(post.lines[0] || '')) {
    const companyLower = company.toLowerCase();
    const isLinkLine = (l) => post.hrefs.includes(l) || /^https?:\/\//i.test(l);
    const better = post.lines.slice(1).find((l) => l.toLowerCase() !== companyLower
      && employerName(['', l]).toLowerCase() !== companyLower
      && !HASHTAG_LINE_RE.test(l) && !isLinkLine(l));
    if (!better) return null;
    title = headline([better]);
  }
  const source = `\n\nSource: ${post.url}`;
  return {
    title,
    url: link.url,
    company,
    location: '',
    description: post.description.slice(0, DESCRIPTION_CAP - source.length) + source,
    ...(post.postedAt !== undefined ? { postedAt: post.postedAt } : {}),
  };
}

function pageCount(raw, fallback, cap) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, cap);
}

export default {
  id: 'telegram-channel',

  async fetch(entry, ctx) {
    const channel = String(entry.channel || '').replace(/^@/, '').trim();
    if (!CHANNEL_RE.test(channel)) {
      throw new Error(`telegram-channel: "${entry.name || '?'}" needs a channel handle (5-32 letters, digits or underscores, no @), got ${JSON.stringify(entry.channel)}`);
    }
    const entryPages = pageCount(entry.max_pages, MAX_PAGES_CAP, MAX_PAGES_CAP);
    const maxPages = Math.min(entryPages, ctx.maxPages ?? Infinity);
    const sinceDays = Number(entry.since_days);
    const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SINCE_DAYS;
    const cutoff = Math.max(Date.now() - windowDays * DAY_MS, Number.isFinite(ctx.sinceMs) ? Number(ctx.sinceMs) : 0);
    const label = entry.name || `@${channel}`;

    const jobs = [];
    let before = null;
    let read = 0;
    let reachedCutoff = false;
    let page = 0;
    for (; page < maxPages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      const url = `https://t.me/s/${channel}${before === null ? '' : `?before=${before}`}`;
      let html;
      try {
        html = await fetchTextWithRetry(ctx, url, { redirect: 'manual' });
      } catch (err) {
        if (page === 0 && err?.status >= 300 && err.status < 400) {
          throw new Error(`telegram-channel: @${channel} has no public preview — private channel, preview switched off, or no such channel (t.me answered ${err.status}${err.location ? ` → ${err.location}` : ''}). It cannot be read without an authenticated Telegram integration.`);
        }
        throw err;
      }
      const { posts, noPreview, textPosts } = parseChannelPage(html, channel);
      if (page === 0 && noPreview) {
        throw new Error(`telegram-channel: @${channel} has no public preview (private channel, or preview switched off) — it cannot be read without an authenticated Telegram integration`);
      }
      if (page === 0 && posts.length === 0 && textPosts > 0) {
        throw new Error(`telegram-channel: @${channel} served ${textPosts} text posts but none parsed — t.me markup changed`);
      }
      if (posts.length === 0) break;
      const oldest = Math.min(...posts.map((p) => p.id));
      if (before !== null && oldest >= before) break;
      read += posts.length;
      for (const post of posts) {
        if (post.postedAt !== undefined && post.postedAt < cutoff) { reachedCutoff = true; continue; }
        const job = postToJob(post);
        if (job) jobs.push(job);
      }
      if (reachedCutoff) break;
      before = oldest;
    }
    if (page >= maxPages && !reachedCutoff && maxPages === entryPages) {
      console.error(`⚠️  telegram-channel: ${label} truncated at max_pages=${maxPages} (${read} posts read, none older than since_days=${windowDays} yet) — raise max_pages on this entry for the full window`);
    }
    return jobs;
  },
};
