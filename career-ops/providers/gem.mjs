import { decodeEntities } from './_html-entities.mjs';
import { countryNameFromIso } from './_country.mjs';

const GEM_API_URL = 'https://jobs.gem.com/api/public/graphql/batch';
const ALLOWED_GEM_HOSTS = new Set(['jobs.gem.com', 'api.gem.com']);

const JOB_BOARD_LIST_QUERY = `query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id
      extId
      title
      locations {
        id
        name
        city
        isoCountry
        isRemote
        extId
        __typename
      }
      job {
        id
        department {
          id
          name
          extId
          __typename
        }
        locationType
        employmentType
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

const JOB_DETAIL_QUERY = `query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    extId
    firstPublishedTsSec
    descriptionHtml
    jobPostSectionHtml {
      introHtml
      outroHtml
    }
    compensationHtml
    __typename
  }
}
`;

function toEpochMsFromSeconds(value) {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

function toEpochMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildJobDescriptionText(posting) {
  const intro = htmlToText(posting?.jobPostSectionHtml?.introHtml);
  const body = htmlToText(posting?.descriptionHtml);
  const outro = htmlToText(posting?.jobPostSectionHtml?.outroHtml);
  const compensation = htmlToText(posting?.compensationHtml);

  const text = [intro, body, outro].filter(Boolean).join('\n\n');
  return compensation ? [text, `Compensation: ${compensation}`].filter(Boolean).join('\n\n') : text;
}

function assertGemUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gem: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`gem: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GEM_HOSTS.has(parsed.hostname))
    throw new Error(`gem: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GEM_HOSTS].join(', ')}`);
  return url;
}

function resolveRestApiUrl(entry) {
  const raw = typeof entry.api === 'string' ? entry.api : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.gem.com') return null;
  if (!/^\/job_board\/v0\/[^/?#]+\/job_posts\/?$/.test(parsed.pathname)) return null;
  return parsed;
}

function resolveBoardId(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'jobs.gem.com') return null;
  const match = parsed.pathname.match(/^\/([^/?#]+)/);
  return match ? match[1] : null;
}

const GEM_POSTING_PATH_RE = /^\/[^/?#]+\/[^/?#]+\/?$/;

function containsWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function formatLocation(loc) {
  const parts = [];
  let place = typeof loc?.name === 'string' ? loc.name.trim() : '';
  const country = countryNameFromIso(loc?.isoCountry);
  if (country && !containsWholeWord(place, country)) place = place ? `${place}, ${country}` : country;
  if (place) parts.push(place);
  if (loc?.isRemote) parts.push('Remote');
  return parts.join(' · ');
}

export default {
  id: 'gem',

  detect(entry) {
    const restApiUrl = resolveRestApiUrl(entry);
    if (restApiUrl) return { url: restApiUrl.href };
    const boardId = resolveBoardId(entry);
    return boardId ? { url: `${GEM_API_URL}?board=${boardId}` } : null;
  },

  async fetch(entry, ctx) {
    const restApiUrl = resolveRestApiUrl(entry);
    if (restApiUrl) {
      assertGemUrl(restApiUrl.href);
      const json = (await ctx.fetchJson(restApiUrl.href, { redirect: 'error' }));
      return parseRestResponse(json, entry.name);
    }
    const boardId = resolveBoardId(entry);
    if (!boardId) throw new Error(`gem: cannot derive board id for ${entry.name}`);
    assertGemUrl(GEM_API_URL);

    const body = JSON.stringify([
      { operationName: 'JobBoardList', variables: { boardId }, query: JOB_BOARD_LIST_QUERY },
    ]);
    const json = (await ctx.fetchJson(GEM_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', batch: 'true' },
      body,
      redirect: 'error',
    }));

    const listResult = json?.[0];
    if (Array.isArray(listResult?.errors) && listResult.errors.length > 0) {
      throw new Error(`gem: JobBoardList failed: ${listResult.errors[0]?.message || 'unknown GraphQL error'}`);
    }
    const postings = listResult?.data?.oatsExternalJobPostings?.jobPostings;
    if (!Array.isArray(postings)) return [];

    const validPostings = postings.filter(p => p.extId && p.title);

    const postedAtByExtId = new Map();
    const descriptionByExtId = new Map();
    if (validPostings.length > 0) {
      try {
        const detailBody = JSON.stringify(
          validPostings.map(p => ({
            operationName: 'ExternalJobPostingQuery',
            variables: { boardId, extId: p.extId },
            query: JOB_DETAIL_QUERY,
          }))
        );
        const detailJson = (await ctx.fetchJson(GEM_API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', batch: 'true' },
          body: detailBody,
          redirect: 'error',
        }));
        if (Array.isArray(detailJson)) {
          for (const entry of detailJson) {
            const posting = entry?.data?.oatsExternalJobPosting;
            if (posting?.extId) {
              postedAtByExtId.set(posting.extId, toEpochMsFromSeconds(posting.firstPublishedTsSec));
              descriptionByExtId.set(posting.extId, buildJobDescriptionText(posting));
            }
          }
        }
      } catch {
      }
    }

    return validPostings.map(p => ({
      title: p.title || '',
      url: `https://jobs.gem.com/${boardId}/${p.extId}`,
      company: entry.name,
      location: Array.isArray(p.locations) ? [...new Set(p.locations.map(formatLocation).filter(Boolean))].join(' · ') : '',
      description: descriptionByExtId.get(p.extId) || '',
      postedAt: postedAtByExtId.get(p.extId),
    }));
  },
};

function extractRestRows(json) {
  if (Array.isArray(json)) return json;
  if (json === null || json === undefined) return [];
  if (typeof json === 'object') {
    if (Array.isArray(json.job_posts)) return json.job_posts;
    if (Object.keys(json).length === 0) return [];
    throw new Error(
      `gem: unsupported REST response envelope — expected an array or {job_posts: [...]}, got an object with keys: ${Object.keys(json).join(', ')}`
    );
  }
  throw new Error(`gem: unsupported REST response envelope — expected an array or {job_posts: [...]}, got ${typeof json}`);
}

export function parseRestResponse(json, companyName) {
  const rows = extractRestRows(json);
  return rows.filter(j => j && typeof j.title === 'string' && j.title.trim() && typeof j.absolute_url === 'string')
    .map(j => {
      let url;
      try {
        const parsed = new URL(j.absolute_url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'jobs.gem.com' || !GEM_POSTING_PATH_RE.test(parsed.pathname)) return null;
        url = parsed.href;
      } catch {
        return null;
      }
      const description = typeof j.content_plain === 'string' && j.content_plain.trim()
        ? j.content_plain.trim()
        : htmlToText(j.content);
      const postedAt = toEpochMs(j.first_published_at);
      return {
        title: j.title.trim(),
        url,
        company: companyName,
        location: formatLocation(j.location),
        ...(description ? { description } : {}),
        ...(postedAt ? { postedAt } : {}),
      };
    }).filter(Boolean);
}
