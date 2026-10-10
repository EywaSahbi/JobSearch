const FEED_URL = 'https://jobicy.com/api/v2/remote-jobs?count=50';

export default {
  id: 'jobicy',

  detect(entry) {
    return entry?.provider === 'jobicy' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const json = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`jobicy: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return parseJobicyResponse(json, entry.name || 'Jobicy');
  },
};

export function parseJobicyResponse(json, defaultCompany = 'Jobicy') {
  if (!json || !Array.isArray(json.jobs)) return [];

  const toEpochMs = (value) => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return json.jobs
    .map(j => {
      if (!j || typeof j !== 'object') return null;

      const title = typeof j.jobTitle === 'string' ? j.jobTitle.trim() : '';
      if (!title) return null;

      const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
      let url = null;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && (parsed.hostname === 'jobicy.com' || parsed.hostname === 'www.jobicy.com')) {
          url = parsed.href;
        }
      } catch {
      }
      if (!url) return null;

      const company = typeof j.companyName === 'string' && j.companyName.trim() ? j.companyName.trim() : defaultCompany;
      const location = typeof j.jobGeo === 'string' ? j.jobGeo.trim() : '';
      const postedAt = toEpochMs(j.pubDate);

      return {
        title,
        url,
        company,
        location,
        postedAt,
      };
    })
    .filter(j => j !== null);
}