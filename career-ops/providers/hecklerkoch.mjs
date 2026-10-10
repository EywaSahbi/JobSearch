import { decodeEntities } from './_html-entities.mjs';

const MAX_JOBS = 500;

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'heckler-koch.com' && !host.endsWith('.heckler-koch.com')) return null;
  if (host === 'heckler-koch.com') u.host = 'www.heckler-koch.com';
  u.protocol = 'https:';
  if (/Stellenangebote/i.test(u.pathname)) return `${u.origin}${u.pathname}`;
  return `${u.origin}/de/Karriere/Stellenangebote`;
}

export function parseListing(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="(https:\/\/karriere\.heckler-koch\.com\/jobposting\/([a-z0-9]+))"[\s\S]*?<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    const id = m[2];
    if (seen.has(id)) continue;
    const block = m[0];
    const titleM = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleM ? clean(titleM[1]) : '';
    if (!title) continue;
    seen.add(id);
    out.push({ id, title, url });
  }
  return out;
}

export default {
  id: 'hecklerkoch',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    return resolveListUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`hecklerkoch: cannot resolve vacancy list for ${entry.name}`);
    const html = await ctx.fetchText(listUrl, { headers: { accept: 'text/html' } });
    const rows = parseListing(html);
    const jobs = [];
    for (const row of rows) {
      jobs.push({ title: row.title, url: row.url, company: entry.name, location: '' });
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs;
  },
};
