const ALLOWED_HOSTS = new Set(['solid.jobs']);

function assertUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`solidjobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`solidjobs: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`solidjobs: untrusted hostname "${parsed.hostname}" — must be solid.jobs`);
  if (!parsed.pathname.startsWith('/public-api/offers/'))
    throw new Error(`solidjobs: URL path must start with /public-api/offers/: ${url}`);
  return url;
}

export default {
  id: 'solidjobs',

  detect(entry) {
    const url = entry.careers_url || '';
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'solid.jobs' && parsed.pathname.startsWith('/public-api/offers/'))
        return { url };
    } catch {}
    return null;
  },
  
  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (!url) throw new Error('solidjobs: careers_url required');
    assertUrl(url);
    const json = await ctx.fetchJson(url, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`solidjobs: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    const jobs = json.jobs;

    return jobs
      .filter(j => j && typeof j === 'object' && typeof j.url === 'string' && j.url.trim() !== '')
      .map(j => ({
        title: j.title || '',
        url: (j.url || '').trim(),
        company: j.company || entry.name,
        location: Array.isArray(j.locations) ? j.locations.join(', ') : (typeof j.locations === 'string' ? j.locations : ''),
      }));
  },
};
