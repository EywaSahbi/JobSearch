#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { isIP } from 'net';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { fetchJson as defaultFetchJson, fetchTextHead as defaultFetchText, makeHttpCtx } from './providers/_http.mjs';
import { isBlockedAddress } from './providers/_ip-guard.mjs';

const MAX_PROBE_REDIRECTS = 5;

function probeRedirectTarget(err, from) {
  const status = err?.status;
  if (typeof status !== 'number' || status < 300 || status >= 400 || !err.location) return null;
  let next;
  try {
    next = new URL(err.location, from);
  } catch {
    return null;
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') return null;
  const host = next.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) return null;
  return next.href;
}

const followRedirects = (fetchFn) => async (url, opts = {}) => {
  let current = url;
  for (let hop = 0; ; hop++) {
    try {
      return await fetchFn(current, { ...opts, redirect: 'manual' });
    } catch (err) {
      const next = hop < MAX_PROBE_REDIRECTS ? probeRedirectTarget(err, current) : null;
      if (next === null) throw err;
      current = next;
    }
  }
};
const probeFetchJson = followRedirects(defaultFetchJson);
const probeFetchText = followRedirects(defaultFetchText);
import { decodeEntities } from './providers/_html-entities.mjs';
import { asciiFold } from './lib/ascii-fold.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');

const PROVIDERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'providers');

export const ATS = {
  greenhouse: {
    probeUrl: (slug) =>
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    jobCount: (json) => (Array.isArray(json?.jobs) ? json.jobs.length : null),
    ownerUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}`,
    ownerKind: 'json',
    ownerName: (json) => (typeof json?.name === 'string' ? json.name.trim() : null),
  },
  ashby: {
    probeUrl: (slug) =>
      `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    jobCount: (json) => (Array.isArray(json?.jobs) ? json.jobs.length : null),
    ownerUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    ownerKind: 'html',
    ownerName: (html) => boardTitleOwner(html),
  },
  lever: {
    probeUrl: (slug, { eu = false } = {}) => `https://api.${eu ? 'eu.' : ''}lever.co/v0/postings/${slug}`,
    jobCount: (json) => (Array.isArray(json) ? json.length : null),
    ownerUrl: (slug, { eu = false } = {}) => `https://jobs.${eu ? 'eu.' : ''}lever.co/${slug}`,
    ownerKind: 'html',
    ownerName: (html) => boardTitleOwner(html),
  },
};

const ATS_URL_PATTERNS = [
  {
    ats: 'greenhouse',
    re: /boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/,
  },
  { ats: 'greenhouse', re: /job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/ },
  { ats: 'greenhouse', re: /boards\.greenhouse\.io\/([^/?#]+)/ },
  { ats: 'ashby', re: /api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/ },
  { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([^/?#]+)/ },
  { ats: 'lever', host: 'api.eu.lever.co', re: /^\/v0\/postings\/([^/?#]+)/, eu: true },
  { ats: 'lever', host: 'jobs.eu.lever.co', re: /^\/([^/?#]+)/, eu: true },
  { ats: 'lever', host: 'api.lever.co', re: /^\/v0\/postings\/([^/?#]+)/ },
  { ats: 'lever', host: 'jobs.lever.co', re: /^\/([^/?#]+)/ },
];

export function parseAtsSlug(url) {
  const text = String(url || '');
  let hostname = null;
  let pathname = null;
  try {
    ({ hostname, pathname } = new URL(text));
  } catch {
  }
  for (const { ats, re, eu, host } of ATS_URL_PATTERNS) {
    if (host) {
      if (hostname !== host) continue;
      const m = pathname.match(re);
      if (m && m[1]) return eu ? { ats, slug: m[1], eu: true } : { ats, slug: m[1] };
      continue;
    }
    const m = text.match(re);
    if (m && m[1]) return eu ? { ats, slug: m[1], eu: true } : { ats, slug: m[1] };
  }
  return null;
}

const SLUG_SUFFIXES = ['ai', 'tech', 'io', 'hq', 'labs'];

export function deriveSlugCandidates(name, { firstWordSuffixes = true } = {}) {
  if (!String(name ?? '').trim()) return [];
  const words = asciiFold(name).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const candidates = [
    words.join(''),
    words.join('-'),
    words.join('_'),
    words[0],
  ];
  const bases = (firstWordSuffixes ? [words.join(''), words[0]] : [words.join('')]).filter(Boolean);
  for (const base of bases) {
    for (const suf of SLUG_SUFFIXES) candidates.push(`${base}${suf}`);
    candidates.push(`${base}.tech`, `${base}.io`);
  }
  return [...new Set(candidates)].filter(Boolean);
}

export function classifyFetchError(err) {
  if (!err) return 'unknown';
  if (err.name === 'AbortError') return 'network';
  const msg = String(err.message || err);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return 'network';
  }
  const status = err.status;
  if (status === 404 || status === 410) return 'slug_gone';
  if (status === 401 || status === 403) return 'auth';
  if (typeof status === 'number' && status >= 500) return 'server';
  if (/HTTP 404|HTTP 410/.test(msg)) return 'slug_gone';
  if (/HTTP 401|HTTP 403/.test(msg)) return 'auth';
  if (/HTTP 5\d\d/.test(msg)) return 'server';
  return 'unknown';
}

export async function probeSlug(
  ats,
  slug,
  { fetchJson = probeFetchJson, eu = false } = {},
) {
  const spec = ATS[ats];
  if (!spec)
    return {
      ats,
      slug,
      url: '',
      status: 'missing',
      errorKind: 'unknown',
      reason: `unknown ATS: ${ats}`,
    };
  const url = spec.probeUrl(slug, { eu });
  try {
    const json = await fetchJson(url);
    const count = spec.jobCount(json);
    if (count == null)
      return {
        ats,
        slug,
        url,
        status: 'missing',
        errorKind: 'unknown',
        reason: 'unexpected response shape',
      };
    return {
      ats,
      slug,
      url,
      status: count > 0 ? 'live' : 'empty',
      jobCount: count,
    };
  } catch (err) {
    return {
      ats,
      slug,
      url,
      status: 'missing',
      errorKind: classifyFetchError(err),
      httpStatus: err?.status,
      reason: err?.message || String(err),
    };
  }
}

export function boardTitleOwner(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!m) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.replace(/\s+jobs$/i, '').trim() || null;
}

const NAME_ARTICLES = new Set(['the']);
const NAME_DESIGNATORS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'ag', 'kg', 'sa', 'sas', 'sarl', 'srl',
  'spa', 'bv', 'nv', 'ab', 'as', 'oy', 'aps', 'pty', 'pte', 'kk', 'kft',
]);

function canonicalNameTokens(name) {
  const spaced = String(name || '').replace(/\s+/g, ' ');
  const words = asciiFold(spaced.replace(/\s+&\s+/g, ' and '), { punctuation: 'delete' })
    .split(' ')
    .filter(Boolean);
  let start = 0;
  if (words.length > 1 && NAME_ARTICLES.has(words[0])) start = 1;
  let end = words.length;
  while (end - start > 1 && NAME_DESIGNATORS.has(words[end - 1])) end -= 1;
  return words.slice(start, end);
}

export function boardIdentityMatches(companyName, boardName) {
  const a = canonicalNameTokens(companyName);
  const b = canonicalNameTokens(boardName);
  if (!a.length || !b.length) return false;
  return a.length === b.length && a.every((tok, i) => tok === b[i]);
}

async function ownerConfirmed(ats, slug, companyName, { fetchJson, fetchText, eu = false, cache }) {
  const spec = ATS[ats];
  if (!spec?.ownerUrl) return { ok: true, reason: 'no-owner-endpoint' };
  const key = `${ats}|${eu ? 'eu' : 'base'}|${slug}`;
  if (cache?.has(key)) return cache.get(key);
  let out;
  try {
    const url = spec.ownerUrl(slug, { eu });
    const raw = spec.ownerKind === 'html' ? await fetchText(url) : await fetchJson(url);
    const boardName = spec.ownerName(raw);
    if (!boardName) out = { ok: false, reason: 'owner-unnamed' };
    else if (boardIdentityMatches(companyName, boardName)) out = { ok: true, reason: 'owner-match', boardName };
    else out = { ok: false, reason: 'owner-mismatch', boardName };
  } catch (err) {
    out = { ok: false, reason: classifyFetchError(err) === 'slug_gone' ? 'owner-absent' : 'owner-unreachable' };
  }
  cache?.set(key, out);
  return out;
}

function sanitizeForTerminal(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 120).trim();
}

async function discoverAlternates(name, { fetchJson, fetchText }) {
  let bestEmpty = null;
  let bestRejected = null;
  const cache = new Map();
  for (const slug of deriveSlugCandidates(name, { firstWordSuffixes: false })) {
    for (const ats of Object.keys(ATS)) {
      const euVariants = ats === 'lever' ? [false, true] : [false];
      for (const eu of euVariants) {
        const r = await probeSlug(ats, slug, { fetchJson, eu });
        if (r.status !== 'live' && r.status !== 'empty') continue;
        const owner = await ownerConfirmed(ats, slug, name, { fetchJson, fetchText, eu, cache });
        if (!owner.ok) {
          if (r.status === 'live' && !bestRejected) {
            bestRejected = { ...r, ownerReason: owner.reason, ownerBoardName: owner.boardName || '' };
          }
          continue;
        }
        if (r.status === 'live') return r;
        if (!bestEmpty) bestEmpty = r;
      }
    }
  }
  if (bestEmpty) return { ...bestEmpty, rejectedAlternate: bestRejected };
  if (bestRejected) return { rejectedAlternate: bestRejected };
}

class ProbePageBudgetReached extends Error {}

const PROBE_REQUEST_BUDGET = 4;

function boundedProbeCtx(base) {
  let used = 0;
  let tripped = false;
  const guard = (fn) => async (url, opts) => {
    if (used >= PROBE_REQUEST_BUDGET) {
      tripped = true;
      throw new ProbePageBudgetReached();
    }
    used += 1;
    return fn(url, opts);
  };
  return {
    ctx: { ...base, maxPages: 1, fetchJson: guard(base.fetchJson), fetchText: guard(base.fetchText) },
    wasTripped: () => tripped,
  };
}

export async function probeProvider(entry, provider, baseCtx) {
  const { ctx, wasTripped } = boundedProbeCtx(baseCtx);
  try {
    const jobs = await provider.fetch(entry, ctx);
    const count = Array.isArray(jobs) ? jobs.length : 0;
    if (count > 0) {
      const result = { provider: provider.id, status: 'live', jobCount: count };
      if (wasTripped()) result.partial = true;
      return result;
    }
    if (wasTripped()) return { provider: provider.id, status: 'live', partial: true };
    return { provider: provider.id, status: 'empty', jobCount: 0 };
  } catch (err) {
    if (err instanceof ProbePageBudgetReached) {
      return { provider: provider.id, status: 'live', partial: true };
    }
    return {
      provider: provider.id,
      status: 'missing',
      errorKind: classifyFetchError(err),
      httpStatus: err?.status,
      reason: err?.message || String(err),
    };
  }
}

export async function verifyCompanies(
  companies,
  { fetchJson = probeFetchJson, fetchText = probeFetchText, providers = null, httpCtx = null } = {},
) {
  const list = Array.isArray(companies) ? companies : [];
  const results = [];
  for (const company of list) {
    if (!company || typeof company !== 'object') continue;
    if (company.enabled === false) continue;
    const name = typeof company.name === 'string' ? company.name : '(unnamed)';
    const match =
      parseAtsSlug(company.api) || parseAtsSlug(company.careers_url);
    if (match) {
      const probe = await probeSlug(match.ats, match.slug, { fetchJson, eu: match.eu });
      if (probe.status === 'live' || probe.status === 'empty') {
        results.push({ name, ...probe });
        continue;
      }
      if (probe.errorKind === 'slug_gone' || probe.errorKind === 'unknown') {
        const suggested = await discoverAlternates(name, { fetchJson, fetchText });
        if (suggested) {
          results.push({ name, ...probe, suggested });
          continue;
        }
      }
      results.push({ name, ...probe });
      continue;
    }

    if (providers && providers.size > 0) {
      const resolved = resolveProvider(company, providers, { skipIds: ['local-parser'] });
      if (resolved && resolved.provider) {
        const probe = await probeProvider(company, resolved.provider, httpCtx || makeHttpCtx());
        results.push({ name, ...probe });
        continue;
      }
    }

    results.push({
      name,
      status: 'skipped',
      reason: 'no provider matched careers_url or api',
    });
  }
  return results;
}

export async function verifyPortalsFile(
  filePath,
  { fetchJson = probeFetchJson, providers = null, httpCtx = null } = {},
) {
  if (!existsSync(filePath)) return { found: false, results: [] };
  const config = yaml.load(readFileSync(filePath, 'utf-8'));
  const entries = [
    ...(Array.isArray(config?.tracked_companies) ? config.tracked_companies : []),
    ...(Array.isArray(config?.job_boards) ? config.job_boards : []),
  ];
  const results = await verifyCompanies(entries, { fetchJson, providers, httpCtx });
  return { found: true, results };
}

const ICON = { live: '✅', empty: '🟡', missing: '❌', skipped: '➖' };

const ERROR_KIND_LABEL = {
  slug_gone: 'slug not found',
  auth: 'auth blocked',
  network: 'network error',
  server: 'server error',
  unknown: 'unresolved',
};

export function printResults(results) {
  for (const r of results) {
    const icon = ICON[r.status] || '?';
    const source = r.ats ? `${r.ats}/${r.slug}` : (r.provider || '?');
    let detail;
    if (r.status === 'live') {
      detail = r.partial ? `${source} (first page live)` : `${source} (${r.jobCount} live)`;
    } else if (r.status === 'empty') {
      detail = `${source} (live but empty)`;
    } else if (r.status === 'missing') {
      const kind = ERROR_KIND_LABEL[r.errorKind] || 'unresolved';
      detail = `${source} (${kind}) — ${r.reason || 'unresolved'}`;
      if (r.suggested && r.suggested.ats && r.suggested.slug) {
        detail += ` → try ${r.suggested.ats}/${r.suggested.slug}`;
      }
      const rejected = r.suggested?.rejectedAlternate;
      if (rejected) {
        const board = sanitizeForTerminal(rejected.ownerBoardName);
        const reason = rejected.ownerReason || 'identity unconfirmed';
        const who = board ? `owned by "${board}" — ${reason}` : reason;
        detail += `; also found live ${rejected.ats}/${rejected.slug} ${who}`;
      }
    } else {
      detail = r.reason || '';
    }
    console.log(`  ${icon} ${r.name} — ${detail}`);
  }
}

async function runAdd(name, { fetchJson }) {
  const candidates = deriveSlugCandidates(name);
  if (candidates.length === 0) {
    if (!String(name ?? '').trim()) {
      console.error('verify-portals: --add needs a company name');
    } else {
      console.error(
        `verify-portals: no ASCII slug can be derived from '${name}' — ` +
        'ATS slugs are ASCII, so pass the latinized brand name (or add the board URL to portals.yml directly).',
      );
    }
    process.exit(1);
  }
  console.log(
    `Probing ${candidates.length} slug candidate(s) for '${name}' across Greenhouse/Ashby/Lever...\n`,
  );
  const hits = [];
  for (const slug of candidates) {
    for (const ats of Object.keys(ATS)) {
      const r = await probeSlug(ats, slug, { fetchJson });
      if (r.status !== 'missing') {
        hits.push(r);
        console.log(
          `  ${ICON[r.status]} ${ats}: ${slug}` +
            (r.status === 'empty'
              ? ' (live but empty)'
              : ` (${r.jobCount} jobs)`),
        );
      }
    }
  }
  if (hits.length === 0) {
    console.log(
      '  ❌ No slug variant resolved on any ATS. Check the careers_url manually.',
    );
  } else {
    const best = hits.find((h) => h.status === 'live') || hits[0];
    console.log(
      `\nSuggested: careers_url for ${best.ats} → slug '${best.slug}'`,
    );
  }
}

const KNOWN_FLAGS = ['--add', '--strict', '--file', '--help', '-h'];
const VALUE_FLAGS = ['--add', '--file'];

const USAGE = `Usage:
  node verify-portals.mjs                 # sweep tracked_companies + job_boards in portals.yml
  node verify-portals.mjs --add cursor    # probe slug variants for one name
  node verify-portals.mjs --strict        # exit non-zero if any slug is unresolved
  node verify-portals.mjs --file <path>   # use a specific portals file
  node verify-portals.mjs --help          # print this usage block and exit`;

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const strict = hasFlag(args, '--strict');
  const fetchJson = probeFetchJson;

  if (hasFlag(args, '--add')) {
    await runAdd(flagValue(args, '--add') || '', { fetchJson });
    return;
  }

  const fileArg = flagValue(args, '--file');
  if (hasFlag(args, '--file') && !fileArg) {
    console.error('Error: --file requires a value');
    process.exit(1);
  }

  const filePath = resolve(
    hasFlag(args, '--file') ? fileArg : DEFAULT_PORTALS_PATH,
  );

  const providers = await loadProviders(PROVIDERS_DIR);
  const { mergeProviderPlugins } = await import('./plugins/_engine.mjs');
  await mergeProviderPlugins(providers, { root: dirname(PROVIDERS_DIR), dataRoot: DATA_ROOT });
  const httpCtx = makeHttpCtx();
  const { found, results } = await verifyPortalsFile(filePath, { fetchJson, providers, httpCtx });
  if (!found) {
    console.log(
      `verify-portals: no portals file at ${filePath} — nothing to verify (run onboarding first).`,
    );
    return;
  }

  console.log(`verify-portals: ${filePath}\n`);
  printResults(results);

  const live = results.filter((r) => r.status === 'live').length;
  const empty = results.filter((r) => r.status === 'empty').length;
  const missing = results.filter((r) => r.status === 'missing');
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const kindCounts = Object.fromEntries(
    Object.keys(ERROR_KIND_LABEL).map((k) => [k, 0]),
  );
  for (const r of missing) {
    const k = r.errorKind && ERROR_KIND_LABEL[r.errorKind] ? r.errorKind : 'unknown';
    kindCounts[k]++;
  }
  const breakdown = Object.entries(kindCounts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${ERROR_KIND_LABEL[k]}`)
    .join(', ');
  console.log(
    `\n${live} live, ${empty} live-but-empty, ${missing.length} unresolved${breakdown ? ` (${breakdown})` : ''}, ${skipped} no-provider (skipped)`,
  );

  if (strict && missing.length > 0) {
    console.log('🔴 Unresolved slugs found (--strict).');
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`verify-portals failed: ${err.message}`);
    process.exit(1);
  });
}
