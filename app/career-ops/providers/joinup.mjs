function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const BROWSE_URL = 'https://joinup.ch/browse/jobs';

export default {
  id: 'joinup',

  detect(entry) {
    let host;
    try { host = new URL(entry.careers_url || '').hostname; } catch { return null; }
    return /(^|\.)joinup\.ch$/i.test(host) ? { url: BROWSE_URL } : null;
  },

  async fetch(entry, ctx) {
    const html = await ctx.fetchText(BROWSE_URL, { redirect: 'error' });
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`joinup: ${entry.name} page is missing __NEXT_DATA__ (structure changed?)`);
    let hits = [];
    try {
      const data = JSON.parse(m[1]);
      const ir = data?.props?.pageProps?.serverState?.initialResults?.jobs?.results;
      hits = Array.isArray(ir) && ir[0]?.hits ? ir[0].hits : [];
    } catch (err) {
      throw new Error(`joinup: ${entry.name} failed to parse __NEXT_DATA__ — ${err.message}`);
    }
    return hits
      .filter(h => h && h.slug && (h.title || h.headline))
      .map(h => ({
        title: h.title || h.headline || '',
        url: `https://joinup.ch/job/${h.slug}`,
        company: h.startup || entry.name || '',
        location: typeof h.location === 'string' ? h.location
          : (h.location?.name || h.location?.city || ''),
        postedAt: toEpochMs(h.created),
      }));
  },
};
