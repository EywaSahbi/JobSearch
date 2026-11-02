import { decodeEntities } from './_html-entities.mjs';

const BASE = 'https://www.3ds.com/apisearch/card_search_api';
const REFINES = ['f/card_content_type/career', 'f/card_content_categories_facet/cards language/en'];
const PAGE_SIZE = 10;
const MAX_PAGES = 60;
const MAX_JOBS = 1000;

export function buildUrl(start) {
  const p = new URLSearchParams();
  p.set('lang', 'en');
  for (const r of REFINES) p.append('r', r);
  p.set('start', String(start));
  return `${BASE}?${p.toString()}`;
}

function metaMap(hitXml) {
  const map = new Map();
  const re = /<Meta name="([^"]+)"[^>]*>\s*<MetaString[^>]*name="value"[^>]*>([\s\S]*?)<\/MetaString>/g;
  let m;
  while ((m = re.exec(hitXml)) !== null) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

const LOC_LABELS = [
  'Category', 'Type', 'Country', 'City', 'Products', 'Year',
  'Categoría', 'Categoria', 'Tipo', 'País', 'Pais', 'Ciudad', 'Productos', 'Año', 'Ano', 'Área', 'Area',
  'Catégorie', 'Pays', 'Ville', 'Produits', 'Année', 'Annee',
];
const CITY_LABELS = new Set(['City', 'Ciudad', 'Ville']);
const COUNTRY_LABELS = new Set(['Country', 'País', 'Pais', 'Pays']);
const LABEL_RE = new RegExp('(^|\\s)(' + LOC_LABELS.join('|') + ')\\/', 'g');

function parseCategories(categories) {
  const marks = [];
  let m;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(categories)) !== null) {
    marks.push({ label: m[2], keyStart: m.index + m[1].length, valStart: m.index + m[0].length });
  }
  let city = '';
  let country = '';
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].keyStart : categories.length;
    const value = decodeEntities(categories.slice(marks[i].valStart, end)).trim();
    if (!city && CITY_LABELS.has(marks[i].label)) city = value;
    else if (!country && COUNTRY_LABELS.has(marks[i].label)) country = value;
  }
  return { city, country };
}

function toEpochMs(ts) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec((ts || '').trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseHits(xml, entryName) {
  const hits = typeof xml === 'string' ? xml.match(/<Hit\b[\s\S]*?<\/Hit>/g) : null;
  if (!hits) return [];

  const byId = new Map();
  for (const hit of hits) {
    const meta = metaMap(hit);
    const title = decodeEntities((meta.get('content_title') || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const url = decodeEntities((meta.get('content_cta_1_url') || '').trim());
    if (!title || !url) continue;

    let host;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (host !== '3ds.com' && !host.endsWith('.3ds.com')) continue;

    const { city, country } = parseCategories(meta.get('content_categories') || '');
    const postedAt = toEpochMs(meta.get('content_start_datetime') || meta.get('card_update_timestamp') || '');
    const id = (meta.get('card_id') || '').trim() || url;
    if (byId.has(id)) continue;

    const job = { title, url, company: entryName || 'Dassault Systèmes', location: city || country, _id: id };
    if (postedAt !== undefined) job.postedAt = postedAt;
    byId.set(id, job);
  }
  return [...byId.values()];
}

export default {
  id: 'dassault',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === '3ds.com' || host.endsWith('.3ds.com')) return { url };
    } catch {
    }
    return null;
  },

  async fetch(entry, ctx) {
    const jobs = [];
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const xml = await ctx.fetchText(buildUrl(page * PAGE_SIZE), {
        redirect: 'error',
        headers: { accept: 'application/xml, text/xml, */*' },
      });
      const parsed = parseHits(xml, entry.name);
      if (parsed.length === 0) break;

      let fresh = 0;
      for (const job of parsed) {
        if (seen.has(job._id)) continue;
        seen.add(job._id);
        fresh++;
        const { _id, ...clean } = job;
        jobs.push(clean);
      }
      if (fresh === 0) break;
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs;
  },
};
