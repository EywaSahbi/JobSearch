import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { hasToken, runActor } from './_apify.mjs';

const JDS_DIR = 'jds';
const MIN_JD_BODY_CHARS = 50;

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function isFieldSpec(spec) {
  if (typeof spec === 'string') return true;
  if (Array.isArray(spec) && spec.length > 0 && spec.every(s => typeof s === 'string')) return true;
  return false;
}

function pickField(item, spec) {
  const keys = Array.isArray(spec) ? spec : [spec];
  for (const k of keys) {
    const v = getPath(item, k);
    if (v != null && v !== '') return v;
  }
  return '';
}

const ALLOWED_DEFAULT_KEYS = new Set(['title', 'url', 'company', 'location']);

export function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  const hash = createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
  return `jd-${hash}`;
}

function yamlEscape(str) {
  const s = String(str ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function htmlToText(s) {
  const raw = String(s || '');
  if (!raw || !/[<&]/.test(raw)) return raw.trim();
  let cleaned = raw
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n');
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/<[^>]+>/g, '');
  } while (cleaned !== prev);
  return cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function saveJd(normalized, descriptionBody, sourceLabel) {
  let relPath = null;
  try {
    mkdirSync(JDS_DIR, { recursive: true });
    const baseSlug = slugify(`${normalized.company}-${normalized.title}`);
    const urlHash = createHash('sha1')
      .update(String(normalized.url || `${normalized.company}-${normalized.title}`))
      .digest('hex')
      .slice(0, 10);
    const filename = `${baseSlug}-${urlHash}.md`;
    const filepath = join(JDS_DIR, filename);
    relPath = `${JDS_DIR}/${filename}`;
    if (existsSync(filepath)) return relPath;
    const today = new Date().toISOString().slice(0, 10);
    const content = `---
title: ${yamlEscape(normalized.title)}
company: ${yamlEscape(normalized.company)}
url: ${yamlEscape(normalized.url)}
location: ${yamlEscape(normalized.location)}
scraped: "${today}"
source: ${sourceLabel}
---

# ${normalized.title} — ${normalized.company}

${descriptionBody}
`;
    writeFileSync(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    return relPath;
  } catch (err) {
    if (err?.code === 'EEXIST' && relPath) return relPath;
    console.warn(`apify: JD cache write failed for ${normalized.title} (${err.code || err.name}: ${err.message}); falling back to remote URL`);
    return null;
  }
}

export function normalizeItem(item, fieldMap, defaults) {
  const out = {
    title: String(pickField(item, fieldMap.title) || ''),
    url: String(pickField(item, fieldMap.url) || ''),
    company: fieldMap.company ? String(pickField(item, fieldMap.company) || '') : '',
    location: fieldMap.location ? String(pickField(item, fieldMap.location) || '') : '',
  };
  for (const [k, v] of Object.entries(defaults || {})) {
    if (!ALLOWED_DEFAULT_KEYS.has(k)) continue;
    if (!out[k]) out[k] = String(v);
  }
  return out;
}

export default {
  provider: {
    id: 'apify',
    detect() { return null; },

    async fetch(entry, ctx) {
      const token = ctx?.env?.APIFY_TOKEN || process.env.APIFY_TOKEN;
      if (!hasToken(token)) {
        throw new Error('APIFY_TOKEN not set — enable apify in config/plugins.yml and add the token to .env');
      }
      if (!entry.actor) {
        throw new Error(`apify: entry ${entry.name} missing 'actor' (e.g. misceres/indeed-scraper)`);
      }
      if (
        !entry.field_map ||
        !isFieldSpec(entry.field_map.title) ||
        !isFieldSpec(entry.field_map.url) ||
        (entry.field_map.company != null && !isFieldSpec(entry.field_map.company)) ||
        (entry.field_map.location != null && !isFieldSpec(entry.field_map.location)) ||
        (entry.field_map.description != null && !isFieldSpec(entry.field_map.description))
      ) {
        throw new Error(
          `apify: entry ${entry.name} has invalid field_map. Each of title, url, company, ` +
          `location, description must be a string or a non-empty array of strings. title and url are required.`
        );
      }

      const opts = { token };
      if (entry.timeout_ms != null) opts.timeoutMs = entry.timeout_ms;
      const items = await runActor(entry.actor, entry.input || {}, opts);

      const useLocalJd = entry.field_map.description != null;
      const sourceLabel = String(entry.actor || 'apify').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

      return items
        .map(item => {
          const normalized = normalizeItem(item, entry.field_map, entry.defaults);
          if (!normalized.title || !normalized.url) return null;
          if (!isHttpsUrl(normalized.url)) return null;
          if (!useLocalJd) return normalized;
          const descriptionBody = htmlToText(pickField(item, entry.field_map.description));
          if (!descriptionBody || descriptionBody.length < MIN_JD_BODY_CHARS) {
            return normalized;
          }
          const remoteUrl = normalized.url;
          const jdPath = saveJd(normalized, descriptionBody, sourceLabel);
          if (jdPath === null) return normalized;
          normalized.url = `local:${jdPath}`;
          normalized._remote_url = remoteUrl;
          return normalized;
        })
        .filter(j => j && j.title && j.url);
    },
  },
};
