const FEED_URL = 'https://www.workingnomads.com/api/exposed_jobs/';

export default {
  id: 'workingnomads',

  async fetch(entry, ctx) {
    const data = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!Array.isArray(data)) {
      throw new Error(`workingnomads: unexpected API response — expected a JSON array, got ${data === null ? 'null' : typeof data}`);
    }

    return data
      .filter(j => j && typeof j === 'object'
        && typeof j.title === 'string' && j.title.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        title: j.title.trim(),
        url: j.url.trim(),
        company: typeof j.company_name === 'string' && j.company_name.trim() ? j.company_name.trim() : (entry.name || 'Working Nomads'),
        location: typeof j.location === 'string' ? j.location.trim() : '',
      }));
  },
};
