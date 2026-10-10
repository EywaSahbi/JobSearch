#!/usr/bin/env node

import * as httpBackend from './lib/api.mjs';
import { num } from './lib/api.mjs';
import * as localBackend from './lib/index.mjs';
import { readCache, writeCache } from './lib/cache.mjs';
import { classifyTier } from './lib/tier.mjs';

let backend = null;

async function selectBackend() {
  if (process.env.H1B_API_BASE !== undefined) {
    const token = process.env.H1B_API_TOKEN;
    return {
      kind: 'api',
      source: httpBackend.apiBase(),
      opts: token ? { token } : {},
      resolveEmployer: httpBackend.resolveEmployer,
      searchEmployers: httpBackend.searchEmployers,
      getEmployerProfile: httpBackend.getEmployerProfile,
    };
  }
  if (localBackend.hasIndex()) {
    return {
      kind: 'index',
      source: await localBackend.indexSource(),
      opts: {},
      resolveEmployer: localBackend.resolveEmployer,
      searchEmployers: localBackend.searchEmployers,
      getEmployerProfile: localBackend.getEmployerProfile,
    };
  }
  throw new Error(
    'no local H-1B index and no H1B_API_BASE. Install the index with: node plugins/h1b-sponsor/install-h1b-index.mjs '
    + '(about 8 MiB of public DOL data; lookups then stay on this machine). To use an HTTP endpoint instead, '
    + 'set H1B_API_BASE to one you trust.',
  );
}

function sourceRef(employerId) {
  if (!backend) return null;
  if (backend.kind === 'index') return backend.source;
  return employerId
    ? `${backend.source}/employers/${encodeURIComponent(employerId)}`
    : `${backend.source}/employers`;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
function displayClean(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim();
}

const CACHE_SCHEMA = 2;

async function writeCacheSafe(name, data, opts) {
  try {
    await writeCache(name, { ...data, schema: CACHE_SCHEMA }, opts);
  } catch (err) {
    const msg = displayClean((err && err.message) ? err.message : err);
    process.stderr.write(`h1b-sponsor: cache write failed (${msg}); continuing without cache\n`);
  }
}

function parseArgs(argv) {
  const args = { name: null, format: 'summary', refresh: false, cacheDir: null, search: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.format = 'json';
    else if (a === '--summary') args.format = 'summary';
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--search') args.search = true;
    else if (a === '--cache-dir') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next.trim()) args.cacheDir = next;
      i++;
    } else if (a.startsWith('-')) {
    } else rest.push(a);
  }
  args.name = rest.join(' ').trim();
  return args;
}


function formatSummary(result) {
  const clean = displayClean;
  if (!result.found) return `unknown: ${clean(result.displayName) || 'unknown company'}`;
  const t = result.totals || {};
  const range = (t.first_year && t.last_year)
    ? `${t.first_year}-${t.last_year}`
    : (t.last_year || t.first_year || 'n/a');
  return `${result.friendlinessTier}: ${clean(result.displayName)} - ${t.n_lca ?? 0} LCAs, ${t.n_pwd ?? 0} PWDs, ${t.n_perm ?? 0} PERMs, active ${range}`;
}

function buildResult(displayName, employerId, profile, source, fetchedAt) {
  const tier = classifyTier(profile);
  const staffing = (profile && profile.red_flags && profile.red_flags.staffing_shop) || null;
  const nLca = Number(profile?.n_lca ?? 0) || 0;
  const nPwd = Number(profile?.n_pwd ?? 0) || 0;
  const nPerm = Number(profile?.n_perm ?? 0) || 0;
  return {
    found: true,
    employerId,
    displayName,
    hasSponsorshipHistory: (nLca + nPwd + nPerm) > 0,
    totals: {
      n_lca: nLca,
      n_certified: num(profile?.n_certified),
      n_pwd: nPwd,
      n_perm: nPerm,
      first_year: profile?.first_year ?? null,
      last_year: profile?.last_year ?? null,
      does_gc: profile?.does_gc === true,
    },
    redFlags: { staffing_shop: staffing },
    friendlinessTier: tier,
    source,
    fetchedAt,
  };
}

function notFoundResult(name, fetchedAt = new Date().toISOString()) {
  return {
    found: false,
    employerId: null,
    displayName: name,
    hasSponsorshipHistory: false,
    totals: { n_lca: 0, n_certified: null, n_pwd: 0, n_perm: 0, first_year: null, last_year: null, does_gc: false },
    redFlags: { staffing_shop: null },
    friendlinessTier: 'unknown',
    source: sourceRef(null),
    fetchedAt,
  };
}

function emit(format, obj) {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  } else {
    process.stdout.write(formatSummary(obj) + '\n');
  }
}

function emitSearch(format, query, total, results) {
  const clean = displayClean;
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ query, total, shown: results.length, results }, null, 2) + '\n');
    return;
  }
  if (results.length === 0) {
    process.stdout.write(`no matches for "${clean(query)}"\n`);
    return;
  }
  const header = total > results.length
    ? `${results.length} of ${total} matches for "${clean(query)}" (narrow the query to see the rest):`
    : `${results.length} match${results.length === 1 ? '' : 'es'} for "${clean(query)}":`;
  const rows = results.map(r => `  ${clean(r.id)}  ${clean(r.name)}`);
  process.stdout.write([header, ...rows].join('\n') + '\n');
}

async function main() {
  const { name, format, refresh, cacheDir, search } = parseArgs(process.argv.slice(2));
  if (!name) {
    process.stderr.write('Usage: node plugins/h1b-sponsor/check.mjs <company-name> [--json|--summary] [--refresh] [--search] [--cache-dir <path>]\n');
    process.exit(2);
  }

  backend = await selectBackend();
  const opts = backend.opts;
  const cacheOpts = cacheDir ? { cacheDir } : {};

  if (search) {
    const { total, results } = await backend.searchEmployers(name, opts);
    emitSearch(format, name, total, results);
    return;
  }

  if (!refresh) {
    const cached = await readCache(name, cacheOpts);
    if (cached) {
      const sameSchema = Boolean(cached.data) && cached.data.schema === CACHE_SCHEMA;
      if (sameSchema && cached.negative && cached.data.source === backend.source) {
        const out = notFoundResult(name);
        out.fetchedAt = cached.fetchedAt;
        emit(format, out);
        return;
      }
      const { displayName, employerId, profile, source } = cached.data || {};
      if (sameSchema && displayName && employerId && profile && source === backend.source) {
        const out = buildResult(displayName, employerId, profile, sourceRef(employerId), cached.fetchedAt);
        emit(format, out);
        return;
      }
    }
  }

  const match = await backend.resolveEmployer(name, opts);
  if (!match) {
    const out = notFoundResult(name);
    await writeCacheSafe(name, { name, source: backend.source }, { ...cacheOpts, negative: true, fetchedAt: out.fetchedAt });
    emit(format, out);
    return;
  }

  const profile = await backend.getEmployerProfile(match.id, opts);
  const now = new Date().toISOString();
  if (profile) {
    await writeCacheSafe(name, {
      displayName: match.displayName,
      employerId: match.id,
      profile,
      source: backend.source,
    }, { ...cacheOpts, fetchedAt: now });
  }
  const out = buildResult(match.displayName, match.id, profile, sourceRef(match.id), now);
  emit(format, out);
}

main().catch(err => {
  const message = displayClean((err && err.message) ? err.message : err);
  const argv = process.argv.slice(2);
  const format = argv.includes('--json') ? 'json' : 'summary';
  const { name, search } = parseArgs(argv);
  if (search) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ query: name || '', total: 0, shown: 0, results: [], error: message }, null, 2) + '\n');
    } else {
      process.stdout.write(`search failed: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  const payload = { ...notFoundResult(name || 'unknown company'), error: message };
  if (format === 'json') {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(`unknown: ${message}\n`);
  }
  process.exitCode = 1;
  return;
});
