import { decodeEntities } from './_html-entities.mjs';

const decodeFeedText = (s) => decodeEntities(decodeEntities(s));

const FEED = 'https://cryptocurrencyjobs.co/index.xml';

function extractTag(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`,
    'i'
  );
  const m = block.match(re);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

export function splitTitle(raw) {
  const sep = ' at ';
  const idx = raw.lastIndexOf(sep);
  if (idx <= 0) return { title: raw, company: '' };
  return {
    title: raw.slice(0, idx).trim(),
    company: raw.slice(idx + sep.length).trim(),
  };
}

export function parseCryptocurrencyJobsRss(xml) {
  const parts = String(xml ?? '').split(/<item[\s>]/i);
  const results = [];

  for (let i = 1; i < parts.length; i++) {
    try {
      const block = parts[i];
      const rawTitle = decodeFeedText(extractTag(block, 'title'));
      const link = extractTag(block, 'link') || extractTag(block, 'guid');
      if (!rawTitle || !link) continue;

      const { title, company } = splitTitle(rawTitle);
      if (!title) continue;

      const pubDateStr = extractTag(block, 'pubDate');
      const postedAt = pubDateStr ? new Date(pubDateStr).getTime() : undefined;

      const description = decodeFeedText(extractTag(block, 'description'));

      results.push({
        title,
        url: link,
        company,
        location: 'Remote',
        ...(description ? { description } : {}),
        ...(postedAt && Number.isFinite(postedAt) ? { postedAt } : {}),
      });
    } catch {
    }
  }

  return results;
}

export default {
  id: 'cryptocurrencyjobs',

  async fetch(_entry, ctx) {
    const xml = await ctx.fetchText(FEED, { redirect: 'error' });
    return parseCryptocurrencyJobsRss(xml);
  },
};
