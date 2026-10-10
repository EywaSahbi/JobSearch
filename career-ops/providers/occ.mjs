import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.occ.com.mx';
const DEFAULT_MAX_PAGES = 3;
const HARD_PAGE_CAP = 10;

const INTER_REQUEST_DELAY_MS = 750;

function text(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildSearchUrl(query, state, page) {
  const q = slugify(query);
  const kw = page > 1 ? `de-${q}-pagina-${page}` : `de-${q}`;
  const st = state ? `${slugify(state)}/` : '';
  return `${ORIGIN}/empleos/${kw}/${st ? 'en-' + st : ''}`;
}

export function isEmptyResultPage(html) {
  const plain = text(html).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /no hay empleos que coincidan/i.test(plain);
}

export function parseCards(html) {
  const out = [];
  const chunks = String(html).split('class="card-job-offer');
  for (const chunk of chunks.slice(1)) {
    const idM = chunk.match(/data-id='(\d+)'/);
    if (!idM) continue;
    const id = idM[1];

    const titleM = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleM ? text(titleM[1]) : '';
    if (!title) continue;

    const compM = chunk.match(/h-\[21px\][^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/);
    const company = compM ? text(compM[1]) : '';

    const locM = chunk.match(/no-alter-loc-text[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    const location = locM ? text(locM[1]) : '';

    out.push({
      id,
      title,
      url: `${ORIGIN}/empleo/oferta/${id}/`,
      company: /^empresa confidencial$/i.test(company) ? '?' : company,
      location,
    });
  }
  return out;
}

export default {
  id: 'occ',

  async fetch(entry, ctx) {
    const queries = Array.isArray(entry.queries)
      ? entry.queries.map((q) => String(q).trim()).filter(Boolean)
      : [];
    if (!queries.length) {
      throw new Error(
        `occ: entry "${entry.name || 'OCC'}" requires a non-empty queries: [...] list `
        + '(e.g. queries: ["automatizacion", "robotica"]) — OCC is a keyword-search '
        + 'board and has no default listing to scan.',
      );
    }

    const states = Array.isArray(entry.states) && entry.states.length
      ? entry.states : [null];

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const entryMaxPages = Math.min(
      Number.isInteger(entry.max_pages) && entry.max_pages > 0 ? entry.max_pages : DEFAULT_MAX_PAGES,
      HARD_PAGE_CAP,
    );
    const maxPages = probing ? Math.min(entryMaxPages, ctx.maxPages) : entryMaxPages;

    const seen = new Set();
    const jobs = [];
    const errors = [];
    let succeeded = 0;

    for (const query of queries) {
      for (const state of states) {
        let answered = false;
        for (let page = 1; page <= maxPages; page++) {
          await sleep(INTER_REQUEST_DELAY_MS, ctx);

          const url = buildSearchUrl(query, state, page);
          let html;
          try {
            html = await fetchTextWithRetry(ctx, url, {
              headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT },
              redirect: 'error',
            }, probing ? { retries: 0 } : {});
            answered = true;
          } catch (err) {
            if (probing) throw err;
            if (page === 1) errors.push(`"${query}"${state ? `/${state}` : ''}: ${(err && err.message) || err}`);
            break;
          }

          const cards = parseCards(html);
          if (!cards.length) {
            if (page === 1 && !isEmptyResultPage(html)) {
              answered = false;
              errors.push(`"${query}"${state ? `/${state}` : ''}: page 1 parsed to zero cards and is not OCC's empty-result page (challenge or markup change) — ${url}`);
            }
            break;
          }

          let fresh = 0;
          for (const c of cards) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            fresh++;
            jobs.push({
              title: c.title,
              url: c.url,
              company: c.company || '?',
              location: c.location,
            });
          }
          if (fresh === 0) break;
        }
        if (answered) succeeded++;
      }
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`occ: all ${errors.length} search request(s) failed — ${errors[0]}`);
    }

    return jobs;
  },
};
