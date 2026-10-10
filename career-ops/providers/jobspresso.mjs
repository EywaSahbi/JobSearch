import { decodeEntities } from './_html-entities.mjs';

const FEED_URL = 'https://jobspresso.co/?feed=job_feed';
const TRUSTED_HOST = 'jobspresso.co';

function assertJobspressoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobspresso: invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:")
    throw new Error(`jobspresso: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(
      `jobspresso: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`,
    );
  }
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export default {
  id: "jobspresso",

  detect(entry) {
    return entry?.provider === "jobspresso" ? { url: FEED_URL } : null;
  },

  async fetch(_entry, ctx) {
    const feedUrl = assertJobspressoUrl(FEED_URL);
    const text = await ctx.fetchText(feedUrl, { redirect: "error" });
    return parseJobspressoFeed(text);
  },
};

function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function tagText(block, tag) {
  const m = block.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return m ? extractText(m[1]) : "";
}

function cleanUrl(value) {
  if (!value) return "";
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === "https:" && trusted ? parsed.href : "";
  } catch {
    return "";
  }
}

export function parseJobspressoFeed(xml) {
  if (typeof xml !== "string") return [];
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, "link"));
    if (!url) continue;

    const title = tagText(item, "title");
    if (!title) continue;
    const company = tagText(item, "job_listing:company") || "";
    const location = tagText(item, "job_listing:location");

    jobs.push({
      title,
      company,
      location,
      url,
      postedAt: toEpochMs(tagText(item, "pubDate")),
    });
  }

  return jobs;
}
