import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const MAX_PAGES = 150;
const MAX_JOBS = 1500;
const PAGE_DELAY_MS = 150;

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.host.toLowerCase();
    if (host !== 'rheinmetall.com' && !host.endsWith('.rheinmetall.com')) return null;
    if (host === 'rheinmetall.com') u.host = 'www.rheinmetall.com';
    u.protocol = 'https:';
    if (/\/career\/vacancies\/?$/.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
    return `${u.origin}/en/career/vacancies`;
  } catch {
    return null;
  }
}

export function parseVacancies(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const blocks = html.split(/<div class="flex gap-0\.5 group">/).slice(1);
  for (const block of blocks) {
    const link = block.match(/href="(\/[a-z]{2}\/job\/[^"]+\/(\d+))"/);
    if (!link) continue;
    const id = link[2];
    if (seen.has(id)) continue;
    const titleM = block.match(/md:text-xl[^"]*">([\s\S]*?)<\/div>/);
    let title;
    if (titleM) {
      title = clean(titleM[1]);
    } else {
      const slug = link[1].split('/')[3] || '';
      let decoded;
      try { decoded = decodeURIComponent(slug); } catch { decoded = slug; }
      title = clean(decoded.replace(/_/g, ' '));
    }
    if (!title) continue;
    const orgM = block.match(/class="flex flex-wrap mr-6">([\s\S]*?)<\/div>/);
    const org = orgM ? clean(orgM[1]) : '';
    const city = org.includes('|') ? org.split('|').pop().trim() : '';
    seen.add(id);
    out.push({ id, title, url: origin + link[1], location: city });
  }
  return out;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

export default {
  id: 'rheinmetall',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveListUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`rheinmetall: cannot resolve vacancies URL for ${entry.name}`);
    const origin = new URL(listUrl).origin;

    const maxPages = resolveMaxPages(entry);
    const jobs = [];
    const seen = new Set();

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS, ctx);
      const html = await ctx.fetchText(`${listUrl}?page=${page}`, {
        headers: { accept: 'text/html' },
      });
      const rows = parseVacancies(html, origin);
      if (rows.length === 0) {
        if (page === 1) console.warn(`rheinmetall: page 1 returned no vacancy cards for ${entry.name} — markup may have changed`);
        break;
      }

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      if (fresh === 0) break;
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs.slice(0, MAX_JOBS);
  },
};
