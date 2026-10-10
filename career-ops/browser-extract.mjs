#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { LIVENESS_CONTEXT_OPTIONS, rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveAtsApi, JD_TEXT_API_ATS } from './liveness-api.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { isWorkModelOnly } from './providers/greenhouse.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

const DEFAULT_TIMEOUT_MS = 15_000;
const HYDRATION_WAIT_MS = 2_000;
const JD_TEXT_CAP = 12_000;
const DEFAULT_LISTING_MAX = 200;
const WORKDAY_TIMEOUT_MS = 10_000;

const MIN_JD_TEXT_CHARS = 200;

const NAV_LABEL_STOPWORDS = new Set([
  'home', 'about', 'about us', 'contact', 'contact us', 'login', 'log in', 'sign in',
  'sign up', 'register', 'privacy', 'privacy policy', 'terms', 'cookies', 'cookie policy',
  'careers', 'jobs', 'search', 'menu', 'back', 'next', 'previous', 'apply', 'apply now',
  'learn more', 'read more', 'faq', 'blog', 'news', 'help', 'support', 'english',
]);

export function resolveExtractorMode(profilePath = join(CAREER_OPS, 'config/profile.yml')) {
  try {
    if (!existsSync(profilePath)) return 'mcp';
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const v = raw?.scan?.extractor;
    return v === 'cli' ? 'cli' : 'mcp';
  } catch {
    return 'mcp';
  }
}

export function compactText(s, cap = JD_TEXT_CAP) {
  const text = String(s ?? '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

export function normalizeJd(raw, finalUrl, textCap = JD_TEXT_CAP) {
  const ldText = jdHtmlToText(raw?.jsonLdDescription || '');
  const domText = compactText(String(raw?.text || ''), Infinity);
  const text = ldText.length > domText.length ? ldText : domText;

  return {
    url: finalUrl,
    title: compactText(raw?.title || raw?.jsonLdTitle || '', 300),
    text: compactText(text, textCap),
  };
}

export function workdayCxsUrl(rawUrl) {
  const ats = resolveAtsApi(rawUrl);
  return ats && ats.ats === 'workday' ? ats.apiUrl : null;
}

const BLOCK_END_RE = /<\/(p|div|ul|ol|h[1-6]|tr|section|article|blockquote)\s*>/gi;

export function jdHtmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  const stripped = decodeEntities(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(BLOCK_END_RE, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeWorkdayJob(json, postingUrl, textCap = JD_TEXT_CAP) {
  const info = json && typeof json === 'object' ? json.jobPostingInfo : null;
  if (!info || typeof info !== 'object') return null;

  const body = jdHtmlToText(info.jobDescription);
  if (!body) return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const locations = [
    str(info.location),
    ...(Array.isArray(info.additionalLocations) ? info.additionalLocations.map(str) : []),
  ].filter(Boolean);

  const meta = [];
  if (locations.length) meta.push(`Location: ${locations.join(' | ')}`);
  if (str(info.timeType)) meta.push(`Job type: ${str(info.timeType)}`);
  if (str(info.postedOn)) meta.push(`Posted: ${str(info.postedOn)}`);
  if (str(info.jobReqId)) meta.push(`Req ID: ${str(info.jobReqId)}`);
  if (info.canApply === false) meta.push('Applications closed (canApply: false)');

  return {
    url: postingUrl,
    title: compactText(str(info.title), 300),
    text: compactText([meta.join('\n'), body].filter(Boolean).join('\n\n'), textCap),
  };
}

async function fetchWorkdayJd(apiUrl, postingUrl, textCap, timeoutMs) {
  if (rejectPrivateOrInvalid(apiUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, WORKDAY_TIMEOUT_MS));
  try {
    const res = await fetch(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return normalizeWorkdayJob(await res.json(), postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeAshbyJob(json, jobId, postingUrl, textCap = JD_TEXT_CAP) {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const target = String(jobId ?? '').toLowerCase();
  const job = jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
  if (!job) return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const body = str(job.descriptionPlain);
  if (!body) return null;

  const meta = [];
  if (str(job.location)) meta.push(`Location: ${str(job.location)}`);
  if (Array.isArray(job.secondaryLocations)) {
    const extra = job.secondaryLocations.map((l) => str(l?.location)).filter(Boolean);
    if (extra.length) meta.push(`Additional locations: ${extra.join(' | ')}`);
  }
  if (str(job.employmentType)) meta.push(`Type: ${str(job.employmentType)}`);
  const workplaceType = str(job.workplaceType);
  if (workplaceType) meta.push(`Work model: ${workplaceType}`);
  else if (job.isRemote === true) meta.push('Work model: Remote');
  if (job.isListed === false) meta.push('Not currently listed (isListed: false)');

  return {
    url: postingUrl,
    title: compactText(str(job.title), 300),
    text: compactText([meta.join('\n'), body].filter(Boolean).join('\n\n'), textCap),
  };
}

async function fetchAshbyJd(apiUrl, jobId, postingUrl, textCap, timeoutMs) {
  if (rejectPrivateOrInvalid(apiUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeAshbyJob(json, jobId, postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeGreenhouseJob(json, postingUrl, textCap = JD_TEXT_CAP) {
  const body = jdHtmlToText(json?.content);
  if (!body) return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const meta = [];
  const offices = Array.isArray(json?.offices) ? json.offices.map((o) => str(o?.name)).filter(Boolean) : [];
  let location = str(json?.location?.name);
  if (offices.length && (!location || isWorkModelOnly(location))) {
    location = [location, ...offices].filter(Boolean).join(' · ');
  }
  if (location) meta.push(`Location: ${location}`);
  if (str(json?.requisition_id)) meta.push(`Req ID: ${str(json.requisition_id)}`);

  return {
    url: postingUrl,
    title: compactText(str(json?.title), 300),
    text: compactText([meta.join('\n'), body].filter(Boolean).join('\n\n'), textCap),
  };
}

async function fetchGreenhouseJd(apiUrl, postingUrl, textCap, timeoutMs) {
  const withContent = `${apiUrl}?content=true`;
  if (rejectPrivateOrInvalid(withContent)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(withContent, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeGreenhouseJob(json, postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeLeverJob(json, postingUrl, textCap = JD_TEXT_CAP) {
  if (!json || typeof json !== 'object') return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const lists = Array.isArray(json.lists)
    ? json.lists
        .map((l) => {
          const heading = str(l?.text);
          const content = jdHtmlToText(l?.content);
          return content ? `${heading ? `${heading}\n` : ''}${content}` : '';
        })
        .filter(Boolean)
        .join('\n\n')
    : '';
  const body = [str(json.descriptionPlain), lists, str(json.additionalPlain)].filter(Boolean).join('\n\n');
  if (!body) return null;

  const meta = [];
  if (str(json?.categories?.location)) meta.push(`Location: ${str(json.categories.location)}`);
  if (str(json?.categories?.team)) meta.push(`Team: ${str(json.categories.team)}`);

  return {
    url: postingUrl,
    title: compactText(str(json.text), 300),
    text: compactText([meta.join('\n'), body].filter(Boolean).join('\n\n'), textCap),
  };
}

async function fetchLeverJd(apiUrl, postingUrl, textCap, timeoutMs) {
  if (rejectPrivateOrInvalid(apiUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeLeverJob(json, postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGreenhouseEmbeddedJd(resolved, postingUrl, textCap, timeoutMs) {
  if (rejectPrivateOrInvalid(resolved.apiUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let jobApiUrl;
  try {
    const res = await fetch(resolved.apiUrl, {
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'manual',
      signal: controller.signal,
    });
    jobApiUrl = await resolved.followEmbed(res, resolved.parts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  return jobApiUrl ? fetchGreenhouseJd(jobApiUrl, postingUrl, textCap, timeoutMs) : null;
}

export function normalizeSmartRecruitersJob(json, postingUrl, textCap = JD_TEXT_CAP) {
  const sections = json?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const blocks = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((key) => {
      const body = jdHtmlToText(sections[key]?.text);
      return body ? [str(sections[key]?.title), body].filter(Boolean).join('\n') : '';
    })
    .filter(Boolean);
  if (!blocks.length) return null;

  const loc = json?.location || {};
  const meta = [];
  const where = str(loc.fullLocation) || [str(loc.city), str(loc.country)].filter(Boolean).join(', ');
  if (where) meta.push(`Location: ${where}`);
  if (loc.remote === true) meta.push('Work model: Remote');
  else if (loc.hybrid === true) meta.push('Work model: Hybrid');

  return {
    url: postingUrl,
    title: compactText(str(json?.name), 300),
    text: compactText([meta.join('\n'), ...blocks].filter(Boolean).join('\n\n'), textCap),
  };
}

async function fetchSmartRecruitersJd(apiUrl, postingUrl, textCap, timeoutMs) {
  if (rejectPrivateOrInvalid(apiUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeSmartRecruitersJob(json, postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const JD_FETCHERS = {
  workday: (resolved, url, textCap, timeoutMs) =>
    fetchWorkdayJd(resolved.apiUrl, url, textCap, timeoutMs),
  ashby: (resolved, url, textCap, timeoutMs) =>
    fetchAshbyJd(resolved.apiUrl, resolved.parts.jobId, url, textCap, timeoutMs),
  greenhouse: (resolved, url, textCap, timeoutMs) =>
    fetchGreenhouseJd(resolved.apiUrl, url, textCap, timeoutMs),
  lever: (resolved, url, textCap, timeoutMs) =>
    fetchLeverJd(resolved.apiUrl, url, textCap, timeoutMs),
  'greenhouse-embedded': (resolved, url, textCap, timeoutMs) =>
    fetchGreenhouseEmbeddedJd(resolved, url, textCap, timeoutMs),
  smartrecruiters: (resolved, url, textCap, timeoutMs) =>
    fetchSmartRecruitersJd(resolved.apiUrl, url, textCap, timeoutMs),
};

export async function fetchJdViaKnownApi(url, textCap = JD_TEXT_CAP, timeoutMs = WORKDAY_TIMEOUT_MS) {
  const resolved = resolveAtsApi(url);
  if (!resolved || !JD_TEXT_API_ATS.has(resolved.ats)) return null;
  const fetcher = JD_FETCHERS[resolved.ats];
  if (!fetcher) return null;

  const budgetMs = resolved.timeoutMs || timeoutMs;
  const result = await fetcher(resolved, url, textCap, budgetMs);
  return result ? { ...result, ats: resolved.ats } : null;
}

function emitJd(result, maxChars) {
  const floor = Math.min(MIN_JD_TEXT_CHARS, maxChars);
  if (result.text.length < floor) {
    console.error(JSON.stringify({
      error: `extracted ${result.text.length} chars of JD text (minimum ${floor}) — the page most likely renders its content client-side`,
      code: 'empty_text',
      url: result.url,
    }));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result));
}

export function normalizeListing(anchors, finalUrl, max = DEFAULT_LISTING_MAX) {
  const jobs = [];
  const seen = new Set();
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const label = String(a?.label ?? '').replace(/\s+/g, ' ').trim();
    if (label.length < 3 || NAV_LABEL_STOPWORDS.has(label.toLowerCase())) continue;

    let url;
    try {
      url = new URL(String(a?.href ?? ''), finalUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:$/.test(new URL(url).protocol)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push({ title: label, url });
    if (jobs.length >= max) break;
  }
  return { url: finalUrl, jobs };
}

const VALUE_FLAGS = ['--mode', '--max', '--max-chars', '--timeout'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

const USAGE_SYNOPSIS = 'browser-extract.mjs <url> [--mode jd|listing] [--max N] [--max-chars N] [--timeout MS]';

const USAGE = `Usage:
  node ${USAGE_SYNOPSIS}

  --mode jd|listing   jd (default) returns { url, title, text }; listing returns { url, jobs }
  --max N             listing: maximum postings to return (default ${DEFAULT_LISTING_MAX})
  --max-chars N       jd: text cap (default ${JD_TEXT_CAP}); raise it for a long JD
  --timeout MS        navigation timeout (default ${DEFAULT_TIMEOUT_MS})
  --help, -h          Show this help`;

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];

  const consumed = new Set();
  args.forEach((a, i) => {
    if (VALUE_FLAGS.includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      consumed.add(i + 1);
    }
  });

  let url;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (typeof tok !== 'string' || consumed.has(i)) continue;
    if (!tok.startsWith('-') && url === undefined) url = tok;
  }

  const num = (flag, ok, fallback) => {
    if (!hasFlag(args, flag)) return fallback;
    const n = Number(flagValue(args, flag));
    return Number.isInteger(n) && ok(n) ? n : fallback;
  };

  const modeVal = hasFlag(args, '--mode') ? flagValue(args, '--mode') : undefined;

  return {
    url,
    mode: modeVal == null ? 'jd' : modeVal,
    max: num('--max', (n) => n >= 0, DEFAULT_LISTING_MAX),
    maxChars: num('--max-chars', (n) => n > 0, JD_TEXT_CAP),
    timeout: num('--timeout', (n) => n > 0, DEFAULT_TIMEOUT_MS),
  };
}

async function readDom(page) {
  return page.evaluate(() => {
    const title = (document.querySelector('h1')?.innerText || document.title || '').trim();

    const root =
      document.querySelector('main, [role="main"], article') || document.body;
    let text = '';
    if (root) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script, style, nav, header, footer, noscript').forEach((el) => el.remove());
      text = clone.innerText || '';
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .filter((el) => {
        if (el.closest('nav, header, footer')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
      })
      .map((el) => ({ href: el.getAttribute('href') || '', label: (el.innerText || '').trim() }));

    let jsonLdDescription = '';
    let jsonLdTitle = '';
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(el.textContent || 'null');
      } catch {
        continue;
      }
      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.['@graph'])
          ? parsed['@graph']
          : [parsed];
      const isJobPostingType = (t) =>
        t === 'JobPosting' || t === 'http://schema.org/JobPosting' || t === 'https://schema.org/JobPosting';
      for (const node of candidates) {
        const type = node?.['@type'];
        const isJobPosting = Array.isArray(type) ? type.some(isJobPostingType) : isJobPostingType(type);
        if (!isJobPosting) continue;
        const desc = typeof node.description === 'string' ? node.description : '';
        if (desc.length > jsonLdDescription.length) {
          jsonLdDescription = desc;
          jsonLdTitle = typeof node.title === 'string' ? node.title : '';
        }
      }
    }

    return { title, text, anchors, jsonLdDescription, jsonLdTitle };
  });
}

async function main() {
  const args = process.argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const { url, mode, max, maxChars, timeout } = parseArgs(args);

  if (!url) {
    console.error(JSON.stringify({ error: `usage: ${USAGE_SYNOPSIS}`, code: 'no_url' }));
    process.exit(1);
  }
  if (mode !== 'jd' && mode !== 'listing') {
    console.error(JSON.stringify({ error: `unknown mode "${mode}" (expected jd|listing)`, code: 'bad_mode' }));
    process.exit(1);
  }

  const guard = rejectPrivateOrInvalid(url);
  if (guard) {
    console.error(JSON.stringify({ error: guard.reason, code: guard.code }));
    process.exit(1);
  }

  if (mode === 'jd') {
    const apiResult = await fetchJdViaKnownApi(url, maxChars, timeout);
    if (apiResult) {
      emitJd(apiResult, maxChars);
      return;
    }
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(JSON.stringify({ error: 'playwright not installed', code: 'no_playwright' }));
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    await context.route('**/*', (route) => {
      if (rejectPrivateOrInvalid(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(HYDRATION_WAIT_MS);

    const finalUrl = page.url();
    const finalGuard = rejectPrivateOrInvalid(finalUrl);
    if (finalGuard) {
      console.error(JSON.stringify({ error: `blocked final URL: ${finalGuard.reason}`, code: finalGuard.code }));
      process.exitCode = 1;
      return;
    }
    const raw = await readDom(page);

    if (mode === 'listing') {
      process.stdout.write(JSON.stringify(normalizeListing(raw.anchors, finalUrl, max)));
    } else {
      emitJd(normalizeJd(raw, finalUrl, maxChars), maxChars);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: `navigation error: ${String(err.message).split('\n')[0]}`, code: 'navigation_error' }));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
