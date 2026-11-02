#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { renameSyncWithRetry } from './tracker-utils.mjs';

import { makeHttpCtx, isRefusedRedirectError } from './providers/_http.mjs';
import greenhouse from './providers/greenhouse.mjs';
import ashby from './providers/ashby.mjs';
import lever from './providers/lever.mjs';
import workday from './providers/workday.mjs';
import workable from './providers/workable.mjs';
import smartrecruiters from './providers/smartrecruiters.mjs';
import recruitee from './providers/recruitee.mjs';
import breezy from './providers/breezy.mjs';
import bamboohr from './providers/bamboohr.mjs';
import pinpoint from './providers/pinpoint.mjs';
import rippling from './providers/rippling.mjs';
import joinProvider from './providers/join.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { DEFAULT_SMALL_THRESHOLD, isSmallBoard, smallBoardDetail } from './lib/small-board.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');

export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_CONCURRENCY = 8;

const lower = (s) => String(s).toLowerCase();

const VENDORS = {
  gh:    { id: 'greenhouse', provider: greenhouse, host: 'job-boards.greenhouse.io', buildUrl: (s) => `https://job-boards.greenhouse.io/${s}`, api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs` },
  ashby: { id: 'ashby',      provider: ashby,      host: 'jobs.ashbyhq.com',        buildUrl: (s) => `https://jobs.ashbyhq.com/${s}` },
  lever: { id: 'lever',      provider: lever,      host: 'jobs.lever.co',           buildUrl: (s) => `https://jobs.lever.co/${s}` },

  workable:        { id: 'workable',        provider: workable,        host: 'apply.workable.com',          buildUrl: (s) => `https://apply.workable.com/${s}` },
  smartrecruiters: { id: 'smartrecruiters', provider: smartrecruiters, host: 'careers.smartrecruiters.com', buildUrl: (s) => `https://careers.smartrecruiters.com/${s}` },
  rippling:        { id: 'rippling',        provider: rippling,        host: 'ats.rippling.com',            buildUrl: (s) => `https://ats.rippling.com/${s}/jobs` },
  join:            { id: 'join',            provider: joinProvider,            host: 'join.com',                    buildUrl: (s) => `https://join.com/companies/${s}` },
  recruitee:       { id: 'recruitee',       provider: recruitee,       hostFor: (s) => `${lower(s)}.recruitee.com`,  buildUrl: (s) => `https://${lower(s)}.recruitee.com` },
  breezy:          { id: 'breezy',          provider: breezy,          hostFor: (s) => `${lower(s)}.breezy.hr`,      buildUrl: (s) => `https://${lower(s)}.breezy.hr` },
  bamboohr:        { id: 'bamboohr',        provider: bamboohr,        hostFor: (s) => `${lower(s)}.bamboohr.com`,   buildUrl: (s) => `https://${lower(s)}.bamboohr.com` },
  pinpoint:        { id: 'pinpoint',        provider: pinpoint,        hostFor: (s) => `${lower(s)}.pinpointhq.com`, buildUrl: (s) => `https://${lower(s)}.pinpointhq.com` },
};
const VENDOR_ORDER = ['gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'join'];

const WORKDAY_INSTANCES = ['wd1', 'wd2', 'wd3', 'wd5', 'wd10', 'wd12', 'wd101', 'wd103'];

const USAGE = `Usage:
  node discover-ats.mjs --in companies.yml            # PREVIEW — resolve + print entries, write nothing
  node discover-ats.mjs --in companies.yml --write    # opt in: append resolved entries to portals.yml
  node discover-ats.mjs Stripe Ramp Mollie            # company names as positional args
  node discover-ats.mjs --in companies.yml --summary  # human-readable table
  node discover-ats.mjs --in companies.yml --vendors gh,ashby,lever  # restrict probes
  node discover-ats.mjs --in companies.yml --vendors workday         # Workday only
  node discover-ats.mjs --in companies.yml --small-threshold 10  # what counts as a small board (default ${DEFAULT_SMALL_THRESHOLD}, 0 = off)
  node discover-ats.mjs --self-test                   # inline test suite
  node discover-ats.mjs --help                        # print this usage block

portals.yml is a user-layer file: this command NEVER writes it unless you pass
--write. The default previews the entries it would add (see pendingEntries).

Vendors: gh, ashby, lever, workable, smartrecruiters, recruitee, bamboohr,
breezy, pinpoint, rippling, join (all resolve from a name/slug) and workday
(resolves from a coordinate hint — a name alone can't locate a Workday site).
Default: all of them, probed in that order, first match wins.

Input YAML shape:
  companies:
    - name: Adyen
    - name: Monzo
      slug: monzo-bank      # optional explicit slug (needed for camelCase Ashby boards)
    - name: Mollie
      website: mollie.com   # optional; surfaced for unresolved companies
    # Workday — give a full careers URL ...
    - name: Nvidia
      workday: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
    # ... or the coordinates (instance auto-probed if omitted):
    - name: Salesforce
      workday: { tenant: salesforce, site: External_Career_Site }`;

export function deriveSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parseCompanyInput(rawYaml, cliNames = []) {
  const warnings = [];
  const byName = new Map();

  const add = (raw, origin) => {
    if (!raw || typeof raw !== 'object') {
      if (raw !== undefined && raw !== null) warnings.push(`${origin}: dropped non-object entry`);
      return;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      warnings.push(`${origin}: dropped entry with missing/empty name`);
      return;
    }
    const key = name.toLowerCase();
    if (byName.has(key)) return;
    const entry = { name };
    if (typeof raw.slug === 'string' && raw.slug.trim()) entry.slug = raw.slug.trim();
    if (typeof raw.website === 'string' && raw.website.trim()) entry.website = raw.website.trim();
    if (typeof raw.workday === 'string' && raw.workday.trim()) entry.workday = raw.workday.trim();
    else if (raw.workday && typeof raw.workday === 'object') entry.workday = raw.workday;
    else if (raw.workday !== undefined && raw.workday !== null && raw.workday !== '') {
      warnings.push(`${origin}: ignored "workday" hint for "${name}" — expected a URL string or {tenant, site} object`);
    }
    byName.set(key, entry);
  };

  if (rawYaml && rawYaml.trim()) {
    let doc;
    try {
      doc = yaml.load(rawYaml);
    } catch (err) {
      warnings.push(`input: malformed YAML — ${err.message}`);
      doc = null;
    }
    const list = Array.isArray(doc?.companies) ? doc.companies
      : (Array.isArray(doc) ? doc : null);
    if (doc && !list) {
      warnings.push('input: expected a top-level `companies:` list (or a bare YAML list)');
    }
    for (const item of list || []) {
      add(typeof item === 'string' ? { name: item } : item, 'input');
    }
  }

  for (const raw of cliNames) {
    if (typeof raw === 'string' && raw.trim()) add({ name: raw.trim() }, 'args');
  }

  return { companies: [...byName.values()], warnings };
}

export function buildCandidateUrls(company, vendors = VENDOR_ORDER) {
  const slug = company.slug || deriveSlug(company.name);
  const candidates = [];
  const skipped = [];
  const unsupported = [];
  for (const vendor of vendors) {
    const cfg = VENDORS[vendor];
    if (!cfg) continue;
    if (!SLUG_RE.test(slug)) {
      skipped.push(vendor);
      continue;
    }
    const careers_url = cfg.buildUrl(slug);
    let host;
    try { host = new URL(careers_url).hostname; } catch { host = null; }
    const expected = cfg.hostFor ? cfg.hostFor(slug) : cfg.host;
    if (host !== expected) {
      skipped.push(vendor);
      continue;
    }
    if (!cfg.provider.detect({ name: company.name, careers_url })) {
      unsupported.push(vendor);
      continue;
    }
    candidates.push({ vendor, slug, careers_url });
  }
  return { candidates, skipped, unsupported };
}

const WORKDAY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function parseWorkdayHint(company) {
  const clean = (v) => (typeof v === 'string' && WORKDAY_SEGMENT_RE.test(v) ? v : null);

  if (company.workday && typeof company.workday === 'object') {
    const tenant = clean(company.workday.tenant);
    const site = clean(company.workday.site);
    const instance = clean(company.workday.instance);
    if (tenant && site) return { tenant, instance: instance || null, site };
  }

  const urlCandidates = [company.workday, company.careers_url, company.website]
    .filter((v) => typeof v === 'string');
  for (const raw of urlCandidates) {
    const cxs = raw.match(/^https?:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/wday\/cxs\/[\w-]+\/([^/?#]+)(?:\/jobs)?(?:[/?#]|$)/);
    const m = cxs
      || raw.match(/^https?:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
    if (!m) continue;
    const [, tenant, instance, site] = m;
    if (clean(tenant) && clean(instance) && clean(site)) {
      return { tenant, instance, site };
    }
  }
  return null;
}

export function buildWorkdayCandidates(coords) {
  const instances = coords.instance ? [coords.instance] : WORKDAY_INSTANCES;
  return instances.map((instance) => ({
    instance,
    careers_url: `https://${coords.tenant}.${instance}.myworkdayjobs.com/${coords.site}`,
  }));
}

export function yamlScalar(value) {
  const s = String(value ?? '');
  const needsQuote = s === '' || /^[\s]|[\s]$/.test(s) || /[:#"'{}\[\],&*!|>%@`]/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderPortalEntry(match) {
  const lines = [`  - name: ${yamlScalar(match.name)}`];
  lines.push(`    careers_url: ${match.careers_url}`);
  if (match.api) lines.push(`    api: ${match.api}`);
  if (match.provider) lines.push(`    provider: ${match.provider}`);
  lines.push(`    enabled: true`);
  if (match.notes) lines.push(`    notes: ${yamlScalar(match.notes)}`);
  if (match.smallBoard) lines.push(`    # verify: ${smallBoardDetail(match.jobCount)}`);
  return '\n' + lines.join('\n') + '\n';
}

export function flagSmallBoards(resolved, threshold = DEFAULT_SMALL_THRESHOLD) {
  for (const r of resolved) {
    if (isSmallBoard(r.jobCount, threshold)) r.smallBoard = true;
  }
  return resolved;
}

function normalizeUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
}

export function dedupeAgainstPortals(matches, existingEntries) {
  const names = new Set();
  const urls = new Set();
  for (const e of Array.isArray(existingEntries) ? existingEntries : []) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name === 'string') names.add(e.name.trim().toLowerCase());
    if (e.careers_url) urls.add(normalizeUrl(e.careers_url));
    if (e.api) urls.add(normalizeUrl(e.api));
  }
  const fresh = [];
  const duplicates = [];
  for (const m of matches) {
    const nameKey = String(m.name || '').trim().toLowerCase();
    const urlKey = normalizeUrl(m.careers_url);
    const apiKey = m.api ? normalizeUrl(m.api) : null;
    const dup = names.has(nameKey) || urls.has(urlKey) || (apiKey && urls.has(apiKey));
    if (dup) {
      duplicates.push(m);
    } else {
      fresh.push(m);
      names.add(nameKey);
      urls.add(urlKey);
      if (apiKey) urls.add(apiKey);
    }
  }
  return { fresh, duplicates };
}

export function insertIntoTrackedCompanies(fileText, snippets) {
  if (!snippets.length) return fileText;
  const block = snippets.join('');

  const header = fileText.match(/^tracked_companies:[ \t]*$/m);
  if (!header) {
    const sep = fileText.endsWith('\n') ? '\n' : '\n\n';
    return `${fileText}${sep}tracked_companies:${block}`;
  }

  const headerEnd = header.index + header[0].length;
  const rest = fileText.slice(headerEnd);
  const boundary = rest.match(/\n[^\s#][^\n]*:/);
  const insertAt = boundary ? headerEnd + boundary.index : fileText.length;

  let before = fileText.slice(0, insertAt);
  const after = fileText.slice(insertAt);
  before = before.replace(/\n[ \t]*(?=\n*$)/g, (m2, off) => (off >= headerEnd ? '\n' : m2));

  return before + block + after;
}

export async function probeVendor(company, candidate, ctx) {
  const cfg = VENDORS[candidate.vendor];
  const entry = { name: company.name, careers_url: candidate.careers_url };
  if (!cfg || !cfg.provider.detect(entry)) {
    return { status: 'error', jobCount: 0, error: 'no API URL derivable' };
  }
  try {
    const jobs = await cfg.provider.fetch(entry, ctx);
    const jobCount = Array.isArray(jobs) ? jobs.length : 0;
    return { status: jobCount > 0 ? 'match' : 'empty', jobCount };
  } catch (err) {
    const out = { status: 'error', jobCount: 0, error: err?.message || String(err) };
    if (Number.isInteger(err?.status)) out.httpStatus = err.status;
    if (isRefusedRedirectError(err)) {
      out.refusedRedirect = true;
      out.error = `${out.error} (${err.cause.message})`;
    }
    return out;
  }
}

export function isDefinitiveAbsence(probeError) {
  return probeError?.httpStatus === 404 || probeError?.httpStatus === 410;
}

export async function resolveWorkday(company, coords, ctx) {
  const candidates = buildWorkdayCandidates(coords);
  const probeCtx = { ...ctx, maxPages: 1 };
  const tried = [];
  let emptyUrl = null;
  let lastError;
  let lastRefusedRedirect = false;

  for (const candidate of candidates) {
    tried.push(candidate.careers_url);
    const entry = { name: company.name, careers_url: candidate.careers_url };
    if (!workday.detect(entry)) { lastError = 'no CXS endpoint derivable'; continue; }
    try {
      const jobs = await workday.fetch(entry, probeCtx);
      const jobCount = Array.isArray(jobs) ? jobs.length : 0;
      if (jobCount > 0) {
        return {
          resolved: {
            name: company.name,
            vendor: 'workday',
            provider: 'workday',
            slug: coords.tenant,
            careers_url: candidate.careers_url,
            jobCount,
          },
        };
      }
      if (!emptyUrl) emptyUrl = candidate.careers_url;
    } catch (err) {
      lastError = err?.message || String(err);
      if (isRefusedRedirectError(err)) {
        lastError = `${lastError} (${err.cause.message})`;
        lastRefusedRedirect = true;
      } else {
        lastRefusedRedirect = false;
      }
    }
  }
  return emptyUrl
    ? { status: 'empty', tried, careers_url: emptyUrl }
    : { status: 'error', tried, detail: lastError, refusedRedirect: lastRefusedRedirect };
}

export async function resolveCompany(company, { vendors = VENDOR_ORDER, ctx, includeWorkday = true } = {}) {
  const { candidates, skipped, unsupported } = buildCandidateUrls(company, vendors);
  const triedVendors = [];
  const emptyBoards = [];
  const errors = [];

  for (const candidate of candidates) {
    triedVendors.push(candidate.vendor);
    const result = await probeVendor(company, candidate, ctx);
    if (result.status === 'match') {
      const cfg = VENDORS[candidate.vendor];
      const resolved = {
        name: company.name,
        vendor: cfg.id,
        slug: candidate.slug,
        careers_url: candidate.careers_url,
        jobCount: result.jobCount,
      };
      if (cfg.api) resolved.api = cfg.api(candidate.slug);
      return { resolved };
    }
    if (result.status === 'empty' && candidate.vendor === 'smartrecruiters') {
    } else if (result.status === 'empty') {
      emptyBoards.push({ vendor: candidate.vendor, careers_url: candidate.careers_url });
    } else {
      const entry = { vendor: candidate.vendor, error: result.error };
      if (Number.isInteger(result.httpStatus)) entry.httpStatus = result.httpStatus;
      if (result.refusedRedirect) entry.refusedRedirect = true;
      if (isDefinitiveAbsence(result)) entry.definitive = true;
      errors.push(entry);
    }
  }

  const coords = includeWorkday ? parseWorkdayHint(company) : null;
  if (coords) {
    triedVendors.push('workday');
    const wd = await resolveWorkday(company, coords, ctx);
    if (wd.resolved) return { resolved: wd.resolved };
    if (wd.status === 'empty') {
      emptyBoards.push({ vendor: 'workday', careers_url: wd.careers_url });
    } else if (wd.detail) {
      const wdEntry = { vendor: 'workday', error: wd.detail };
      if (wd.refusedRedirect) wdEntry.refusedRedirect = true;
      errors.push(wdEntry);
    }
  }

  const workdayHintProvided = includeWorkday
    && (typeof company.workday === 'string' ? !!company.workday.trim()
      : (company.workday && typeof company.workday === 'object'));
  const isSettled = (e) => isDefinitiveAbsence(e) || e.refusedRedirect === true;
  const reason = emptyBoards.length
    ? 'board(s) found but currently list 0 jobs — re-run later or force-add manually'
    : (errors.length && !coords && !errors.every(isSettled))
      ? 'probe error(s) occurred — board status unknown, see errors[] and re-run'
      : (errors.length && !coords && errors.some((e) => e.refusedRedirect))
        ? 'vendor(s) redirected off-tenant ('
          + errors.filter((e) => e.refusedRedirect).map((e) => e.vendor).join(', ')
          + ') — the slug is wrong, or no board exists under it. The same probe '
          + 'will redirect again, so set an explicit `slug` and re-run.'
        : (workdayHintProvided && !coords)
          ? 'Workday hint given but rejected (invalid/missing tenant or site) — check the `workday` field and re-run'
          : coords
            ? 'Workday coordinates given but no live board with open jobs found at the probed host(s).'
            : (!candidates.length && unsupported.length)
              ? `slug "${company.slug || deriveSlug(company.name)}" is not a valid board slug for any probed vendor `
                + `(${unsupported.join(', ')}) — nothing was probed; fix the \`slug\` field and re-run.`
              : 'no supported ATS board found. If this company uses Workday, add a hint — '
                + 'a full careers URL (workday: https://<tenant>.wd<N>.myworkdayjobs.com/<site>) or '
                + 'workday: {tenant, site} — and re-run; discover-ats will confirm and add it.';

  const unresolved = { name: company.name, triedVendors, reason };
  if (skipped.length) unresolved.skippedUnsafeSlug = skipped;
  if (unsupported.length) unresolved.unsupportedSlugShape = unsupported;
  if (emptyBoards.length) unresolved.emptyBoards = emptyBoards;
  if (errors.length) unresolved.errors = errors;
  if (company.website) unresolved.website = company.website;
  return { unresolved };
}

async function parallelEach(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export async function runDiscovery(companies, { vendors = VENDOR_ORDER, ctx, concurrency = DEFAULT_CONCURRENCY, includeWorkday = true } = {}) {
  const results = new Array(companies.length);
  const httpCtx = ctx || makeHttpCtx();
  await parallelEach(companies, concurrency, async (company, idx) => {
    results[idx] = await resolveCompany(company, { vendors, ctx: httpCtx, includeWorkday });
  });
  const resolved = [];
  const unresolved = [];
  for (const r of results) {
    if (r?.resolved) resolved.push(r.resolved);
    else if (r?.unresolved) unresolved.push(r.unresolved);
  }
  return { resolved, unresolved };
}

function printSummary({ resolved, unresolved, duplicates }) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  ATS Discovery — career-ops');
  console.log(`  resolved: ${resolved.length} | unresolved: ${unresolved.length} | duplicates skipped: ${duplicates.length}`);
  console.log(`${'='.repeat(78)}\n`);

  if (resolved.length) {
    console.log('  ' + 'Company'.padEnd(24) + 'Vendor'.padEnd(12) + 'Jobs'.padEnd(7) + 'Board');
    console.log('  ' + '-'.repeat(90));
    for (const r of resolved) {
      console.log('  ' + String(r.name).substring(0, 22).padEnd(24)
        + String(r.vendor).padEnd(12) + String(r.jobCount).padEnd(7) + r.careers_url
        + (r.smallBoard ? `  [small board — verify ownership]` : ''));
    }
    console.log('');
  }

  if (unresolved.length) {
    console.log('  Unresolved (manual follow-up):');
    for (const u of unresolved) {
      const site = u.website ? ` [${u.website}]` : '';
      console.log(`    - ${u.name}${site}: ${u.reason}`);
    }
    console.log('');
  }
}

function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  check(deriveSlug('Trade Republic') === 'trade-republic', 'deriveSlug spaces → dashes');
  check(deriveSlug('  N8N!  ') === 'n8n', 'deriveSlug trims + strips punctuation');
  check(deriveSlug('Adyen') === 'adyen', 'deriveSlug simple lowercases');

  const p1 = parseCompanyInput('companies:\n  - name: Adyen\n  - name: Monzo\n    slug: monzo-bank\n', ['Ramp']);
  check(p1.companies.length === 3, 'parseCompanyInput merges file + CLI names');
  check(p1.companies[1].slug === 'monzo-bank', 'parseCompanyInput keeps explicit slug');
  const p2 = parseCompanyInput('companies:\n  - name: Adyen\n', ['adyen']);
  check(p2.companies.length === 1, 'parseCompanyInput dedupes by lowercased name');
  const p3 = parseCompanyInput(': : not valid yaml : :\n[', []);
  check(p3.companies.length === 0 && p3.warnings.length > 0, 'parseCompanyInput warns on malformed YAML, never throws');
  const p4 = parseCompanyInput('companies:\n  - name: ""\n  - slug: x\n', []);
  check(p4.companies.length === 0, 'parseCompanyInput drops nameless entries');

  const b1 = buildCandidateUrls({ name: 'Adyen' });
  check(b1.candidates.length === VENDOR_ORDER.length, 'buildCandidateUrls emits one candidate per vendor');
  check(b1.candidates[0].vendor === 'gh' && b1.candidates[0].careers_url === 'https://job-boards.greenhouse.io/adyen', 'buildCandidateUrls GH url');
  check(b1.candidates.slice(0, 3).map((c) => c.vendor).join(',') === 'gh,ashby,lever', 'buildCandidateUrls probes the common vendors first');
  const b2 = buildCandidateUrls({ name: 'X', slug: 'bad/slug' });
  check(b2.candidates.length === 0 && b2.skipped.length === VENDOR_ORDER.length, 'buildCandidateUrls SLUG_RE rejects unsafe slug (no URL built)');

  const byVendor = Object.fromEntries(b1.candidates.map((c) => [c.vendor, c.careers_url]));
  check(byVendor.workable === 'https://apply.workable.com/adyen', 'buildCandidateUrls workable url');
  check(byVendor.smartrecruiters === 'https://careers.smartrecruiters.com/adyen', 'buildCandidateUrls smartrecruiters url');
  check(byVendor.rippling === 'https://ats.rippling.com/adyen/jobs', 'buildCandidateUrls rippling url');
  check(byVendor.join === 'https://join.com/companies/adyen', 'buildCandidateUrls join url');
  check(byVendor.recruitee === 'https://adyen.recruitee.com', 'buildCandidateUrls recruitee subdomain url');
  check(byVendor.breezy === 'https://adyen.breezy.hr', 'buildCandidateUrls breezy subdomain url');
  check(byVendor.bamboohr === 'https://adyen.bamboohr.com', 'buildCandidateUrls bamboohr subdomain url');
  check(byVendor.pinpoint === 'https://adyen.pinpointhq.com', 'buildCandidateUrls pinpoint subdomain url');
  check(
    b1.candidates.every((c) => !!VENDORS[c.vendor].provider.detect({ name: 'Adyen', careers_url: c.careers_url })),
    'every built candidate URL is recognized by its provider detect()',
  );
  const bMixed = buildCandidateUrls({ name: 'DeepL', slug: 'DeepL' });
  const mixed = Object.fromEntries(bMixed.candidates.map((c) => [c.vendor, c.careers_url]));
  check(mixed.ashby === 'https://jobs.ashbyhq.com/DeepL', 'buildCandidateUrls preserves slug case for Ashby');
  check(mixed.recruitee === 'https://deepl.recruitee.com', 'buildCandidateUrls lowercases a subdomain host');
  check(bMixed.skipped.length === 0, 'a mixed-case slug is not skipped by the host assertion');

  const SUBDOMAIN_VENDORS = ['recruitee', 'breezy', 'bamboohr', 'pinpoint'];
  const bDot = buildCandidateUrls({ name: 'X', slug: 'foo.bar' });
  const dotCandidates = new Set(bDot.candidates.map((c) => c.vendor));
  check(
    SUBDOMAIN_VENDORS.every((v) => !dotCandidates.has(v) && bDot.unsupported.includes(v)),
    'a dotted slug is unsupported for every subdomain vendor, never a candidate',
  );
  check(bDot.skipped.length === 0, 'a dotted slug is an unsupported shape, not an unsafe-slug skip');
  check(
    bDot.candidates.length > 0
      && bDot.candidates.every((c) => !!VENDORS[c.vendor].provider.detect({ name: 'X', careers_url: c.careers_url })),
    'a dotted slug still probes the vendors whose contract accepts it',
  );
  const SUBDOMAIN_SUFFIX = {
    recruitee: '.recruitee.com', breezy: '.breezy.hr', bamboohr: '.bamboohr.com', pinpoint: '.pinpointhq.com',
  };
  let offDomain = 0;
  for (const s of ['foo.bar', 'evil.com', 'a.b.c.d', '..evil.com', 'x.bamboohr.com', '169.254.169.254']) {
    for (const c of buildCandidateUrls({ name: 'X', slug: s }, SUBDOMAIN_VENDORS).candidates) {
      if (!new URL(c.careers_url).hostname.endsWith(SUBDOMAIN_SUFFIX[c.vendor])) offDomain += 1;
    }
  }
  check(offDomain === 0, 'no slug can move a subdomain-vendor host off the vendor domain');

  const b3 = buildCandidateUrls({ name: 'Adyen' }, ['ashby']);
  check(b3.candidates.length === 1 && b3.candidates[0].vendor === 'ashby', 'buildCandidateUrls honors vendor subset');

  const gh = renderPortalEntry({ name: 'Adyen', careers_url: 'https://job-boards.greenhouse.io/adyen', api: 'https://boards-api.greenhouse.io/v1/boards/adyen/jobs' });
  check(gh.includes('  - name: Adyen') && gh.includes('    api: https://boards-api.greenhouse.io/v1/boards/adyen/jobs'), 'renderPortalEntry GH includes api line');
  const lv = renderPortalEntry({ name: 'Mistral AI', careers_url: 'https://jobs.lever.co/mistral' });
  check(!lv.includes('api:'), 'renderPortalEntry non-GH omits api line');
  const q = renderPortalEntry({ name: 'Foo: Bar', careers_url: 'https://jobs.ashbyhq.com/foo' });
  check(q.includes('name: "Foo: Bar"'), 'renderPortalEntry quotes name with colon');

  const sb = flagSmallBoards([{ name: 'A', jobCount: 1 }, { name: 'B', jobCount: 6 }]);
  check(sb[0].smallBoard === true && sb[1].smallBoard === undefined, 'flagSmallBoards flags only boards at or under the threshold');
  check(renderPortalEntry({ name: 'A', careers_url: 'https://x', smallBoard: true, jobCount: 1 }).includes('# verify:'), 'renderPortalEntry adds # verify: for a small board');
  check(!renderPortalEntry({ name: 'B', careers_url: 'https://x', jobCount: 6 }).includes('# verify:'), 'renderPortalEntry omits # verify: for a larger board');

  const existing = [{ name: 'Adyen', careers_url: 'https://job-boards.greenhouse.io/adyen/' }];
  const d1 = dedupeAgainstPortals([{ name: 'Adyen', careers_url: 'x' }], existing);
  check(d1.duplicates.length === 1 && d1.fresh.length === 0, 'dedupe by name hit');
  const d2 = dedupeAgainstPortals([{ name: 'Other', careers_url: 'https://job-boards.greenhouse.io/adyen' }], existing);
  check(d2.duplicates.length === 1, 'dedupe by careers_url hit (trailing slash normalized)');
  const d3 = dedupeAgainstPortals([{ name: 'A', careers_url: 'u1' }, { name: 'A', careers_url: 'u2' }], []);
  check(d3.fresh.length === 1, 'dedupe self-dedupes within fresh');

  const doc = 'title_filter:\n  positive: [a]\n\ntracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n\njob_boards:\n  - name: Foo\n';
  const snippet = renderPortalEntry({ name: 'New', careers_url: 'https://jobs.lever.co/new' });
  const inserted = insertIntoTrackedCompanies(doc, [snippet]);
  check(inserted.indexOf('- name: New') < inserted.indexOf('job_boards:'), 'insert lands before job_boards:');
  check(inserted.indexOf('- name: New') > inserted.indexOf('tracked_companies:'), 'insert lands after tracked_companies:');
  check(inserted.startsWith('title_filter:\n  positive: [a]\n'), 'insert preserves leading bytes');
  check(inserted.includes('job_boards:\n  - name: Foo\n'), 'insert preserves trailing block');
  const parsed = yaml.load(inserted);
  const again = dedupeAgainstPortals([{ name: 'New', careers_url: 'https://jobs.lever.co/new' }], parsed.tracked_companies);
  check(again.fresh.length === 0, 'insert is idempotent through dedupe');

  const noHeader = insertIntoTrackedCompanies('title_filter:\n  positive: [a]\n', [snippet]);
  check(/tracked_companies:/.test(noHeader) && noHeader.includes('- name: New'), 'insert appends fresh block when header missing');

  const emptyBlock = insertIntoTrackedCompanies('tracked_companies:\njob_boards:\n  - name: Foo\n', [snippet]);
  check(emptyBlock.indexOf('- name: New') < emptyBlock.indexOf('job_boards:'), 'insert handles empty block');

  const wh1 = parseWorkdayHint({ name: 'Nvidia', workday: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' });
  check(wh1 && wh1.tenant === 'nvidia' && wh1.instance === 'wd5' && wh1.site === 'NVIDIAExternalCareerSite', 'parseWorkdayHint parses full URL');
  const wh1b = parseWorkdayHint({ name: 'X', careers_url: 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/foo' });
  check(wh1b && wh1b.tenant === 'acme' && wh1b.instance === 'wd3' && wh1b.site === 'Careers', 'parseWorkdayHint strips locale + trailing path');
  const wh2 = parseWorkdayHint({ name: 'Salesforce', workday: { tenant: 'salesforce', site: 'External_Career_Site' } });
  check(wh2 && wh2.tenant === 'salesforce' && wh2.instance === null && wh2.site === 'External_Career_Site', 'parseWorkdayHint object form, null instance');
  check(parseWorkdayHint({ name: 'Adyen' }) === null, 'parseWorkdayHint returns null without hint');
  check(parseWorkdayHint({ name: 'X', workday: { tenant: 'bad/tenant', site: 'S' } }) === null, 'parseWorkdayHint rejects unsafe segment');

  const wc1 = buildWorkdayCandidates({ tenant: 'nvidia', instance: 'wd5', site: 'NVIDIAExternalCareerSite' });
  check(wc1.length === 1 && wc1[0].careers_url === 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'buildWorkdayCandidates known instance → single URL');
  const wc2 = buildWorkdayCandidates({ tenant: 'salesforce', instance: null, site: 'External_Career_Site' });
  check(wc2.length === WORKDAY_INSTANCES.length && wc2[0].careers_url.includes('salesforce.wd1.'), 'buildWorkdayCandidates null instance → expands across instances');

  const wdEntry = renderPortalEntry({ name: 'Nvidia', careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', provider: 'workday' });
  check(wdEntry.includes('    provider: workday') && !wdEntry.includes('api:'), 'renderPortalEntry emits provider: workday, no api line');

  console.log(`\n  discover-ats self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

const KNOWN_FLAGS = ['--in', '--vendors', '--small-threshold', '--write', '--dry-run', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--in', '--vendors', '--small-threshold'];

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const consumedValueIndices = new Set();
  args.forEach((a, idx) => {
    if (VALUE_FLAGS.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });

  const unknownFlags = args.filter((a, idx) =>
    a.startsWith('-') && !consumedValueIndices.has(idx) && !KNOWN_FLAGS.includes(a.split('=')[0]));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    process.exit(1);
  }

  const valueOf = (flag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const kv = args.find((a) => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : null;
  };

  const vendorsArg = valueOf('--vendors');
  const requested = vendorsArg
    ? vendorsArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [...VENDOR_ORDER, 'workday'];
  const validVendors = new Set([...VENDOR_ORDER, 'workday']);
  const unknownVendors = requested.filter((v) => !validVendors.has(v));
  if (unknownVendors.length) {
    console.error(`Error: unknown vendor(s): ${unknownVendors.join(', ')}. Valid: ${[...validVendors].join(', ')}`);
    process.exit(1);
  }
  const vendors = requested.filter((v) => VENDORS[v]);
  const includeWorkday = requested.includes('workday');

  const names = args.filter((a, idx) => !a.startsWith('-') && !consumedValueIndices.has(idx));

  const rawThreshold = valueOf('--small-threshold');
  const smallThreshold = rawThreshold === null ? DEFAULT_SMALL_THRESHOLD : Number(rawThreshold);
  if (!Number.isFinite(smallThreshold) || smallThreshold < 0 || String(rawThreshold).trim() === '') {
    console.error(`Error: --small-threshold expects a non-negative number, got "${rawThreshold}"`);
    process.exit(1);
  }

  return {
    smallThreshold,
    inPath: valueOf('--in'),
    vendors,
    includeWorkday,
    write: args.includes('--write'),
    summary: args.includes('--summary'),
    selfTest: args.includes('--self-test'),
    names,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) runSelfTest();

  let rawYaml = '';
  if (opts.inPath) {
    const path = resolve(process.cwd(), opts.inPath);
    if (!existsSync(path)) {
      console.error(`Error: input file not found: ${opts.inPath}`);
      process.exit(1);
    }
    rawYaml = readFileSync(path, 'utf-8');
  }

  const { companies, warnings } = parseCompanyInput(rawYaml, opts.names);

  if (companies.length === 0) {
    const out = {
      metadata: {
        resolved: 0, unresolved: 0, duplicatesSkipped: 0, fresh: 0, freshWritten: 0,
        written: false, previewOnly: true, portalsPath: PORTALS_PATH, warnings,
      },
      resolved: [], unresolved: [],
    };
    if (opts.summary) printSummary({ resolved: [], unresolved: [], duplicates: [] });
    else console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const { resolved, unresolved } = await runDiscovery(companies, { vendors: opts.vendors, includeWorkday: opts.includeWorkday });
  flagSmallBoards(resolved, opts.smallThreshold);

  let existingEntries = [];
  if (existsSync(PORTALS_PATH)) {
    try {
      const parsed = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
      existingEntries = Array.isArray(parsed?.tracked_companies) ? parsed.tracked_companies : [];
    } catch (err) {
      warnings.push(`portals.yml: could not parse for dedupe — ${err.message}`);
    }
  }
  const { fresh, duplicates } = dedupeAgainstPortals(resolved, existingEntries);
  const snippets = fresh.map(renderPortalEntry);

  let written = false;
  if (opts.write && fresh.length && existsSync(PORTALS_PATH)) {
    const current = readFileSync(PORTALS_PATH, 'utf-8');
    const tmpPath = `${PORTALS_PATH}.tmp-${process.pid}`;
    writeFileSync(tmpPath, insertIntoTrackedCompanies(current, snippets), 'utf-8');
    renameSyncWithRetry(tmpPath, PORTALS_PATH);
    written = true;
  } else if (opts.write && fresh.length && !existsSync(PORTALS_PATH)) {
    warnings.push(`--write given but portals.yml not found at ${PORTALS_PATH} — printing entries instead`);
  } else if (!opts.write && fresh.length) {
    warnings.push(`preview only — ${fresh.length} new entr${fresh.length === 1 ? 'y' : 'ies'} shown in pendingEntries; re-run with --write to append them to portals.yml`);
  }

  const metadata = {
    resolved: resolved.length,
    unresolved: unresolved.length,
    duplicatesSkipped: duplicates.length,
    fresh: fresh.length,
    freshWritten: written ? fresh.length : 0,
    written,
    previewOnly: !written,
    portalsPath: PORTALS_PATH,
    warnings,
  };

  if (opts.summary) {
    printSummary({ resolved, unresolved, duplicates });
  } else {
    const out = { metadata, resolved, unresolved };
    if (!written) out.pendingEntries = snippets.join('');
    console.log(JSON.stringify(out, null, 2));
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`discover-ats: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
