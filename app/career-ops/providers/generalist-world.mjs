import { htmlToText } from './_html-to-text.mjs';

const SITE_ORIGIN = 'https://generalist.world';
const LIST_URL = `${SITE_ORIGIN}/jobs/`;
const TRUSTED_HOSTS = new Set(['generalist.world', 'www.generalist.world']);

const CARD_SRC = '<a(\\s(?:[^>]*?\\s)?class="(?:[^"]*\\s)?gw-job-card(?:\\s[^"]*)?"[^>]*)>([\\s\\S]*?)<\\/a>';
const CARDS_RE = new RegExp(CARD_SRC, 'g');
const ONE_CARD_RE = new RegExp(CARD_SRC);
const HREF_RE = /\shref="([^"]*)"/;
const REGION_RE = /\sdata-region="([^"]*)"/;
const TITLE_RE = /<div\s(?:[^>]*?\s)?class="(?:[^"]*\s)?gw-job-title(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>/;
const COMPANY_RE = /<div\s(?:[^>]*?\s)?class="(?:[^"]*\s)?gw-job-company(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>/;
const LOCATION_RE = /<span\s(?:[^>]*?\s)?class="(?:[^"]*\s)?gw-location(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/span>/;
const DESCRIPTION_RE = /<p\s(?:[^>]*?\s)?class="(?:[^"]*\s)?gw-job-description(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/p>/;
const BOARD_MARKER_RE = /<[a-zA-Z][^\s>]*\s(?:[^>]*?\s)?(?:class="(?:[^"]*\s)?gw-jobs-section(?:\s[^"]*)?"|data-jobs-container(?=[\s>\/=]))[^>]*>/;
const TAG_START_RE = /<(\/?)([a-zA-Z][^\s/>]*)/y;
const RAW_TEXT_END = new Map([
  ['script', /<\/script(?=[\s/>])[^>]*>/gi],
  ['style', /<\/style(?=[\s/>])[^>]*>/gi],
  ['textarea', /<\/textarea(?=[\s/>])[^>]*>/gi],
]);
const TAG_WHITESPACE = ' \t\n\r\f';
const COMMENT_END_RE = /--!?>/g;

function tagEnd(html, from) {
  let quote = '';
  let afterEquals = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '>') {
      return i + 1;
    } else if (ch === '=') {
      afterEquals = true;
    } else if ((ch === '"' || ch === "'") && afterEquals) {
      quote = ch;
      afterEquals = false;
    } else if (!TAG_WHITESPACE.includes(ch)) {
      afterEquals = false;
    }
  }
  return html.length;
}

function stripNonRendered(html) {
  let out = '';
  let kept = 0;
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    let stop;
    let drop = false;
    if (html.startsWith('<!--', lt)) {
      COMMENT_END_RE.lastIndex = lt + 2;
      const end = COMMENT_END_RE.exec(html);
      stop = end ? end.index + end[0].length : html.length;
      drop = true;
    } else {
      TAG_START_RE.lastIndex = lt;
      const tag = TAG_START_RE.exec(html);
      if (!tag) {
        i = lt + 1;
        continue;
      }
      const closing = tag[1] === '/';
      const name = tag[2].toLowerCase();
      stop = tagEnd(html, TAG_START_RE.lastIndex);
      const rawEnd = closing ? undefined : RAW_TEXT_END.get(name);
      if (rawEnd) {
        rawEnd.lastIndex = stop;
        const end = rawEnd.exec(html);
        stop = end ? end.index + end[0].length : html.length;
        drop = true;
      } else if (name === 'template') {
        if (!closing) {
          if (depth === 0) out += html.slice(kept, lt);
          depth++;
        } else if (depth > 0) {
          depth--;
          if (depth === 0) kept = stop;
        }
      }
    }
    if (drop && depth === 0) {
      out += `${html.slice(kept, lt)} `;
      kept = stop;
    }
    i = stop;
  }
  if (depth === 0) out += html.slice(kept);
  return out;
}

const SLUG_PATH_RE = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._~-]*)\/?$/;

function regionLabel(code) {
  if (typeof code !== 'string') return '';
  const c = code.trim().toLowerCase();
  if (!c) return '';
  return c === 'remote' ? 'Remote' : c.replace(/[-_]+/g, ' ').toUpperCase();
}

export function resolveGeneralistWorldUrl(href) {
  if (typeof href !== 'string') return null;
  let path = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    let parsed;
    try {
      parsed = new URL(path);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname) || parsed.search || parsed.hash) return null;
    path = parsed.pathname;
  }
  const m = SLUG_PATH_RE.exec(path);
  return m ? `${SITE_ORIGIN}/jobs/${m[1]}/` : null;
}

function cardToJob(attrs, inner) {
  const url = resolveGeneralistWorldUrl(HREF_RE.exec(attrs)?.[1]);
  if (!url) return null;
  const title = htmlToText(TITLE_RE.exec(inner)?.[1]);
  if (!title) return null;
  const company = htmlToText(COMPANY_RE.exec(inner)?.[1]);
  if (!company) return null;
  const location = htmlToText(LOCATION_RE.exec(inner)?.[1]) || regionLabel(REGION_RE.exec(attrs)?.[1]);
  const job = { title, url, company, location };
  const description = htmlToText(DESCRIPTION_RE.exec(inner)?.[1]);
  if (description) job.description = description;
  return job;
}

export function normalizeGeneralistWorldCard(cardHtml) {
  if (typeof cardHtml !== 'string') return null;
  const m = ONE_CARD_RE.exec(cardHtml);
  return m ? cardToJob(m[1], m[2]) : null;
}

export function parseGeneralistWorldJobs(html) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const rendered = stripNonRendered(html);
  const jobs = [];
  const seen = new Set();
  let cards = 0;
  for (const m of rendered.matchAll(CARDS_RE)) {
    cards++;
    const job = cardToJob(m[1], m[2]);
    if (!job || seen.has(job.url)) continue;
    seen.add(job.url);
    jobs.push(job);
  }
  if (jobs.length === 0 && cards > 0) {
    throw new Error(
      `generalist-world: ${cards} gw-job-card anchor(s) matched but none carried a usable title, employer and /jobs/{slug}/ link; the card markup likely changed`,
    );
  }
  if (jobs.length === 0 && !BOARD_MARKER_RE.test(rendered)) {
    throw new Error(
      'generalist-world: no gw-job-card anchors and no listing container in the response; the page structure likely changed',
    );
  }
  return jobs;
}

function detectGeneralistWorldEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider === 'generalist-world') return { url: LIST_URL };
  if (entry.provider) return null;

  for (const value of [entry.api, entry.careers_url]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && TRUSTED_HOSTS.has(parsed.hostname)) return { url: LIST_URL };
    } catch {
    }
  }
  return null;
}

export default {
  id: 'generalist-world',

  detect: detectGeneralistWorldEntry,

  async fetch(_entry, ctx) {
    const html = await ctx.fetchText(LIST_URL, { redirect: 'error' });
    return parseGeneralistWorldJobs(html);
  },
};
