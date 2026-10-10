const FEED_URL = 'https://remoteok.com/api';

export default {
  id: 'remoteok',

  async fetch(entry, ctx) {
    const data = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!Array.isArray(data)) {
      throw new Error(`remoteok: unexpected API response — expected a JSON array, got ${data === null ? 'null' : typeof data}`);
    }

    return data
      .filter(j => j && typeof j === 'object'
        && typeof j.position === 'string' && j.position.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        title: j.position.trim(),
        url: j.url.trim(),
        company: typeof j.company === 'string' && j.company.trim() ? j.company.trim() : (entry.name || 'RemoteOK'),
        location: typeof j.location === 'string' ? j.location.trim() : '',
      }));
  },
};
