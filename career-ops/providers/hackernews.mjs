const SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5';

function itemUrl(id) {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0].replace(/[.,;!?)]+$/, '') : '';
}

import { decodeEntities } from './_html-entities.mjs';

export function parseHnComment(text, threadUrl = '') {
  if (!text || typeof text !== 'string') return null;

  const plain = decodeEntities(text
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, (_, href) => href)
    .replace(/<\/?(?:p|br|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  if (!firstLine) return null;

  const parts = firstLine.split('|').map(p => p.trim());

  let company = '';
  let location = '';

  if (parts.length >= 3) {
    company = parts[0];
    location = parts[2].replace(/https?:\/\/\S+/g, '').trim();
  } else if (parts.length === 2) {
    company = parts[0];
  }

  const title = firstLine.replace(/https?:\/\/[^\s]+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!title) return null;

  const url = extractUrl(plain) || threadUrl;
  if (!url) return null;

  return { title, url, company, location };
}

export function resolveLatestThreadId(data) {
  if (!data || typeof data !== 'object') return null;
  const hits = (data).hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const RE = /ask\s+hn[:\s]+who\s+is\s+hiring/i;
  for (const hit of hits) {
    if (hit && typeof hit.objectID === 'string' && typeof hit.title === 'string') {
      if (RE.test(hit.title)) return hit.objectID;
    }
  }
  return null;
}

export default {
  id: 'hackernews',

  async fetch(entry, ctx) {
    const searchData = await ctx.fetchJson(SEARCH_URL, { redirect: 'error' });
    const threadId = resolveLatestThreadId(searchData);
    if (!threadId) {
      throw new Error('hackernews: could not find "Ask HN: Who is hiring?" thread in search results');
    }

    const threadHnUrl = `https://news.ycombinator.com/item?id=${threadId}`;

    const item = await ctx.fetchJson(itemUrl(threadId), { redirect: 'error' });
    if (!item || typeof item !== 'object') {
      throw new Error(`hackernews: unexpected item response for thread ${threadId}`);
    }

    const children = (item).children;
    if (!Array.isArray(children)) return [];

    const jobs = [];
    for (const child of children) {
      if (!child || child.deleted || child.dead) continue;
      const text = typeof child.text === 'string' ? child.text : '';
      if (!text.trim()) continue;

      const parsed = parseHnComment(text, threadHnUrl);
      if (!parsed) continue;

      jobs.push({
        title: parsed.title,
        url: parsed.url,
        company: parsed.company || (entry.name || 'HN Hiring'),
        location: parsed.location,
        ...(child.created_at
          ? { postedAt: Date.parse(child.created_at) || undefined }
          : {}),
      });
    }

    return jobs;
  },
};
