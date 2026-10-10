import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const API_URL = 'https://careers.garena.com/api/job/list';
const HOST = 'careers.garena.com';
const DEFAULT_OFFICE = 'global';

export function parseGarenaResponse(json, entry) {
  const jobs = json && Array.isArray(json.jobs) ? json.jobs : null;
  if (!jobs) {
    throw new Error(`garena: unexpected API response — expected jobs[], got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
  }

  const officeSegment = urlSegment('office', resolveOffice(entry));
  const company = (entry && entry.name) || 'Garena';

  const out = [];
  for (const j of jobs) {
    if (!j || typeof j.title !== 'string' || j.title.trim() === '') continue;
    const id = j.id != null ? String(j.id).trim() : '';
    if (!id) continue;
    const idSegment = idUrlSegment(id);
    if (idSegment === null) continue;

    const locations = Array.isArray(j.tags && j.tags.location)
      ? j.tags.location.filter((l) => typeof l === 'string' && l.trim())
      : [];

    const job = {
      title: j.title.trim(),
      url: `https://${HOST}/${officeSegment}/careers/${idSegment}`,
      company,
      location: locations.join(', '),
    };
    const desc = typeof j.description === 'string' ? htmlToText(j.description).trim() : '';
    if (desc) job.description = desc;

    out.push(job);
  }
  return out;
}

function resolveOffice(entry) {
  const office = entry && entry.garena && entry.garena.office;
  return typeof office === 'string' && office.trim() ? office.trim() : DEFAULT_OFFICE;
}

function urlSegment(name, value) {
  if (value === '.' || value === '..') {
    throw new Error(`garena: ${name} is not a usable URL segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

function idUrlSegment(id) {
  if (id === '.' || id === '..') return null;
  return safeEncodeURIComponent(id);
}

export default {
  id: 'garena',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === HOST) return { url };
    } catch {
    }
    return null;
  },

  async fetch(entry, ctx) {
    const url = `${API_URL}?office=${urlSegment('office', resolveOffice(entry))}`;

    const json = await ctx.fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({}),
      redirect: 'error',
    });

    return parseGarenaResponse(json, entry);
  },
};
