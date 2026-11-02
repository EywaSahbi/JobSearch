#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { renameSyncWithRetry } from './tracker-utils.mjs';

import { makeHttpCtx, fetchJson } from './providers/_http.mjs';
import { isResolverFailure, dnsPacingStats } from './providers/_dns-cache.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import workday, { WORKDAY_TRUNCATED_REASON } from './providers/workday.mjs';
import icims from './providers/icims.mjs';
import bamboohr from './providers/bamboohr.mjs';
import { buildTitleFilter, buildTitleFilterOverrides, buildTitleFilterWithOverrides, buildLocationFilter, buildContentFilter, matchedTitleKeywords, loadSeenUrls, normalizeUrlForDedup, appendToPipeline, appendToScanHistory, findBlacklistEntry, loadBlacklist, parseSinceDays, PORTALS_PATH, PIPELINE_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { SEED_SOURCES, toPortalEntry } from './seeds/vc-portfolios.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { boardKey, loadDeadBoards, recordBoardResult, saveDeadBoards, shouldSkipDeadBoard } from './dead-boards.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { barePrefixDomainKeywords, buildDomainFilter } from './title-keywords.mjs';
import { KNOWN_ATS_VENDORS } from './ats-vendor.mjs';
import { loadHistoryAtsSeeds } from './history-ats-seeds.mjs';
import { loadProviders } from './providers/_registry.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PROVIDERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers');
const CACHE_DIR = path.join(DATA_ROOT, 'data/cache/ats-companies');
const CACHE_TTL_HOURS = 24;
const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

const CONCURRENCY = 20;

const SINGLE_HOST_CONCURRENCY = 6;
const RESOLVER_FAILURE_LIMIT = 50;

const CHECKPOINT_PATH = path.join(DATA_ROOT, 'data/cache/ats-full-checkpoint.json');
const CHECKPOINT_EVERY = 500;
const DEAD_BOARDS_PATH = path.join(DATA_ROOT, 'data/dead-boards.tsv');

export function loadCheckpoint(file = CHECKPOINT_PATH) {
  if (!existsSync(file)) return null;
  try {
    const cp = JSON.parse(readFileSync(file, 'utf-8'));
    if (cp?.version !== 1) return null;
    if (cp.current !== null && cp.current !== undefined && !validCheckpointCurrent(cp.current)) return null;
    return cp;
  } catch {
    return null;
  }
}

function validCheckpointCurrent(cur) {
  return typeof cur === 'object'
    && typeof cur.name === 'string'
    && Number.isInteger(cur.resumeAt) && cur.resumeAt >= 0
    && Number.isInteger(cur.datasetLen) && cur.datasetLen >= 0
    && (cur.deferred === undefined
      || (Array.isArray(cur.deferred) && cur.deferred.every((i) => Number.isInteger(i) && i >= 0)));
}

export function checkpointCompatible(cp, opts) {
  return Boolean(cp)
    && !opts.shuffle
    && JSON.stringify(cp.ats) === JSON.stringify(opts.ats)
    && (cp.limit ?? null) === (opts.limit === Infinity ? null : opts.limit)
    && cp.includeUndated === opts.includeUndated;
}

function writeCheckpoint(cp) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CHECKPOINT_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp), 'utf-8');
    renameSyncWithRetry(tmp, CHECKPOINT_PATH);
    return true;
  } catch (err) {
    console.error(`\n⚠ checkpoint write failed (${err.message}) — sweep continues, --resume unavailable`);
    return false;
  }
}

function saveDeadBoardsBestEffort(rows) {
  try {
    saveDeadBoards(DEAD_BOARDS_PATH, rows);
    return true;
  } catch (err) {
    console.error(`\n⚠ dead-board cache write failed (${err.message}) — sweep continues`);
    return false;
  }
}

export function datasetFingerprint(list) {
  return createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 16);
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const WORKDAY_JUNK_TENANT_RE = /^wd\d+$/i;

export function entryOnHost(name, careersUrl, isCanonicalHost) {
  let hostname;
  try {
    ({ hostname } = new URL(careersUrl));
  } catch {
    return null;
  }
  return isCanonicalHost(hostname) ? { name, careers_url: careersUrl } : null;
}

export function icimsHostCandidates(slug) {
  const s = String(slug ?? '').toLowerCase().replace(/^-+/, '');
  if (!s) return [];
  const asIs = `${s}.icims.com`;
  const prefixed = `careers-${s}.icims.com`;
  if (s.startsWith('careers-')) return [asIs];
  return s.includes('careers') ? [asIs, prefixed] : [prefixed, asIs];
}

export const SOURCES = {
  greenhouse: {
    provider: greenhouse,
    concurrency: SINGLE_HOST_CONCURRENCY,
    dataset: `${DATASET_BASE}/greenhouse_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, h => h === 'job-boards.greenhouse.io')
      : null,
  },
  lever: {
    provider: lever,
    concurrency: SINGLE_HOST_CONCURRENCY,
    dataset: `${DATASET_BASE}/lever_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, h => h === 'jobs.lever.co')
      : null,
  },
  ashby: {
    provider: ashby,
    concurrency: SINGLE_HOST_CONCURRENCY,
    dataset: `${DATASET_BASE}/ashby_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, h => h === 'jobs.ashbyhq.com')
      : null,
  },
  workday: {
    provider: workday,
    dataset: `${DATASET_BASE}/workday_companies.json`,
    toEntry: (line) => {
      const [tenant, instance, site] = String(line).split('|');
      if (![tenant, instance, site].every(p => p && SLUG_RE.test(p))) return null;
      if (WORKDAY_JUNK_TENANT_RE.test(tenant)) return null;
      return entryOnHost(
        tenant,
        `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
        h => h === `${tenant}.${instance}.myworkdayjobs.com` && h.endsWith('.myworkdayjobs.com'),
      );
    },
  },
  icims: {
    provider: icims,
    dataset: `${DATASET_BASE}/icims_companies.json`,
    toEntry: (slug) => {
      if (!SLUG_RE.test(String(slug))) return null;
      const hosts = icimsHostCandidates(slug);
      if (hosts.length === 0) return null;
      const [primary, ...fallbacks] = hosts.map((h) => `https://${h}/jobs/search?ss=1&in_iframe=1`);
      const entry = entryOnHost(String(slug), primary, (h) => h === hosts[0]);
      if (entry && fallbacks.length) entry.fallback_urls = fallbacks;
      return entry;
    },
  },
  bamboohr: {
    provider: bamboohr,
    dataset: `${DATASET_BASE}/bamboohr_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://${slug}.bamboohr.com/careers`, h => h === `${slug}.bamboohr.com`)
      : null,
  },
};

const KNOWN_FLAGS = [
  '--since', '--limit', '--ats', '--seeds', '--history-seeds', '--dry-run', '--liveness',
  '--verbose', '--md-out', '--json', '--include-undated', '--include-blacklisted',
  '--shuffle', '--resume', '--help', '-h',
];

const VALUE_FLAGS = ['--since', '--limit', '--ats', '--seeds', '--md-out'];

const USAGE = `Usage:
  node scan-ats-full.mjs                      # scan all ATS directories, last 3 days
  node scan-ats-full.mjs --since 7            # postings from the last 7 days
  node scan-ats-full.mjs --ats greenhouse,workday  # subset of sources
  node scan-ats-full.mjs --history-seeds       # also scan boards from local application history
  node scan-ats-full.mjs --history-seeds --ats successfactors # history-derived boards for this ATS
  node scan-ats-full.mjs --limit 200          # max companies per ATS (default: all)
  node scan-ats-full.mjs --dry-run            # preview without writing files
  node scan-ats-full.mjs --liveness           # Playwright-verify matches before writing
  node scan-ats-full.mjs --include-blacklisted # audit: let data/blacklist.md matches through, annotated
  node scan-ats-full.mjs --verbose            # log per-board fetch failures
  node scan-ats-full.mjs --md-out <dir>       # also write a dated markdown digest to <dir>
  node scan-ats-full.mjs --resume             # continue an interrupted sweep from its checkpoint
  node scan-ats-full.mjs --help               # print this usage block and exit`;

export function parseArgs(argv) {
  const args = argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  const valueOf = (flag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const kv = args.find(a => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : null;
  };
  const sinceArg = parseSinceDays(args);
  if (sinceArg.error) {
    console.error(`Error: ${sinceArg.error}`);
    process.exit(1);
  }
  const sinceDays = sinceArg.days ?? 3;
  const limit = Number(valueOf('--limit')) || Infinity;
  const atsArg = valueOf('--ats');
  const seedsArg = valueOf('--seeds');
  const seeds = seedsArg
    ? seedsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const unknownSeeds = seeds.filter(s => !SEED_SOURCES[s]);
  if (unknownSeeds.length) {
    console.error(`Error: unknown seed source(s): ${unknownSeeds.join(', ')}. Valid: ${Object.keys(SEED_SOURCES).join(', ')}`);
    process.exit(1);
  }
  const ats = atsArg
    ? atsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : (seeds.length > 0 ? [] : Object.keys(SOURCES));
  const validAts = new Set([...Object.keys(SOURCES), ...KNOWN_ATS_VENDORS]);
  const unknown = ats.filter(a => !validAts.has(a));
  if (unknown.length) {
    console.error(`Error: unknown ATS source(s): ${unknown.join(', ')}. Valid: ${[...validAts].join(', ')}`);
    process.exit(1);
  }
  const historySeeds = args.includes('--history-seeds');
  const historyOnly = ats.filter(a => !SOURCES[a]);
  if (!historySeeds && historyOnly.length) {
    throw new Error(
      `--ats ${historyOnly.join(',')} ${historyOnly.length === 1 ? 'has' : 'have'} no public directory source; ` +
      're-run with --history-seeds to scan boards derived from local application history.',
    );
  }
  return {
    sinceDays,
    limit,
    ats,
    atsExplicit: Boolean(atsArg),
    historySeeds,
    seeds,
    dryRun: args.includes('--dry-run'),
    liveness: args.includes('--liveness'),
    verbose: args.includes('--verbose'),
    mdOut: valueOf('--md-out'),
    json: args.includes('--json'),
    includeUndated: args.includes('--include-undated'),
    includeBlacklisted: args.includes('--include-blacklisted'),
    shuffle: args.includes('--shuffle'),
    resume: args.includes('--resume'),
  };
}

async function loadCompanyList(name, url) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${name}.json`);
  if (existsSync(cacheFile)) {
    const ageHours = (Date.now() - statSync(cacheFile).mtimeMs) / 3_600_000;
    if (ageHours < CACHE_TTL_HOURS) {
      try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'ok' }; } catch { }
    }
  }
  try {
    const data = await fetchJson(url, { timeoutMs: 30_000 });
    if (Array.isArray(data)) {
      writeFileSync(cacheFile, JSON.stringify(data), 'utf-8');
      return { list: data, status: 'ok' };
    }
  } catch (err) {
    console.error(`⚠️  ${name}: could not download company list — ${err.message}`);
  }
  if (existsSync(cacheFile)) {
    try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'stale' }; } catch { }
  }
  return { list: [], status: 'empty' };
}

export function classifyPostingDate(job, cutoff) {
  if (job.postedAt && job.postedAt < cutoff) return 'stale';
  if (!job.postedAt) return 'undated';
  return 'keep';
}

export function filterBlacklistedOffers(offers, blacklist, { includeBlacklisted = false } = {}) {
  if (!blacklist || blacklist.size === 0) {
    return { offers, filteredBlacklist: 0, annotatedBlacklisted: 0 };
  }

  const kept = [];
  let filteredBlacklist = 0;
  let annotatedBlacklisted = 0;

  for (const offer of offers) {
    const entry = findBlacklistEntry(blacklist, offer.company || '', offer.url);
    if (!entry) {
      kept.push(offer);
      continue;
    }

    if (!includeBlacklisted) {
      filteredBlacklist++;
      continue;
    }

    annotatedBlacklisted++;
    const label = `blacklisted${entry.reason ? `: ${entry.reason}` : ''}`;
    kept.push({
      ...offer,
      blacklisted: true,
      note: typeof offer.note === 'string' && offer.note.trim()
        ? `${label} — ${offer.note}`
        : label,
    });
  }

  return { offers: kept, filteredBlacklist, annotatedBlacklisted };
}

export function resolveTitleFilterConfig(config) {
  return config?.title_filter_full ?? config?.title_filter;
}

export function boardInDomain(jobs, domainFilter) {
  return jobs.some(job => job?.title && domainFilter(job.title));
}

export function boardGateDecision(jobs, domainFilter) {
  if (!domainFilter) return 'process';
  if (boardInDomain(jobs, domainFilter)) return 'process';
  if (jobs.icimsTruncated) return 'process';
  if (!jobs.workdayTruncated) return 'gate';
  return jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.TRANSIENT ? 'defer' : 'process';
}

export function retryGateDecision(jobs, domainFilter, wasDeferred) {
  if (!wasDeferred) return 'process';
  return boardGateDecision(jobs, domainFilter) === 'gate' ? 'gate' : 'process';
}

export function passesFilters(job, { titleFilter, locationFilter, contentFilter, titleFilterConfig, companySlug }) {
  if (!titleFilter(job.title, companySlug)) return false;
  if (!locationFilter(job.location, job.url, job.title)) return false;
  if (contentFilter && !contentFilter(job.description, matchedTitleKeywords(job.title, titleFilterConfig))) return false;
  return true;
}

export function dedupTokenFor(job, provider) {
  return provider?.dedupKey?.(job) || normalizeUrlForDedup(job.url);
}

export function providerForSource(source) {
  return SOURCES[String(source || '').replace(/(?:-history)?-full$/, '')]?.provider;
}

export function sampleCompanies(list, limit, shuffle = false) {
  if (!shuffle || limit >= list.length) return list.slice(0, limit);
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

export function formatLiveOfferLine(job, source) {
  let postedAt = null;
  if (job?.postedAt) {
    const d = new Date(job.postedAt);
    if (!Number.isNaN(d.getTime())) postedAt = d.toISOString().slice(0, 10);
  }
  return JSON.stringify({
    kind: 'offer',
    company: job.company,
    title: job.title,
    url: job.url,
    location: job.location || null,
    postedAt,
    source: source || job.source || '',
  });
}

export function parseLiveOfferLine(line) {
  const raw = String(line || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let ev;
  try {
    ev = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (!ev || ev.kind !== 'offer') return null;
  const url = typeof ev.url === 'string' ? ev.url.trim() : '';
  if (!url || !ev.company || !ev.title) return null;
  return ev;
}

export function emitLiveOffer(job, source, { json } = {}) {
  if (!json || !job?.url || !job.company || !job.title) return;
  console.error(formatLiveOfferLine(job, source));
}

export function keepAndMaybeEmit(job, source, sink, blacklist, opts) {
  const kept = { ...job, source, dateStatus: job.postedAt ? 'dated' : 'unknown' };
  sink.push(kept);
  const live = filterBlacklistedOffers([kept], blacklist, { includeBlacklisted: opts.includeBlacklisted });
  if (live.offers.length) emitLiveOffer(live.offers[0], source, { json: opts.json });
}

const SEED_PROVIDERS = [greenhouse, lever, ashby];

export async function runSeedScan(seedId, opts, ctx, seenUrls, label) {
  const source = SEED_SOURCES[seedId];
  if (!source) throw new Error(`runSeedScan: unknown seed "${seedId}"`);

  let companies;
  try {
    companies = await source.fetch();
  } catch (err) {
    console.error(`⚠️  ${seedId}: could not fetch portfolio — ${err.message}`);
    return [];
  }

  const capped = opts.limit < companies.length
    ? (opts.shuffle
      ? (() => { const c = companies.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, opts.limit); })()
      : companies.slice(0, opts.limit))
    : companies;

  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const offers = [];
  let errors = 0;

  await parallelEach(capped, CONCURRENCY, async (company) => {
    const entry = toPortalEntry(company);
    if (!entry.careers_url) return;

    let provider = null;
    for (const p of SEED_PROVIDERS) {
      try {
        if (p.detect?.(entry)) { provider = p; break; }
      } catch { }
    }
    if (!provider) return;

    let jobs;
    try {
      jobs = await provider.fetch(entry, ctx);
    } catch (err) {
      errors++;
      if (opts.verbose) console.error(`  ✗ ${seedId}/${entry.name}: ${err.message}`);
      return;
    }

    const sourceName = `${seedId}-seed`;
    for (const job of jobs) {
      if (!job.url || !job.title) continue;
      const dateClass = classifyPostingDate(job, cutoff);
      if (dateClass === 'stale') continue;
      if (dateClass === 'undated' && !opts.includeUndated) continue;
      if (!passesFilters(job, {
        titleFilter: opts.titleFilter,
        locationFilter: opts.locationFilter,
        contentFilter: opts.contentFilter,
        companySlug: entry.name,
        titleFilterConfig: opts.titleFilterConfig,
      })) continue;
      const dedupToken = dedupTokenFor(job, provider);
      if (seenUrls.has(dedupToken)) continue;
      seenUrls.add(dedupToken);
      keepAndMaybeEmit(job, sourceName, offers, opts.blacklist, opts);
    }
  });

  return { offers, errors, total: capped.length };
}

export async function runHistorySeedScan(seeds, providers, opts, ctx, processJobs) {
  const selected = opts.atsExplicit
    ? seeds.filter((seed) => opts.ats.includes(seed.vendor))
    : seeds;
  const grouped = new Map();
  for (const seed of selected) {
    if (!grouped.has(seed.vendor)) grouped.set(seed.vendor, []);
    grouped.get(seed.vendor).push(seed);
  }
  const capped = [...grouped.values()].flatMap((group) => sampleCompanies(group, opts.limit, opts.shuffle));
  const scannable = [];
  for (const seed of capped) {
    const provider = providers.get(seed.vendor);
    if (!provider) continue;
    const entry = { name: seed.company, careers_url: seed.careersUrl, provider: seed.vendor };
    try {
      if (provider.detect?.(entry)) scannable.push({ seed, provider, entry });
    } catch { }
  }
  let errors = 0;
  const timeoutMs = opts.companyTimeoutMs ?? COMPANY_TIMEOUT_MS;
  const withHostSlot = createKeyedLimiter(SINGLE_HOST_CONCURRENCY);
  const quarantinedHosts = new Set();

  await parallelEach(scannable, CONCURRENCY, async ({ seed, provider, entry }) => {
    const hostKey = (() => {
      try { return new URL(entry.careers_url).hostname.toLowerCase(); } catch { return seed.vendor; }
    })();
    await withHostSlot(hostKey, async () => {
      if (quarantinedHosts.has(hostKey)) {
        errors++;
        if (opts.verbose) console.error(`  ✗ ${seed.vendor}-history/${entry.name}: host skipped after an earlier timeout`);
        return;
      }
      const operation = { active: true };
      const operationPromise = (async () => {
        const jobs = await provider.fetch(entry, ctx);
        if (!operation.active) return;
        await processJobs(jobs, `${seed.vendor}-history`, provider, entry.name, () => operation.active);
      })();
      let timedOut = false;
      try {
        await withTimeout(operationPromise, timeoutMs, `${seed.vendor}-history/${entry.name}`, () => {
          timedOut = true;
          operation.active = false;
        });
      } catch (err) {
        operation.active = false;
        if (timedOut) quarantinedHosts.add(hostKey);
        errors++;
        if (opts.verbose) console.error(`  ✗ ${seed.vendor}-history/${entry.name}: ${err.message}`);
      } finally {
        operationPromise.catch(() => {});
      }
    });
  });

  return {
    total: scannable.length,
    derived: selected.length,
    unsupported: capped.length - scannable.length,
    errors,
  };
}

const COMPANY_TIMEOUT_MS = 5 * 60_000;

export function createKeyedLimiter(limit) {
  const states = new Map();
  return async function withKeySlot(key, fn) {
    let state = states.get(key);
    if (!state) {
      state = { active: 0, queue: [] };
      states.set(key, state);
    }
    if (state.active >= limit) {
      await new Promise((resolve) => state.queue.push(resolve));
    } else {
      state.active++;
    }
    try {
      return await fn();
    } finally {
      const next = state.queue.shift();
      if (next) next();
      else {
        state.active--;
        if (state.active === 0) states.delete(key);
      }
    }
  };
}

export function withTimeout(promise, ms, label, onTimeout = null) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function parallelEach(items, limit, fn, onItemDone = null, shouldStop = null) {
  let next = 0;
  let done = 0;
  const inFlight = new Set();
  async function worker() {
    while (next < items.length) {
      if (shouldStop && shouldStop()) return;
      const idx = next++;
      inFlight.add(idx);
      try {
        await fn(items[idx], idx);
      } finally {
        inFlight.delete(idx);
        done++;
        const resumeAt = inFlight.size ? Math.min(...inFlight) : next;
        if (onItemDone) onItemDone({ done, resumeAt });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function filterLive(offers) {
  let chromium, checkUrlLiveness, newLivenessPage;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, newLivenessPage } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--liveness requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }
  console.error(`\nVerifying liveness of ${offers.length} match(es) with Playwright (sequential)...`);
  const browser = await chromium.launch({ headless: true });
  const live = [];
  try {
    const page = await newLivenessPage(browser);
    for (const offer of offers) {
      const { result, reason } = await checkUrlLiveness(page, offer.url);
      const icon = result === 'active' ? '✅' : result === 'expired' ? '❌' : '⚠️';
      console.error(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}${result === 'expired' ? ` (${reason})` : ''}`);
      if (result !== 'expired') live.push(offer);
    }
  } finally {
    await browser.close();
  }
  console.error(`  → ${live.length}/${offers.length} passed liveness`);
  return live;
}

function isoDay(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function main() {
  const opts = parseArgs(process.argv);
  let checkpoint = null;
  if (opts.resume) {
    const cp = loadCheckpoint();
    if (!cp) {
      console.error(`Error: --resume passed but no checkpoint found at ${CHECKPOINT_PATH}.`);
      process.exit(1);
    }
    if (!checkpointCompatible(cp, opts)) {
      console.error('Error: checkpoint was written with different settings (--ats/--limit/--include-undated, or --shuffle is set) — rerun with the original flags, or delete the checkpoint to start fresh.');
      process.exit(1);
    }
    checkpoint = cp;
  } else if (loadCheckpoint() && !opts.dryRun) {
    console.error(`⚠️  Unfinished sweep checkpoint found at ${CHECKPOINT_PATH} — pass --resume to continue it; this fresh run will overwrite it.`);
  }
  const cutoff = checkpoint ? checkpoint.cutoffMs : Date.now() - opts.sinceDays * 86_400_000;
  const log = opts.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  const progress = (s) => {
    if (opts.json) process.stderr.write(String(s).replace(/\r$/, '\n'));
    else process.stdout.write(s);
  };

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first — the reverse scan reuses its title_filter/location_filter.');
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const fullTitleFilterConfig = resolveTitleFilterConfig(config);
  const titleFilterOverrides = buildTitleFilterOverrides(config?.title_filter_overrides);
  const titleFilter = buildTitleFilterWithOverrides(fullTitleFilterConfig, titleFilterOverrides);
  const locationFilter = buildLocationFilter(config?.location_filter);
  const contentFilter = buildContentFilter(config?.content_filter);
  const bareDomain = barePrefixDomainKeywords(config?.domain_filter);
  if (bareDomain.length) {
    console.error(`Error: portals.yml domain_filter[${bareDomain.join(', ')}]: a word:/stem: prefix needs a term after it.`);
    process.exit(1);
  }
  const domainFilter = buildDomainFilter(config?.domain_filter);
  if (!fullTitleFilterConfig?.positive?.length) {
    const key = config?.title_filter_full ? 'title_filter_full' : 'title_filter';
    console.error(`⚠️  portals.yml has no ${key}.positive — every fresh posting on every board will match. Consider adding keywords.`);
  }
  opts.titleFilter = titleFilter;
  opts.locationFilter = locationFilter;
  opts.contentFilter = contentFilter;
  opts.titleFilterConfig = fullTitleFilterConfig;

  const historySeeds = opts.historySeeds
    ? loadHistoryAtsSeeds({ dataRoot: DATA_ROOT, scanHistoryPath: SCAN_HISTORY_PATH })
    : [];

  const atsSummary = opts.ats.length ? `ats: ${opts.ats.join(', ')}` : '';
  const seedsSummary = opts.seeds.length ? `seeds: ${opts.seeds.join(', ')}` : '';
  const historySummary = opts.historySeeds ? 'history seeds' : '';
  const sourcesSummary = [atsSummary, seedsSummary, historySummary].filter(Boolean).join(' | ');
  log(`Reverse ATS scan — ${sourcesSummary} | since ${opts.sinceDays}d${opts.limit < Infinity ? ` | limit ${opts.limit}/ats` : ''}${opts.shuffle ? ' | shuffled' : ''}${opts.includeUndated ? ' | +undated' : ''}${opts.liveness ? ' | liveness' : ''}${domainFilter ? ' | domain gate' : ''}${opts.dryRun ? ' | DRY RUN' : ''}`);

  const { seen: seenUrls } = loadSeenUrls({}, {
    extraTokensFor: (url, portal) => providerForSource(portal)?.dedupKey?.({ url }),
  });
  const blacklist = loadBlacklist();
  opts.blacklist = blacklist;
  const ctx = {
    ...makeHttpCtx(),
    sinceMs: cutoff,
    includeUndated: opts.includeUndated,
    syntheticEntries: true,
    locationHints: config?.location_filter,
  };
  const date = localToday();

  const newOffers = checkpoint?.offers || [];
  for (const o of newOffers) {
    seenUrls.add(dedupTokenFor(o, providerForSource(o.source)));
  }
  const completedSources = new Set(checkpoint?.completedSources || []);
  const cc = checkpoint?.counters || {};
  let totalCompaniesScanned = cc.totalCompaniesScanned || 0;
  let totalCompaniesAvailable = 0;
  let totalErrors = cc.totalErrors || 0;
  let totalRetiredBoardsSkipped = cc.totalRetiredBoardsSkipped || 0;
  let droppedNoDate = cc.droppedNoDate || 0;
  let droppedContent = cc.droppedContent || 0;
  let capHit = false;
  let noDateSkipCompanies = cc.noDateSkipCompanies || 0;
  let noDateSkipJobs = cc.noDateSkipJobs || 0;
  let cappedBoards = cc.cappedBoards || 0;
  let domainGatedBoards = cc.domainGatedBoards || 0;
  let domainGatedPostings = cc.domainGatedPostings || 0;
  const datasetStatus = {};

  let curEntries = 0;
  let curDone = 0;
  let curErrors = 0;
  let curDeadSkipped = 0;
  if (opts.json) {
    let flushed = false;
    process.on('SIGTERM', () => {
      if (flushed) return;
      flushed = true;
      try {
        const partial = filterBlacklistedOffers(newOffers, blacklist, {
          includeBlacklisted: opts.includeBlacklisted,
        }).offers.map((o) => ({
          company: o.company,
          title: o.title,
          url: o.url,
          location: o.location || null,
          postedAt: isoDay(o.postedAt),
          dateStatus: o.dateStatus || (o.postedAt ? 'dated' : 'unknown'),
          source: o.source,
        }));
        process.stdout.write(JSON.stringify({
          date,
          sources: opts.ats,
          stoppedEarly: true,
          companiesAvailable: totalCompaniesAvailable,
          companiesScanned: Math.max(0, totalCompaniesScanned - (curEntries - curDone) - curDeadSkipped),
          capHit,
          datasetStatus,
          postingsKept: partial.length,
          postingsDroppedNoDate: droppedNoDate,
          unreachableBoards: totalErrors + curErrors,
          domainFilterActive: Boolean(domainFilter),
          domainGatedBoards,
          domainGatedPostings,
          offers: partial,
        }) + '\n', () => process.exit(0));
      } catch {
        process.exit(0);
      }
    });
  }


  const snapshotCounters = () => ({
    totalCompaniesScanned, totalErrors, totalRetiredBoardsSkipped,
    droppedNoDate, droppedContent,
    noDateSkipCompanies, noDateSkipJobs, cappedBoards,
    domainGatedBoards, domainGatedPostings,
  });
  const checkpointBase = () => ({
    version: 1,
    cutoffMs: cutoff,
    ats: opts.ats,
    limit: opts.limit === Infinity ? null : opts.limit,
    includeUndated: opts.includeUndated,
    completedSources: [...completedSources],
    offers: newOffers,
    savedAt: new Date().toISOString(),
  });

  const processJobs = async (jobs, sourceName, provider, companySlug, shouldContinue = () => true) => {
    for (const job of jobs) {
      if (!shouldContinue()) return;
      if (!job.url || !job.title) continue;
      let dateClass = classifyPostingDate(job, cutoff);
      if (dateClass === 'stale') continue;
      if (dateClass === 'undated' && provider.enrichDate
          && titleFilter(job.title, companySlug) && locationFilter(job.location, job.url, job.title)) {
        try { await provider.enrichDate(job, ctx); } catch { }
        if (!shouldContinue()) return;
        dateClass = classifyPostingDate(job, cutoff);
      }
      if (dateClass === 'stale') continue;
      if (dateClass === 'undated' && !opts.includeUndated) { droppedNoDate++; continue; }
      if (!titleFilter(job.title, companySlug)) continue;
      if (!locationFilter(job.location, job.url, job.title)) continue;
      if (!contentFilter(job.description, matchedTitleKeywords(job.title, fullTitleFilterConfig))) { droppedContent++; continue; }
      const dedupToken = dedupTokenFor(job, provider);
      if (seenUrls.has(dedupToken)) continue;
      seenUrls.add(dedupToken);
      keepAndMaybeEmit(job, `${sourceName}-full`, newOffers, blacklist, opts);
    }
  };

  let stoppedByOutage = false;

  for (const name of opts.ats.filter((ats) => SOURCES[ats])) {
    const source = SOURCES[name];
    const { list, status } = await loadCompanyList(name, source.dataset);
    datasetStatus[name] = status;
    totalCompaniesAvailable += list.length;
    if (opts.limit < list.length) capHit = true;
    if (completedSources.has(name)) {
      log(`\n⚙  ${name} — already complete in resumed checkpoint, skipping`);
      continue;
    }
    const datasetHash = datasetFingerprint(list);
    const entriesAll = sampleCompanies(list, opts.limit, opts.shuffle).map(source.toEntry).filter(Boolean);

    let startAt = 0;
    if (checkpoint && checkpoint.current?.name === name) {
      const hashMismatch = checkpoint.current.datasetHash != null
        && checkpoint.current.datasetHash !== datasetHash;
      if (checkpoint.current.datasetLen !== list.length || hashMismatch) {
        console.error(`Error: ${name} company dataset changed since the checkpoint — resume order is no longer valid. Delete ${CHECKPOINT_PATH} and rerun.`);
        process.exit(1);
      }
      startAt = checkpoint.current.resumeAt;
    }
    const entries = entriesAll.slice(startAt);
    totalCompaniesScanned += entries.length;
    curEntries = entries.length; curDone = 0; curErrors = 0; curDeadSkipped = 0;
    log(`\n⚙  ${name} — ${entriesAll.length} companies${status !== 'ok' ? ` (dataset: ${status})` : ''}${startAt ? ` — resuming at ${startAt}` : ''}`);

    let errors = 0;
    let deadBoardsSkipped = 0;
    const deadBoards = loadDeadBoards(DEAD_BOARDS_PATH);
    let consecutiveResolverFailures = 0;
    let resolverOutage = false;
    let resolverOutageCompany = null;
    let lastDone = 0;
    let lastResumeAt = 0;
    const truncated = [];
    const deferred = new Map();
    for (const index of checkpoint?.current?.name === name ? checkpoint.current.deferred ?? [] : []) {
      if (index >= startAt || !entriesAll[index]) continue;
      truncated.push(entriesAll[index]);
      deferred.set(entriesAll[index], { index, jobs: null });
    }
    const deferredIndices = () => [...deferred.values()].map((d) => d.index);
    await parallelEach(entries, source.concurrency ?? CONCURRENCY, async (entry, idx) => {
      const deadBoard = boardKey(entry);
      if (shouldSkipDeadBoard(deadBoards, name, deadBoard)) {
        deadBoardsSkipped++;
        return;
      }
      try {
        await withTimeout((async () => {
          const jobs = await source.provider.fetch(entry, ctx);
          recordBoardResult(deadBoards, name, deadBoard, 200);
          consecutiveResolverFailures = 0;
          if (jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.TRANSIENT) truncated.push(entry);
          const decision = boardGateDecision(jobs, domainFilter);
          if (decision === 'gate') {
            domainGatedBoards++;
            domainGatedPostings += jobs.length;
            if (opts.verbose) console.error(`  ⊘ ${name}/${entry.name}: no domain-bearing posting — board skipped`);
            return;
          }
          if (decision === 'defer') {
            deferred.set(entry, { index: startAt + idx, jobs });
            return;
          }
          if (jobs.icimsTruncated) {
            cappedBoards++;
            if (opts.verbose) console.error(`  ⚠ ${name}/${entry.name}: hit the page cap — later postings not scanned`);
          }
          if (jobs.workdayNoDateSkip) { noDateSkipCompanies++; noDateSkipJobs += jobs.length; }
          await processJobs(jobs, name, source.provider, entry.name);
        })(), COMPANY_TIMEOUT_MS, `${name}/${entry.name}`);
      } catch (err) {
        errors++;
        recordBoardResult(deadBoards, name, deadBoard, err?.status);
        if (isResolverFailure(err)) {
          if (++consecutiveResolverFailures >= RESOLVER_FAILURE_LIMIT && !resolverOutage) {
            resolverOutage = true;
            resolverOutageCompany = entry.name;
          }
        } else {
          consecutiveResolverFailures = 0;
        }
        if (opts.verbose) console.error(`  ✗ ${name}/${entry.name}: ${err.message}`);
      }
    }, ({ done, resumeAt }) => {
      lastDone = done;
      curDone = done; curErrors = errors; curDeadSkipped = deadBoardsSkipped;
      lastResumeAt = resumeAt;
      if (done % 200 === 0 || done === entries.length) {
        progress(`  ${done}/${entries.length} scanned, ${newOffers.length} total matches\r`);
      }
      if (done % CHECKPOINT_EVERY === 0 && !opts.dryRun) {
        saveDeadBoardsBestEffort(deadBoards);
        writeCheckpoint({
          ...checkpointBase(),
          current: { name, resumeAt: startAt + resumeAt, datasetLen: list.length, datasetHash, deferred: deferredIndices() },
          counters: {
            ...snapshotCounters(),
            totalRetiredBoardsSkipped: totalRetiredBoardsSkipped + deadBoardsSkipped,
            totalCompaniesScanned: totalCompaniesScanned - (entries.length - done) - deadBoardsSkipped,
            totalErrors: totalErrors + errors,
          },
        });
      }
    }, () => resolverOutage);
    totalCompaniesScanned -= deadBoardsSkipped;
    if (truncated.length && !resolverOutage) {
      log(`\n  ↻ retrying ${truncated.length} truncated board(s) sequentially...`);
      for (const entry of truncated) {
        try {
          await withTimeout((async () => {
            const jobs = await source.provider.fetch(entry, ctx);
            recordBoardResult(deadBoards, name, boardKey(entry), 200);
            if (retryGateDecision(jobs, domainFilter, deferred.has(entry)) === 'gate') {
              domainGatedBoards++;
              domainGatedPostings += jobs.length;
              if (opts.verbose) console.error(`  ⊘ ${name}/${entry.name}: no domain-bearing posting — board skipped`);
            } else {
              await processJobs(jobs, name, source.provider, entry.name);
            }
            if (jobs.workdayTruncated) {
              errors++;
              if (opts.verbose) {
                const why = jobs.workdayTruncated === WORKDAY_TRUNCATED_REASON.STRUCTURAL
                  ? 'facet split hit its bound' : 'still truncated';
                console.error(`  ✗ ${name}/${entry.name}: ${why} after sequential retry`);
              }
            }
          })(), COMPANY_TIMEOUT_MS, `${name}/${entry.name} (retry)`);
        } catch (err) {
          errors++;
          recordBoardResult(deadBoards, name, boardKey(entry), err?.status);
          if (opts.verbose) console.error(`  ✗ ${name}/${entry.name} (retry): ${err.message}`);
          const partial = deferred.get(entry)?.jobs;
          if (partial) await processJobs(partial, name, source.provider, entry.name);
        }
      }
    }
    totalErrors += errors;
    totalRetiredBoardsSkipped += deadBoardsSkipped;
    if (!opts.dryRun) saveDeadBoardsBestEffort(deadBoards);
    if (resolverOutage) {
      stoppedByOutage = true;
      totalCompaniesScanned -= entries.length - lastDone;
      let checkpointWritten = false;
      if (!opts.dryRun) {
        checkpointWritten = writeCheckpoint({
          ...checkpointBase(),
          current: { name, resumeAt: startAt + lastResumeAt, datasetLen: list.length, datasetHash, deferred: deferredIndices() },
          counters: snapshotCounters(),
        });
      }
      log(`\n  ⛔ stopped ${name}/${resolverOutageCompany}: ${RESOLVER_FAILURE_LIMIT} consecutive DNS failures.`);
      log(`     Your resolver is refusing queries — it may be rate-limiting this host.`);
      log(`     Lower CONCURRENCY, raise the resolver's per-client limit, or set`);
      log(`     CAREER_OPS_NO_DNS_CACHE=1 only if you know the cache is at fault.`);
      if (checkpointWritten) log(`     Rerun with --resume once the resolver recovers — checkpointed at company ${startAt + lastResumeAt} of ${name}.`);
      break;
    }
    completedSources.add(name);
    curEntries = 0; curDone = 0; curErrors = 0; curDeadSkipped = 0;
    if (!opts.dryRun) {
      writeCheckpoint({ ...checkpointBase(), current: null, counters: snapshotCounters() });
    }
    log(`\n  done (${errors} unreachable boards, ${deadBoardsSkipped} retired boards skipped)`);
  }

  if (historySeeds.length && !stoppedByOutage) {
    const providers = await loadProviders(PROVIDERS_DIR);
    log(`\n🌱 Application history — ${historySeeds.length} unique ATS board(s) derived locally...`);
    const result = await runHistorySeedScan(historySeeds, providers, opts, ctx, processJobs);
    totalCompaniesScanned += result.total;
    totalErrors += result.errors;
    log(`  done — ${result.total} board(s) probed, ${result.unsupported} without a scanner provider (${result.errors} errors)`);
  }

  for (const seedId of opts.seeds) {
    const seedSource = SEED_SOURCES[seedId];
    log(`\n🌱 ${seedSource.label} (${seedId}-seed) — fetching portfolio...`);
    const result = await runSeedScan(seedId, opts, ctx, seenUrls, seedSource.label);
    if (result && result.offers) {
      totalCompaniesScanned += result.total || 0;
      totalErrors += result.errors || 0;
      newOffers.push(...result.offers);
      log(`  done — ${result.total} companies probed, ${result.offers.length} matches (${result.errors} errors)`);
    }
  }

  const blacklistResult = filterBlacklistedOffers(newOffers, blacklist, { includeBlacklisted: opts.includeBlacklisted });
  let offers = blacklistResult.offers;
  if (offers.length && opts.liveness) offers = await filterLive(offers);
  offers.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));

  printScanSummaryHeader('Reverse ATS Scan', date, log);
  log(`Companies scanned:  ${totalCompaniesScanned}${capHit ? ` of ${totalCompaniesAvailable} (capped)` : ''}`);
  log(`Unreachable boards: ${totalErrors}`);
  if (cappedBoards) log(`Page-capped boards: ${cappedBoards} (partial coverage — later postings not scanned)`);
  if (domainFilter) {
    log(`Domain-gated boards: ${domainGatedBoards} skipped, ${domainGatedPostings} posting${domainGatedPostings === 1 ? '' : 's'} never filtered${domainGatedBoards && !opts.verbose ? ' (--verbose names them)' : ''}`);
  }
  const pacing = dnsPacingStats();
  if (pacing.delayed > 0) {
    log(`DNS pacing:         ${pacing.delayed} lookup${pacing.delayed === 1 ? '' : 's'} delayed, ${Math.round(pacing.waitedMs / 1000)}s total wait (CAREER_OPS_DNS_LOOKUPS_PER_MIN to tune, 0 disables)`);
  }
  if (droppedNoDate) {
    const breakdown = noDateSkipCompanies
      ? ` (incl. ${noDateSkipJobs} from ${noDateSkipCompanies} workday companies with no postedOn)`
      : '';
    log(`Undated dropped: ${droppedNoDate}${breakdown}${opts.includeUndated ? '' : '. Use --include-undated to keep'}`);
  }
  if (blacklist.size > 0) {
    if (opts.includeBlacklisted) {
      log(`Blacklisted:      ${blacklistResult.annotatedBlacklisted} let through annotated (--include-blacklisted)`);
    } else {
      log(`Blacklisted:      ${blacklistResult.filteredBlacklist} skipped (blacklist)`);
    }
  }
  if (droppedContent) log(`Content-filtered:   ${droppedContent}`);
  log(`New matches:        ${offers.length}`);

  if (offers.length) {
    log('\nNew offers:');
    for (const o of offers) {
      const posted = o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'n/a';
      const blacklistSuffix = o.blacklisted ? ' [BLACKLISTED — on your do-not-apply list]' : '';
      log(`  + [${o.source}] ${posted} | ${o.company} | ${o.title} | ${o.location || 'N/A'}${blacklistSuffix}\n    ${o.url}`);
    }
  }

  let saved = false;
  if (offers.length && !opts.dryRun) {
    if (!existsSync(PIPELINE_PATH)) {
      mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
      writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n', 'utf-8');
    }
    await appendToPipeline(offers);
    await appendToScanHistory(offers, date);
    saved = true;
    log(`\nResults saved to ${PIPELINE_PATH} and data/scan-history.tsv`);

    if (opts.mdOut) {
      try {
        mkdirSync(opts.mdOut, { recursive: true });
        const digest = [
          `# Reverse ATS Scan — ${date}`,
          `> ${offers.length} jobs | since ${opts.sinceDays}d | ${opts.liveness ? 'liveness ✓' : 'no liveness check'}`,
          '',
          ...offers.map(o => {
            const posted = o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'n/a';
            return `- [${o.title} @ ${o.company}](${o.url}) — ${o.location || 'N/A'} | ${o.source} | ${posted}`;
          }),
          '',
        ].join('\n');
        writeFileSync(path.join(opts.mdOut, `${date}.md`), digest, 'utf-8');
        log(`Markdown digest saved to ${path.join(opts.mdOut, `${date}.md`)}`);
      } catch (err) {
        console.error(`⚠️  Could not write markdown digest: ${err.message}`);
      }
    }
  }

  if (!opts.dryRun && !stoppedByOutage && existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      date,
      sources: opts.ats,
      resumed: Boolean(checkpoint),
      sinceDays: opts.sinceDays,
      companiesAvailable: totalCompaniesAvailable,
      companiesScanned: totalCompaniesScanned,
      capHit,
      stoppedByOutage,
      datasetStatus,
      postingsKept: offers.length,
      postingsDroppedNoDate: droppedNoDate,
      postingsFilteredBlacklist: blacklistResult.filteredBlacklist,
      postingsAnnotatedBlacklisted: blacklistResult.annotatedBlacklisted,
      postingsDroppedContent: droppedContent,
      unreachableBoards: totalErrors,
      retiredBoardsSkipped: totalRetiredBoardsSkipped,
      cappedBoards,
      domainFilterActive: Boolean(domainFilter),
      domainGatedBoards,
      domainGatedPostings,
      dnsPacing: { delayed: pacing.delayed, waitedMs: Math.round(pacing.waitedMs) },
      saved,
      offers: offers.map(o => ({
        company: o.company,
        title: o.title,
        url: o.url,
        location: o.location || null,
        postedAt: o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : null,
        dateStatus: o.dateStatus || (o.postedAt ? 'dated' : 'unknown'),
        blacklisted: Boolean(o.blacklisted),
        note: o.note || null,
        source: o.source,
      })),
    }) + '\n');
    return;
  }

  if (!offers.length) {
    log('\nNothing new.');
    return;
  }
  if (opts.dryRun) {
    log('\n(dry run — run without --dry-run to save results)');
    return;
  }
  log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
