import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const DEFAULT_HOST = 'builtin.com';
const DEFAULT_MAX_PAGES = 3;
const HARD_MAX_PAGES = 25;
const RETRY_POLICY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

const HOSTS = new Map([
  ['builtin.com', 'builtin.com'],
  ['www.builtin.com', 'builtin.com'],
  ['builtinseattle.com', 'www.builtinseattle.com'],
  ['www.builtinseattle.com', 'www.builtinseattle.com'],
  ['builtinnyc.com', 'www.builtinnyc.com'],
  ['www.builtinnyc.com', 'www.builtinnyc.com'],
  ['builtinsf.com', 'www.builtinsf.com'],
  ['www.builtinsf.com', 'www.builtinsf.com'],
  ['builtinla.com', 'www.builtinla.com'],
  ['www.builtinla.com', 'www.builtinla.com'],
  ['builtinboston.com', 'www.builtinboston.com'],
  ['www.builtinboston.com', 'www.builtinboston.com'],
  ['builtinaustin.com', 'www.builtinaustin.com'],
  ['www.builtinaustin.com', 'www.builtinaustin.com'],
  ['builtinchicago.org', 'www.builtinchicago.org'],
  ['www.builtinchicago.org', 'www.builtinchicago.org'],
  ['builtincolorado.com', 'www.builtincolorado.com'],
  ['www.builtincolorado.com', 'www.builtincolorado.com'],
]);

const GUARD_MIN_ROWS = 5;
const GUARD_MIN_LOCATION = 0.5;

const ITEM = /\{"@type":"ListItem","position":\d+,"name":("(?:[^"\\]|\\.)*"),"url":("(?:[^"\\]|\\.)*")(?:,"description":("(?:[^"\\]|\\.)*"))?\}/g;

const CARD_ANCHOR = /data-id="job-card-title"/g;
const CARD_ID = /data-builtin-track-job-id="(\d+)"/;
const COMPANY_ANCHOR = /<a[^>]+href="\/company\/[^"]*"[^>]*>([\s\S]{0,240}?)<\/a>/g;
const LOCATION_TOOLTIP = /aria-label="Job locations"[^>]*data-bs-title="([^"]*)"/;
const CARD_CAP = 12_000;

const WORKPLACE_MODES = ['Remote or Hybrid', 'Remote', 'Hybrid', 'In-Office'];
const MULTI_LOCATION = /^\d+\s+Locations?$/i;
const SALARY_BAND = /^(\d+(?:\.\d+)?)K(?:-(\d+(?:\.\d+)?)K)?\s+Annually$/i;

export function resolveHost(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HOST;
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h === '') return DEFAULT_HOST;
  if (h.includes('/')) {
    try { h = new URL(h.includes('://') ? h : `https://${h}`).hostname.toLowerCase(); } catch { return null; }
  }
  return HOSTS.get(h) ?? null;
}

function assertHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`builtin: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`builtin: URL must use HTTPS: ${url}`);
  const host = parsed.hostname.toLowerCase();
  if (HOSTS.get(host) !== host) {
    throw new Error(`builtin: untrusted hostname "${parsed.hostname}" — must be one of ${[...new Set(HOSTS.values())].join(', ')}`);
  }
  return url;
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fieldAfterIcon(seg, icon) {
  const at = seg.indexOf(icon);
  if (at === -1) return '';
  const window = seg.slice(at, at + 600);
  for (const m of window.matchAll(/>([^<>]+)</g)) {
    const t = stripTags(m[1]);
    if (t) return t;
  }
  return '';
}

export function parsePostedAt(text, now = Date.now()) {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(/^reposted\s+/i, '').trim();
  if (/^today$/i.test(t)) return now;
  if (/^yesterday$/i.test(t)) return now - 86_400_000;
  const m = /^(\d+|an?)\+?\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(t);
  if (!m) return undefined;
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  const ms = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 }[unit];
  return ms ? now - n * ms : undefined;
}

export function parseSalary(text) {
  if (typeof text !== 'string') return undefined;
  const m = SALARY_BAND.exec(text.trim());
  if (!m) return undefined;
  const min = Math.round(Number(m[1]) * 1000);
  const max = m[2] === undefined ? min : Math.round(Number(m[2]) * 1000);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) return undefined;
  return { min, max };
}

export function composeLocation(mode, places) {
  const list = (places || []).filter(Boolean);
  if (list.length === 0) {
    return /remote/i.test(mode) ? mode : '';
  }
  return [mode, ...list].filter(Boolean).join(' · ');
}

export function parseCards(html, now = Date.now()) {
  const out = new Map();
  if (typeof html !== 'string') return out;

  const starts = [];
  CARD_ANCHOR.lastIndex = 0;
  for (const m of html.matchAll(CARD_ANCHOR)) starts.push((m.index));

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = Math.min(starts[i + 1] ?? html.length, start + CARD_CAP);
    const seg = html.slice(start, end);

    const idm = CARD_ID.exec(seg);
    if (!idm) continue;
    const id = idm[1];

    const preFrom = i === 0 ? Math.max(0, start - 2500) : starts[i - 1];
    const pre = html.slice(preFrom, start);
    let company = '';
    COMPANY_ANCHOR.lastIndex = 0;
    for (const cm of pre.matchAll(COMPANY_ANCHOR)) company = stripTags(cm[1]);

    const modeRaw = fieldAfterIcon(seg, 'fa-house-building');
    const mode = WORKPLACE_MODES.find((w) => w.toLowerCase() === modeRaw.toLowerCase()) ?? '';

    const locRaw = fieldAfterIcon(seg, 'fa-location-dot');
    let places = [];
    if (locRaw && !MULTI_LOCATION.test(locRaw)) {
      places = [locRaw];
    } else {
      const tip = LOCATION_TOOLTIP.exec(seg);
      if (tip) {
        places = decodeEntities(tip[1])
          .split(/<\/div>|<br\s*\/?>/i)
          .map(stripTags)
          .filter(Boolean);
      }
    }

    out.set(id, {
      company,
      location: composeLocation(mode, places),
      salary: parseSalary(fieldAfterIcon(seg, 'fa-sack-dollar')),
      postedAt: parsePostedAt(fieldAfterIcon(seg, 'fa-clock'), now),
    });
  }
  return out;
}

function jobIdFromUrl(url) {
  const m = /\/(\d+)(?:[/?#]|$)/.exec(String(url));
  return m ? m[1] : '';
}

export function parseListPage(html, now = Date.now()) {
  const jobs = [];
  if (typeof html !== 'string') return jobs;
  const cards = parseCards(html, now);
  for (const m of html.matchAll(ITEM)) {
    let title, url, description = '';
    try {
      title = JSON.parse(m[1]);
      url = JSON.parse(m[2]);
      if (m[3]) description = JSON.parse(m[3]);
    } catch {
      continue;
    }
    if (!title || !url) continue;
    const job = { title, url, company: '', location: '', description };
    const enrich = cards.get(jobIdFromUrl(url));
    if (enrich) {
      job.company = enrich.company || '';
      job.location = enrich.location || '';
      if (enrich.salary) job.salary = enrich.salary;
      if (enrich.postedAt !== undefined) job.postedAt = enrich.postedAt;
    }
    jobs.push(job);
  }
  return jobs;
}

export function readConfig(entry) {
  const nested = entry && typeof entry.builtin === 'object' && entry.builtin ? entry.builtin : {};
  const arr = (key) => {
    const nv = nested[key];
    if (Array.isArray(nv) && nv.length) return nv.map(String);
    const fv = entry?.[key];
    if (Array.isArray(fv) && fv.length) return fv.map(String);
    return [];
  };
  const rawMax = nested.max_pages ?? entry?.max_pages;
  const maxPages = Math.min(
    HARD_MAX_PAGES,
    Math.max(1, Number.isFinite(rawMax) ? Math.floor(rawMax) : DEFAULT_MAX_PAGES),
  );
  const host = resolveHost(nested.host ?? entry?.host);
  const rawScope = String(nested.scope ?? entry?.scope ?? '').trim();
  const scope = /^[a-z0-9-]+$/i.test(rawScope) ? rawScope.toLowerCase() : '';
  if (rawScope && !scope) {
    console.error(`⚠️  builtin: ignoring invalid scope ${JSON.stringify(rawScope)} — must be a plain slug like "remote"`);
  }
  return { queries: arr('queries'), categories: arr('categories'), maxPages, host, scope };
}

function effectiveMaxPages(entryMax, ctx) {
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(entryMax, Math.floor(hint)) : entryMax;
}

export default {
  id: 'builtin',

  async fetch(entry, ctx) {
    const { queries, categories, maxPages: entryMax, host, scope } = readConfig(entry);
    const maxPages = effectiveMaxPages(entryMax, ctx);
    const label = entry?.name ?? 'entry';

    if (host === null) {
      const raw = entry?.builtin?.host ?? entry?.host;
      console.error(`⚠️  builtin: ${label} has host ${JSON.stringify(raw)}, which is not a known Built In market — skipping (allowed: ${[...new Set(HOSTS.values())].join(', ')})`);
      return [];
    }

    const prefix = scope ? `/jobs/${scope}` : '/jobs';
    const bases = [
      ...queries.map((q) => `${prefix}?search=${encodeURIComponent(q)}`),
      ...categories.map((c) => `${prefix}/${encodeURIComponent(c)}`),
    ];

    if (bases.length === 0) {
      console.error(`⚠️  builtin: ${label} has no queries: or categories: — nothing to scan`);
      return [];
    }

    const seen = new Set();
    const out = [];
    let guardRows = 0, guardCards = 0, guardLocated = 0;

    for (const base of bases) {
      const sep = base.includes('?') ? '&' : '?';
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://${host}${base}${sep}page=${page}`;
        assertHost(url);
        let html;
        try {
          html = (await fetchTextWithRetry(
            (ctx),
            url,
            { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT } },
            RETRY_POLICY,
          ));
        } catch {
          break;
        }
        const jobs = parseListPage(html);
        guardRows += jobs.length;
        for (const j of jobs) {
          if (j.company || j.location) guardCards++;
          if (j.location) guardLocated++;
        }
        let added = 0;
        for (const j of jobs) {
          if (seen.has(j.url)) continue;
          seen.add(j.url);
          added++;
          out.push(j);
        }
        if (jobs.length === 0 || added === 0) break;
      }
    }

    if (guardRows >= GUARD_MIN_ROWS) {
      if (guardCards === 0) {
        console.error(`⚠️  builtin: ${label} parsed ${guardRows} rows but ZERO job cards — card markup changed. location_filter, salary_filter, the blacklist gate and posting-age are INERT for this entry until the parser is fixed.`);
      } else if (guardCards >= GUARD_MIN_ROWS && guardLocated / guardCards < GUARD_MIN_LOCATION) {
        console.error(`⚠️  builtin: ${label} resolved a location for only ${guardLocated}/${guardCards} cards — location markup may have changed; off-policy rows will pass location_filter.`);
      }
    }

    return out;
  },
};
