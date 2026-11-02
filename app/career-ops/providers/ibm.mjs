const API_URL = 'https://www-api.ibm.com/search/api/v2';
const PAGE_SIZE = 30;
const MAX_RECORDS = 600;

export function buildPostFilter(cfg) {
  const must = [];
  const categories = Array.isArray(cfg.categories)
    ? cfg.categories.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
    : [];
  if (categories.length) {
    must.push({ bool: { should: categories.map(c => ({ term: { field_keyword_08: c } })) } });
  }
  const country = typeof cfg.country === 'string' ? cfg.country.trim() : '';
  if (country) must.push({ term: { field_keyword_05: country } });
  return { bool: { must } };
}

export function parseIbmResponse(json) {
  const hits = json && json.hits && Array.isArray(json.hits.hits) ? json.hits.hits : null;
  if (!hits) {
    throw new Error(`ibm: unexpected API response — expected hits.hits[], got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
  }

  const out = [];
  for (const h of hits) {
    const s = (h && h._source) || {};
    if (typeof s.title !== 'string' || s.title.trim() === '') continue;
    if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url.trim())) continue;
    const loc = typeof s.field_keyword_19 === 'string' ? s.field_keyword_19.trim() : '';
    const mode = typeof s.field_keyword_17 === 'string' ? s.field_keyword_17.trim() : '';
    out.push({
      title: s.title.trim(),
      url: s.url.trim(),
      company: 'IBM',
      location: [loc, mode].filter(Boolean).join(' · '),
    });
  }
  return out;
}

export default {
  id: 'ibm',

  async fetch(entry, ctx) {
    const postFilter = buildPostFilter(entry.ibm || {});
    const out = [];

    for (let from = 0; from < MAX_RECORDS; from += PAGE_SIZE) {
      const body = {
        appId: 'careers',
        scopes: ['careers2'],
        query: { bool: { must: [] } },
        post_filter: postFilter,
        size: PAGE_SIZE,
        from,
        sort: [{ _score: 'desc' }, { pageviews: 'desc' }],
        lang: 'zz',
        localeSelector: {},
        sm: { query: '', lang: 'zz' },
        _source: ['_id', 'title', 'url', 'description', 'language',
          'field_keyword_05', 'field_keyword_08', 'field_keyword_17',
          'field_keyword_18', 'field_keyword_19'],
      };

      const json = await ctx.fetchJson(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
      });

      out.push(...parseIbmResponse(json));

      if (json.hits.hits.length < PAGE_SIZE) break;
    }

    return out;
  },
};
