import { fetchJsonWithRetry } from './_http.mjs';

const API_URL = 'https://api.redroverk12.com/graphql';
const REDROVER_HOST = 'jobs.redroverk12.com';

const QUERY = `query GetJobPostings($search: JobPostingSearchInput!) {
  jobSeekerSiteUnauthenticated {
    jobPostingSearch(search: $search) {
      results {
        id
        name
        organizationName
        location { name }
        activePublicOnDateUtc
        closedOnDateUtc
        allowsRemote
      }
      hasMoreData
    }
  }
}`;

function resolveTarget(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== REDROVER_HOST) return null;
  const orgId = (parsed.pathname.match(/^\/org\/(\d+)(?:\/|$)/) || [])[1];
  return orgId ? { origin: `https://${REDROVER_HOST}`, orgId } : null;
}

export default {
  id: 'redrover',

  detect(entry) {
    const t = resolveTarget(entry);
    return t ? { url: `${t.origin}/org/${t.orgId}` } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTarget(entry);
    if (!t) throw new Error(`redrover: cannot derive org id for ${entry.name} (need an https://jobs.redroverk12.com/org/<id> careers_url)`);
    const json = await fetchJsonWithRetry(ctx, API_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: t.origin },
      body: JSON.stringify({
        operationName: 'GetJobPostings',
        variables: { search: { orgId: t.orgId, searchTerm: '', locationIds: [], jobPostingCategoryIds: [] } },
        query: QUERY,
      }),
    });
    return parseRedRoverResponse(json, entry.name, t.origin, t.orgId);
  },
};

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseRedRoverResponse(json, companyName, origin, orgId) {
  if (json == null || typeof json !== 'object') return [];
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(`redrover: API error: ${json.errors[0]?.message || 'unknown GraphQL error'}`);
  }
  const site = json.data?.jobSeekerSiteUnauthenticated;
  if (site == null) return [];
  const search = site.jobPostingSearch;
  if (search == null || typeof search !== 'object') {
    throw new Error(`redrover: unexpected response shape (jobSeekerSiteUnauthenticated keys: ${Object.keys(site).join(', ') || 'none'})`);
  }
  if (search.hasMoreData) throw new Error('redrover: more postings than one response holds; paging is not supported');
  const rows = search.results;
  if (!Array.isArray(rows)) return [];

  const jobs = [];
  for (const j of rows) {
    const id = String(j?.id ?? '').trim();
    const title = String(j?.name ?? '').trim();
    if (!/^\d+$/.test(id) || !title) continue;
    if (!j.activePublicOnDateUtc || j.closedOnDateUtc) continue;
    const where = [j.location?.name, j.organizationName].filter(Boolean).join(' - ');
    const job = {
      title,
      url: `${origin}/org/${orgId}/opening/${id}`,
      company: companyName,
      location: j.allowsRemote ? `${where} (Remote)` : where,
    };
    const postedAt = toEpochMs(j.activePublicOnDateUtc);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}
