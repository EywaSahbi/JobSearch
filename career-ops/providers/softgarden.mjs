import { decodeEntities } from './_html-entities.mjs';

const MAX_JOBS = 1000;

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function resolveWidgetUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'softgarden.io' && !host.endsWith('.softgarden.io')) return null;
  if (/\/widgets\/jobs\/?$/.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  const lang = (u.pathname.match(/^\/([a-z]{2})(\/|$)/) || [])[1] || 'de';
  return `${u.origin}/${lang}/widgets/jobs`;
}

export function parseSoftgardenDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  let a, b, year;
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  const dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (slash) {
    [, a, b, year] = slash;
  } else if (dot) {
    [, b, a, year] = dot;
  } else {
    return undefined;
  }
  const month = Number(a);
  const day = Number(b);
  let y = Number(year);
  if (y < 100) y += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(y, month - 1, day);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseWidget(html, widgetUrl) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const blocks = html.split(/<div class="matchElement" id="job_id_/).slice(1);
  for (const block of blocks) {
    const id = (block.match(/^(\d+)"/) || [])[1];
    if (!id || seen.has(id)) continue;
    const linkM = block.match(/<a href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const title = clean(linkM[2]);
    if (!title) continue;
    let url;
    try {
      url = new URL(decodeEntities(linkM[1]), widgetUrl).href;
    } catch {
      continue;
    }
    const cities = [];
    const cityRe = /class="location-view-item"[^>]*>([\s\S]*?)<\/span>/g;
    let cm;
    while ((cm = cityRe.exec(block)) !== null) {
      const c = clean(cm[1]);
      if (c && !cities.includes(c)) cities.push(c);
    }
    const dateM = block.match(/class="matchValue date"[^>]*>([\s\S]*?)<\/div>/);
    seen.add(id);
    out.push({
      id,
      title,
      url,
      location: cities.join(' / '),
      postedAt: parseSoftgardenDate(dateM ? clean(dateM[1]) : undefined),
    });
  }
  return out;
}

export default {
  id: 'softgarden',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveWidgetUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const widgetUrl = resolveWidgetUrl(entry);
    if (!widgetUrl) throw new Error(`softgarden: cannot resolve widget URL for ${entry.name}`);

    const html = await ctx.fetchText(widgetUrl, { headers: { accept: 'text/html' } });
    const rows = parseWidget(html, widgetUrl);
    const jobs = [];
    for (const row of rows) {
      const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
      if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
      jobs.push(job);
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs;
  },
};
