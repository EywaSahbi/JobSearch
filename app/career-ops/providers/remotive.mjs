const FEED_URL = 'https://remotive.com/api/remote-jobs';

export default {
  id: 'remotive',

  async fetch(entry, ctx) {
    const json = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`remotive: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return json.jobs
      .filter(j => j && typeof j === 'object'
        && typeof j.title === 'string' && j.title.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        title: j.title.trim(),
        url: j.url.trim(),
        company: typeof j.company_name === 'string' && j.company_name.trim() ? j.company_name.trim() : (entry.name || 'Remotive'),
        location: typeof j.candidate_required_location === 'string' ? j.candidate_required_location.trim() : '',
      }));
  },
};
