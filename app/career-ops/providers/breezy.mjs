const BREEZY_HOST_RE = /^[a-z0-9][a-z0-9-]*\.breezy\.hr$/;

function assertBreezyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`breezy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`breezy: URL must use HTTPS: ${url}`);
  if (!BREEZY_HOST_RE.test(parsed.hostname)) {
    throw new Error(`breezy: untrusted hostname "${parsed.hostname}" — must match <tenant>.breezy.hr`);
  }
  return url;
}

function resolveOrigin(entry) {
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
  if (!BREEZY_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}`;
}

export default {
  id: 'breezy',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: `${origin}/json` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`breezy: cannot derive API URL for ${entry.name}`);
    const apiUrl = `${origin}/json`;
    assertBreezyUrl(apiUrl);
    const json = (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    return parseBreezyResponse(json, entry.name);
  },
};

function containsWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function withCountry(name, country) {
  const c = typeof country === 'string' ? country.trim() : '';
  return c && !containsWholeWord(name, c) ? `${name}, ${c}` : name;
}

export function parseBreezyResponse(json, companyName) {
  const rows = Array.isArray(json) ? json : [];
  const out = [];
  for (const j of rows) {
    if (!j || !j.name) continue;

    let url = '';
    const rawUrl = typeof j.url === 'string' ? j.url : '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:') url = parsed.href;
      } catch { }
    }
    if (!url) continue;

    const loc = j.location || {};
    const remote = loc.is_remote ? 'Remote' : '';
    const assembled = [loc.city, loc.state, loc.country?.name].filter(Boolean).join(', ');
    const base = (typeof loc.name === 'string' && loc.name.trim())
      ? withCountry(loc.name.trim(), loc.country?.name)
      : assembled;
    const location = remote && !/remote/i.test(base)
      ? [base, remote].filter(Boolean).join(', ')
      : base;

    const job = {
      title: String(j.name),
      url,
      company: companyName,
      location,
    };

    const ts = Date.parse(j.published_date);
    if (!Number.isNaN(ts)) job.postedAt = ts;

    out.push(job);
  }
  return out;
}
