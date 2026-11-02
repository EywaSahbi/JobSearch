import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const PAGE_SIZE = 6;
const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 200;
const INTER_PAGE_DELAY_MS = 250;
const PRIMARY_OFFSET_PARAM = 'jobOffset';
const FALLBACK_OFFSET_PARAM = 'offset';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const RESERVED_PAGINATION_KEYS = new Set([PRIMARY_OFFSET_PARAM.toLowerCase(), FALLBACK_OFFSET_PARAM.toLowerCase()]);

function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const searchPath = /\/SearchJobs\b/i.test(u.pathname) ? u.pathname.replace(/\/+$/, '') : '/careers/SearchJobs';
  const extraParams = new URLSearchParams(u.search);
  for (const key of [...extraParams.keys()]) {
    if (RESERVED_PAGINATION_KEYS.has(key.toLowerCase())) extraParams.delete(key);
  }
  return { searchUrl: `${u.origin}${searchPath}`, origin: u.origin, extraParams };
}

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parsePosted(block) {
  const m = block.match(/Posted\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return undefined;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return undefined;
  const ms = Date.UTC(Number(m[3]), mon, Number(m[1]));
  return Number.isNaN(ms) ? undefined : ms;
}

function parseLocation(block) {
  const m =
    block.match(/list-item-location[^>]*>([\s\S]*?)<\/span>/i) ||
    block.match(/class="[^"]*\blocation\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|li)>/i) ||
    block.match(/glyphicon-map-marker[\s\S]{0,80}?>([^<]{2,60})</i) ||
    block.match(/icon-address[^>]*><\/span>([^<]{2,80})</i);
  return m ? clean(m[1]) : '';
}

export function assertParsedSomething(html, url) {
  if (!/\/JobDetail\/[^"'\s]+/i.test(String(html ?? ''))) return;
  throw new Error(
    `avature: ${url} still contains JobDetail links but no article could be parsed — the listing markup changed`,
  );
}

const ARTICLE_PATTERN = /<article class="article article--(?:result|jobs)\b[^"]*"[\s\S]*?<\/article>/;

export function countArticles(htmlText) {
  return (String(htmlText ?? '').match(new RegExp(ARTICLE_PATTERN, 'g')) || []).length;
}

export function parseArticles(htmlText, origin) {
  const out = [];
  const re = new RegExp(ARTICLE_PATTERN, 'g');
  let a;
  while ((a = re.exec(htmlText)) !== null) {
    const block = a[0];
    const urlM =
      block.match(/article__header__text__title[^>]*>\s*<a[^>]*href="([^"]*\/JobDetail\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<a[^>]*class="link"[^>]*href="([^"]*\/JobDetail\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<a[^>]*href="([^"]*\/JobDetail\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!urlM) continue;
    const title = clean(urlM[2]);
    if (!title) continue;
    let url = decodeEntities(urlM[1]);
    if (!/^https?:\/\//i.test(url)) url = origin + (url.startsWith('/') ? url : '/' + url);
    const idM = url.match(/\/JobDetail\/[^/]*\/(\d+)/);
    out.push({
      id: idM ? idM[1] : url,
      title,
      url,
      location: parseLocation(block),
      postedAt: parsePosted(block),
    });
  }
  return out;
}

export default {
  id: 'avature',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === 'avature.net' || host.endsWith('.avature.net')) return { url };
    } catch {
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`avature: cannot resolve origin for ${entry.name}`);
    const maxPages = Math.min(
      HARD_MAX_PAGES,
      Number.isFinite(entry.max_pages) && entry.max_pages > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES,
    );

    const pinned = typeof entry.offset_param === 'string' && entry.offset_param.trim();
    let offsetParam = pinned ? entry.offset_param.trim() : PRIMARY_OFFSET_PARAM;
    let canHeal = !pinned;

    const jobs = [];
    const seen = new Set();

    const getPage = async (param, page) => {
      const usp = new URLSearchParams(cfg.extraParams);
      usp.set(param, String(page * PAGE_SIZE));
      const url = `${cfg.searchUrl}?${usp.toString()}`;
      const htmlText = await ctx.fetchText(url, {
        redirect: 'error',
        headers: { accept: 'text/html' },
      });
      return { url, html: htmlText, articles: parseArticles(htmlText, cfg.origin), cards: countArticles(htmlText) };
    };
    const absorb = (articles) => {
      let fresh = 0;
      for (const art of articles) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        fresh++;
        jobs.push({
          title: art.title,
          url: art.url,
          company: entry.name,
          location: art.location,
          postedAt: art.postedAt,
        });
      }
      return fresh;
    };

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let result = await getPage(offsetParam, page);
      let fresh = absorb(result.articles);

      if (fresh === 0 && canHeal && page === 1) {
        canHeal = false;
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        const altResult = await getPage(FALLBACK_OFFSET_PARAM, page);
        const altFresh = absorb(altResult.articles);
        if (altFresh > 0) {
          offsetParam = FALLBACK_OFFSET_PARAM;
          result = altResult;
          fresh = altFresh;
        }
      }

      if (page === 0 && result.articles.length === 0) assertParsedSomething(result.html, result.url);

      if (fresh === 0) break;
      if (result.cards < PAGE_SIZE) break;
    }
    return jobs;
  },
};
