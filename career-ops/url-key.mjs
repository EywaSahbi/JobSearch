import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACKING_PARAMS = [
  /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
];

const AGGREGATOR_SUPPLEMENT = [
  'indeed.com',
  'linkedin.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'dice.com',
  'wellfound.com',
  'remoteok.com',
  'jobicy.com',
  'remotive.com',
  'workingnomads.com',
  'himalayas.app',
  'weworkremotely.com',
  'nodesk.co',
  'themuse.com',
  'echojobs.io',
];

const AGGREGATOR_DOMAINS_PATH = process.env.CAREER_OPS_AGGREGATOR_DOMAINS
  || join(dirname(fileURLToPath(import.meta.url)), 'data-static/aggregator-domains.txt');

let aggregatorDomainsCache = null;
function aggregatorDomains() {
  if (aggregatorDomainsCache) return aggregatorDomainsCache;
  const domains = new Set(AGGREGATOR_SUPPLEMENT);
  try {
    for (let line of readFileSync(AGGREGATOR_DOMAINS_PATH, 'utf-8').replace(/\r/g, '').split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const domain = line.split('#')[0].trim().toLowerCase();
      if (domain) domains.add(domain);
    }
  } catch (err) {
    const overridden = Boolean(process.env.CAREER_OPS_AGGREGATOR_DOMAINS);
    if (err?.code !== 'ENOENT' || overridden) {
      console.warn(
        `Warning: could not read aggregator domains from ${AGGREGATOR_DOMAINS_PATH} (${err?.code || err}). `
        + 'Falling back to the built-in supplement; hosts listed only in that file will not be treated as '
        + 'aggregators, so some duplicate rows may stop collapsing.',
      );
    }
  }
  aggregatorDomainsCache = domains;
  return aggregatorDomainsCache;
}

function foldHostname(host) {
  const h = String(host).toLowerCase();
  return h.length > 1 && h.endsWith('.') && !h.endsWith('..') ? h.slice(0, -1) : h;
}

const AGGREGATOR_POSTING_ID = {
  'linkedin.com': (u) => {
    const path = u.pathname.match(/^\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
    if (path) return path[1];
    const current = u.searchParams.get('currentJobId');
    return current && /^\d+$/.test(current) ? current : null;
  },
  'indeed.com': (u) => {
    const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
    return jk && /^[\w-]+$/.test(jk) ? jk : null;
  },
};

function parseAggregator(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  const host = foldHostname(url.hostname);
  let domain = null;
  for (const d of aggregatorDomains()) {
    if (host === d || host.endsWith(`.${d}`)) { domain = d; break; }
  }
  return domain ? { url, domain } : null;
}

export function isAggregatorUrl(raw) {
  return parseAggregator(raw) !== null;
}

export function aggregatorPostingId(raw) {
  const agg = parseAggregator(raw);
  if (!agg) return null;
  const id = AGGREGATOR_POSTING_ID[agg.domain]?.(agg.url) ?? null;
  return id ? { domain: agg.domain, id } : null;
}

export function promoteKnownFragmentIdentity(url) {
  const match = /^#\/jobs?\/([^/?#]+)(?:\?[^#]*)?$/i.exec(url.hash);
  if (!match) return;
  let jobId;
  try { jobId = decodeURIComponent(match[1]); } catch { return; }
  if (!jobId) return;
  if (url.hostname.toLowerCase() === 'app.mokahr.com') {
    url.searchParams.append('mokahr_job_id', jobId);
    return;
  }
  url.searchParams.append('_career_ops_fragment_job_id', jobId);
}

export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';

  u.protocol = 'https:';
  u.hostname = foldHostname(u.hostname);
  promoteKnownFragmentIdentity(u);
  u.hash = '';

  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
  }
  keep.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

export default normalizeUrl;
