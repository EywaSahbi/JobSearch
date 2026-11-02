const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ORIGIN = 'https://www.amazon.jobs';

function buildQuery(entry, offset) {
  const cfg = entry.amazon && typeof entry.amazon === 'object' ? entry.amazon : {};
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(cfg)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      const name = k.endsWith('[]') ? k : `${k}[]`;
      for (const item of v) params.append(name, String(item));
    } else {
      params.append(k, String(v));
    }
  }
  if (!params.has('base_query')) params.set('base_query', '');
  if (!params.has('loc_query')) params.set('loc_query', '');
  params.set('sort', cfg.sort ? String(cfg.sort) : 'recent');
  params.set('result_limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  return `${ORIGIN}/en/search.json?${params.toString()}`;
}

function toEpochMs(job) {
  const raw = job.posted_date;
  if (!raw || typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw.replace(/\s+/g, ' ').trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function formatLocation(job) {
  const primary = str(job.normalized_location) || str(job.location);
  const cities = primary ? [primary] : [];
  const seen = new Set(cities);
  for (const entry of Array.isArray(job.locations) ? job.locations : []) {
    let loc;
    try {
      loc = typeof entry === 'string' ? JSON.parse(entry) : entry;
    } catch {
      continue;
    }
    const spelled = str(loc?.location);
    const name = str(loc?.normalizedLocation) || spelled;
    if (name && !seen.has(name) && !seen.has(spelled)) cities.push(name);
    for (const s of [name, spelled]) if (s) seen.add(s);
  }
  return cities.join(' · ');
}

export default {
  id: 'amazon',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === 'amazon.jobs' || host.endsWith('.amazon.jobs')) return { url };
    } catch {
    }
    return null;
  },

  async fetch(entry, ctx) {
    const jobs = [];
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = buildQuery(entry, page * PAGE_SIZE);
      const json = (await ctx.fetchJson(url, { redirect: 'error' }));
      const postings = Array.isArray(json?.jobs) ? json.jobs : [];
      if (postings.length === 0) break;

      let fresh = 0;
      for (const j of postings) {
        const path = j.job_path;
        if (!path || typeof path !== 'string') continue;
        const url2 = /^https?:\/\//i.test(path) ? path : ORIGIN + (path.startsWith('/') ? path : '/' + path);
        if (seen.has(url2)) continue;
        seen.add(url2);
        fresh++;
        jobs.push({
          title: (j.title || '').trim(),
          url: url2,
          company: j.company_name || entry.name,
          location: formatLocation(j),
          postedAt: toEpochMs(j),
        });
      }
      if (fresh === 0) break;
      if (postings.length < PAGE_SIZE) break;
    }
    return jobs;
  },
};
