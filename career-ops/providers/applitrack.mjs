import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const APPLITRACK_HOSTS = new Set(['www.applitrack.com', 'applitrack.com']);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function resolveSlug(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !APPLITRACK_HOSTS.has(parsed.hostname)) return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  return SLUG_RE.test(slug) ? slug.toLowerCase() : null;
}

const baseFor = (slug) => `https://www.applitrack.com/${slug}/onlineapp`;

export default {
  id: 'applitrack',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `${baseFor(slug)}/jobpostings/Output.asp?all=1` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`applitrack: cannot derive district slug for ${entry.name} (need an https://www.applitrack.com/<slug>/... careers_url)`);
    const base = baseFor(slug);
    const body = await fetchTextWithRetry(ctx, `${base}/jobpostings/Output.asp?all=1`, { redirect: 'error' });
    const defaultLocation = typeof entry.default_location === 'string' ? entry.default_location : '';
    return parseApplitrackOutput(body, entry.name, base, defaultLocation);
  },
};

const text = (s) =>
  decodeEntities(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/�/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function toEpochMs(value) {
  const m = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[3]), Number(m[1]), Number(m[2])];
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return ms;
}

export function parseApplitrackOutput(body, companyName, base, defaultLocation = '') {
  if (typeof body !== 'string' || !body.trim()) return [];
  if (!body.includes('function applyFor')) {
    throw new Error('applitrack: response is not an AppliTrack Output.asp script (no applyFor prelude)');
  }
  const html = body.replace(/\\'/g, "'").replace(/\\"/g, '"');
  const cityName = defaultLocation.split(',')[0].trim().toLowerCase();

  const jobs = [];
  const seen = new Set();
  for (const block of html.split(/<table class='title'/i).slice(1)) {
    const id = (block.match(/JobID:\s*(\d+)/i) || [])[1];
    const title = text((block.match(/<td id='wrapword'[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '');
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);

    const field = (name) => {
      const re = new RegExp(`${name}:\\s*</span>[\\s\\S]*?<span class=['"]normal['"][^>]*>([\\s\\S]*?)</span>`, 'i');
      return text((block.match(re) || [])[1] || '');
    };
    const site = field('Location');
    const location =
      site && (!cityName || site.toLowerCase().includes(cityName))
        ? site
        : [site, defaultLocation].filter(Boolean).join(' - ');
    const job = {
      title,
      url: `${base}/default.aspx?AppliTrackJobId=${id}&AppliTrackLayoutMode=detail&AppliTrackViewPosting=1`,
      company: companyName,
      location,
    };
    const postedAt = toEpochMs(field('Date Posted'));
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}
