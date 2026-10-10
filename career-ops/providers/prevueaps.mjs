const PREVUEAPS_HOST_RE = /^[a-z0-9][a-z0-9-]*\.prevueaps\.ca$/;

const DEFAULT_GET_PARAMS = {
  showDate: true,
  showLocation: true,
  showEmploymentType: true,
  showCategory: true,
  showClassification: true,
  showWorkplaceType: true,
  customCategoryTitle: '',
};

function assertPrevueapsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`prevueaps: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`prevueaps: URL must use HTTPS: ${url}`);
  if (!PREVUEAPS_HOST_RE.test(parsed.hostname)) {
    throw new Error(`prevueaps: untrusted hostname "${parsed.hostname}" — must match <tenant>.prevueaps.ca`);
  }
  return url;
}

function resolveOrigin(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawApi = typeof entry.api === 'string' ? entry.api : '';
  const rawCareers = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const raw = (rawApi || rawCareers).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!PREVUEAPS_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}`;
}

export function extractDomainId(html) {
  if (typeof html !== 'string' || !html) return null;

  let m = html.match(/\/core\/jobs\/(\d+)/);
  if (m) return m[1];

  m = html.match(/data-domain-id\s*=\s*["'](\d+)["']/i);
  if (m) return m[1];

  m = html.match(/["']?domainId["']?\s*[:=]\s*["']?(\d+)["']?/i);
  if (m) return m[1];

  m = html.match(/["']?siteId["']?\s*[:=]\s*["']?(\d+)["']?/i);
  if (m) return m[1];

  return null;
}

function buildApiUrl(origin, domainId) {
  const getParams = encodeURIComponent(JSON.stringify(DEFAULT_GET_PARAMS));
  return `${origin}/core/jobs/${domainId}?getParams=${getParams}`;
}

export default {
  id: 'prevueaps',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: `${origin}/jobs/` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`prevueaps: cannot derive tenant origin for ${entry.name}`);
    const jobsPageUrl = `${origin}/jobs/`;
    assertPrevueapsUrl(jobsPageUrl);
    const html = await ctx.fetchText(jobsPageUrl, { redirect: 'error' });
    const domainId = extractDomainId((html));
    if (!domainId) {
      throw new Error(`prevueaps: could not resolve domainId for ${entry.name} from ${jobsPageUrl}`);
    }
    const apiUrl = buildApiUrl(origin, domainId);
    assertPrevueapsUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parsePrevueapsResponse(json, entry.name);
  },
};

export function parsePrevueapsResponse(json, companyName) {
  const jobs = json?.data?.jobs;
  if (!Array.isArray(jobs)) {
    throw new Error(`prevueaps: unexpected response shape for ${companyName} — missing or invalid data.jobs`);
  }
  const out = [];
  for (const j of jobs) {
    if (!j || typeof j.title !== 'string' || !j.title.trim()) continue;

    let url = '';
    const rawUrl = typeof j.jobUrl === 'string' ? j.jobUrl : '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:') url = parsed.href;
      } catch { }
    }
    if (!url) continue;

    const location = (typeof j.jobLocation === 'string' && j.jobLocation.trim())
      ? j.jobLocation.trim()
      : [j.city, j.abbreviation || j.stateName].filter(Boolean).join(', ');

    const descBits = [];
    if (typeof j.employmentType === 'string' && j.employmentType.trim()) descBits.push(j.employmentType.trim());
    if (typeof j.classification === 'string' && j.classification.trim()) descBits.push(j.classification.trim());
    const min = typeof j.minSalary === 'string' ? j.minSalary.trim() : '';
    const max = typeof j.maxSalary === 'string' ? j.maxSalary.trim() : '';
    if (min || max) {
      const range = [min, max].filter(Boolean).join(' - ');
      const frame = typeof j.payTypeFrame === 'string' ? j.payTypeFrame.trim() : '';
      descBits.push([range, frame].filter(Boolean).join(' '));
    }

    const job = {
      title: j.title.trim(),
      url,
      company: companyName,
      location,
    };
    if (descBits.length) job.description = descBits.join(' · ');

    out.push(job);
  }
  return out;
}
