#!/usr/bin/env node

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  normalizeUrlForDedup,
  buildTitleFilter,
  buildLocationFilter,
  buildContentFilter,
  buildCountryEligibilityFilter,
  buildVisaFilter,
  loadCandidateCountry,
  matchedTitleKeywords,
  loadBlacklist,
  PORTALS_PATH,
} from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { htmlToText } from './providers/_html-to-text.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { BOT_CHALLENGE_PATTERNS } from './liveness-core.mjs';

export const ALLOWED_HOST = 'jobs.dayforcehcm.com';
const DEFAULT_BOARD_CODE = 'CANDIDATEPORTAL';
const DEFAULT_CULTURE = 'en-US';
const DEFAULT_JOB_BOARD_ID = '1';
const MAX_PAGES_PER_BOARD = 200;
const RETRY_DELAY_MS = 3000;

const DATA_ROOT = getCareerOpsRoot();

const TENANT_RE = /^[A-Za-z0-9_-]+$/;
const BOARD_CODE_RE = /^[A-Za-z0-9_-]+$/;
const CULTURE_RE = /^[a-z]{2}-[A-Z]{2}$/;
const JOB_BOARD_ID_RE = /^\d+$/;
const JOB_POSTING_ID_RE = /^\d+$/;

const INTERSTITIAL_SELECTORS = ['#challenge-form', '#challenge-stage'];

const CHALLENGE_WIDGETS = [
  { selector: '.cf-turnstile', response: 'cf-turnstile-response' },
  { selector: '.h-captcha', response: 'h-captcha-response' },
];

export class DayforceChallengeError extends Error {
  constructor(tenant, board, signal) {
    super(`board ${tenant}/${board} is behind an interactive challenge (${signal}) — skipped, not retried`);
    this.name = 'DayforceChallengeError';
    this.tenant = tenant;
    this.retriable = false;
  }
}

export async function detectChallenge(page) {
  const title = await page.title().catch(() => '');
  if (BOT_CHALLENGE_PATTERNS.some(re => re.test(title))) return `title "${title}"`;
  for (const selector of INTERSTITIAL_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return `element ${selector}`;
  }
  for (const { selector, response } of CHALLENGE_WIDGETS) {
    const widgets = page.locator(selector);
    const count = await widgets.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const widget = widgets.nth(i);
      if (!(await widget.isVisible().catch(() => false))) continue;
      const token = await widget
        .evaluate((el, name) => el.querySelector(`[name="${name}"]`)?.value ?? '', response)
        .catch(() => '');
      if (!token) return `unsolved ${selector} widget`;
    }
  }
  return null;
}

export function validateTenant(v) {
  return typeof v === 'string' && TENANT_RE.test(v);
}

export function validateBoardCode(v) {
  return typeof v === 'string' && BOARD_CODE_RE.test(v);
}

export function validateCulture(v) {
  return typeof v === 'string' && CULTURE_RE.test(v);
}

export function validateJobBoardId(v) {
  return typeof v === 'string' && JOB_BOARD_ID_RE.test(v);
}

export function validateJobPostingId(v) {
  const s = typeof v === 'number' ? String(v) : v;
  return typeof s === 'string' && JOB_POSTING_ID_RE.test(s);
}

export function normalizeBoardEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const tenant = entry.tenant;
  const board = entry.board || entry.jobBoardCode || DEFAULT_BOARD_CODE;
  const culture = entry.culture || DEFAULT_CULTURE;
  const jobBoardId = entry.jobBoardId !== undefined && entry.jobBoardId !== null
    ? String(entry.jobBoardId)
    : DEFAULT_JOB_BOARD_ID;

  if (!name) return null;
  if (!validateTenant(tenant)) return null;
  if (!validateBoardCode(board)) return null;
  if (!validateCulture(culture)) return null;
  if (!validateJobBoardId(jobBoardId)) return null;

  return { name, tenant, board, culture, jobBoardId };
}

export function assertDayforceUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_HOST) {
    throw new Error(`Refusing non-Dayforce URL: ${url}`);
  }
  return parsed;
}

export function buildBoardUrl(culture, tenant, board) {
  const url = `https://${ALLOWED_HOST}/${culture}/${tenant}/${board}`;
  assertDayforceUrl(url);
  return url;
}

export function buildJobUrl(culture, tenant, board, jobPostingId) {
  const url = `https://${ALLOWED_HOST}/${culture}/${tenant}/${board}/jobs/${jobPostingId}`;
  assertDayforceUrl(url);
  return url;
}

export function buildCsrfUrl() {
  return `https://${ALLOWED_HOST}/api/auth/csrf`;
}

export function buildSearchUrl(tenant) {
  const url = `https://${ALLOWED_HOST}/api/geo/${tenant}/jobposting/search`;
  assertDayforceUrl(url);
  return url;
}

export function buildDetailUrl(tenant, culture, jobBoardId, jobPostingId) {
  const url = `https://${ALLOWED_HOST}/api/geo/${tenant}/jobposting/${tenant}/${culture}/${jobBoardId}/${jobPostingId}`;
  assertDayforceUrl(url);
  return url;
}

export function nextPaginationStart(offset, count, maxCount) {
  if (!Number.isFinite(offset) || !Number.isFinite(count) || !Number.isFinite(maxCount)) return null;
  if (count <= 0) return null;
  const next = offset + count;
  if (next >= maxCount) return null;
  return next;
}

export function joinLocations(postingLocations) {
  if (!Array.isArray(postingLocations) || postingLocations.length === 0) return '';
  const parts = postingLocations.map(loc => {
    if (!loc || typeof loc !== 'object') return '';
    if (typeof loc.formattedAddress === 'string' && loc.formattedAddress.trim()) {
      return loc.formattedAddress.trim();
    }
    return [loc.cityName, loc.stateCode, loc.isoCountryCode].filter(Boolean).join(', ');
  }).filter(Boolean);
  return parts.join(' | ');
}

export function buildJobDescriptionText(content) {
  if (!content || typeof content !== 'object') return '';
  const pieces = [content.jobDescriptionHeader, content.jobDescription, content.jobDescriptionFooter]
    .filter(p => typeof p === 'string' && p.trim());
  return htmlToText(pieces.join('\n\n'));
}

export function parseArgs(argv = process.argv.slice(2)) {
  const tenantIdx = argv.indexOf('--tenant');
  if (tenantIdx !== -1 && (argv[tenantIdx + 1] === undefined || argv[tenantIdx + 1].startsWith('--'))) {
    throw new Error('--tenant requires a value, e.g. --tenant gnghcm');
  }
  return {
    dryRun: argv.includes('--dry-run'),
    debug: argv.includes('--debug'),
    singleTenant: tenantIdx !== -1 ? argv[tenantIdx + 1] : null,
  };
}

export function loadConfig(portalsPath = PORTALS_PATH, singleTenant = null) {
  let config = {};
  if (existsSync(portalsPath)) {
    config = yaml.load(readFileSync(portalsPath, 'utf-8')) || {};
  }

  const rawBoards = Array.isArray(config.dayforce_boards) ? config.dayforce_boards : [];
  const normalizedBoards = rawBoards.map(normalizeBoardEntry);
  const invalidCount = normalizedBoards.filter(board => !board).length;
  const blacklist = loadBlacklist();
  const validBoards = normalizedBoards.filter(Boolean)
    .filter(board => !blacklist.has(normalizeCompany(board.name)));
  const boards = validBoards.filter(b => !singleTenant || b.tenant === singleTenant);
  const filters = {
    titleFilter: buildTitleFilter(config.title_filter),
    locationFilter: buildLocationFilter(config.location_filter),
    contentFilter: buildContentFilter(config.content_filter),
    countryEligibilityFilter: buildCountryEligibilityFilter(
      config.country_eligibility_filter,
      loadCandidateCountry(),
    ),
    visaFilter: buildVisaFilter(config.visa_filter),
    matchedTitleKeywords: (title) => matchedTitleKeywords(title, config.title_filter),
  };

  return { boards, invalidCount, filters };
}

async function fetchCsrfToken(page) {
  const resp = await page.request.get(buildCsrfUrl(), { maxRedirects: 0 });
  if (!resp.ok()) throw new Error(`csrf fetch failed: HTTP ${resp.status()}`);
  const json = await resp.json();
  if (!json || typeof json.csrfToken !== 'string' || !json.csrfToken) {
    throw new Error('csrf response missing csrfToken');
  }
  return json.csrfToken;
}

async function fetchSearchPage(page, boardCfg, csrfToken, paginationStart) {
  const resp = await page.request.post(buildSearchUrl(boardCfg.tenant), {
    maxRedirects: 0,
    headers: { 'X-CSRF-TOKEN': csrfToken, 'Content-Type': 'application/json' },
    data: {
      clientNamespace: boardCfg.tenant,
      jobBoardCode: boardCfg.board,
      cultureCode: boardCfg.culture,
      distanceUnit: 0,
      paginationStart,
    },
  });
  if (resp.status() === 403 || resp.status() === 429) {
    const err = new Error(`search HTTP ${resp.status()}`);
    err.retriable = true;
    throw err;
  }
  if (!resp.ok()) throw new Error(`search fetch failed: HTTP ${resp.status()}`);
  return resp.json();
}

async function fetchDetail(page, boardCfg, jobPostingId) {
  const resp = await page.request.get(buildDetailUrl(boardCfg.tenant, boardCfg.culture, boardCfg.jobBoardId, jobPostingId), { maxRedirects: 0 });
  if (resp.status() === 404 || resp.status() === 410) return null;
  if (resp.status() === 403 || resp.status() === 429) {
    const err = new Error(`detail HTTP ${resp.status()}`);
    err.retriable = true;
    throw err;
  }
  if (!resp.ok()) throw new Error(`detail fetch failed: HTTP ${resp.status()}`);
  return resp.json();
}

export async function scanBoard(page, boardCfg, filters = {}, { debug = false } = {}) {
  filters = {
    titleFilter: () => true,
    locationFilter: () => true,
    contentFilter: () => true,
    countryEligibilityFilter: () => true,
    visaFilter: () => true,
    matchedTitleKeywords: () => [],
    ...filters,
  };
  const found = [];
  const boardUrl = buildBoardUrl(boardCfg.culture, boardCfg.tenant, boardCfg.board);

  try {
    await page.goto(boardUrl, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    const challenge = await detectChallenge(page);
    if (challenge) throw new DayforceChallengeError(boardCfg.tenant, boardCfg.board, challenge);
    throw err;
  }

  if (debug) {
    const debugDir = join(DATA_ROOT, 'output');
    mkdirSync(debugDir, { recursive: true });
    const debugPng = join(debugDir, `debug-dayforce-${boardCfg.tenant}.png`);
    await page.screenshot({ path: debugPng, fullPage: true }).catch(() => null);
    console.log(`  [debug] screenshot → ${debugPng}`);
    console.log(`  [debug] url: ${page.url()}`);
  }

  const challenge = await detectChallenge(page);
  if (challenge) throw new DayforceChallengeError(boardCfg.tenant, boardCfg.board, challenge);

  const csrfToken = await fetchCsrfToken(page);

  let paginationStart = 0;
  let pageCount = 0;
  const listRows = [];

  while (pageCount < MAX_PAGES_PER_BOARD) {
    const data = await fetchSearchPage(page, boardCfg, csrfToken, paginationStart);
    const rows = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    listRows.push(...rows);
    pageCount++;

    const next = nextPaginationStart(Number(data.offset), Number(data.count), Number(data.maxCount));
    if (next === null) break;
    paginationStart = next;
  }
  if (debug) console.log(`  [debug] ${boardCfg.tenant}: ${listRows.length} listing row(s) across ${pageCount} page(s)`);

  const shortlisted = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const contentSkipped = [];
  const countryEligibilitySkipped = [];
  const visaSkipped = [];

  for (const row of listRows) {
    const title = decodeEntities(String(row.jobTitle || row.title || '')).trim();
    const jobPostingId = row.jobPostingId ?? row.id;
    if (!title || !validateJobPostingId(jobPostingId)) continue;

    const listLocation = joinLocations(row.postingLocations);
    const listDescription = htmlToText(row.jobDescription || '');
    const url = buildJobUrl(boardCfg.culture, boardCfg.tenant, boardCfg.board, jobPostingId);

    const skipped = { title, url, location: listLocation };
    if (!filters.titleFilter(title)) { titleSkipped.push(skipped); continue; }
    if (!filters.locationFilter(listLocation, url, title)) { locationSkipped.push(skipped); continue; }
    if (!filters.contentFilter(listDescription, filters.matchedTitleKeywords(title))) { contentSkipped.push(skipped); continue; }
    if (!filters.countryEligibilityFilter(listDescription)) { countryEligibilitySkipped.push(skipped); continue; }
    if (!filters.visaFilter(listDescription)) { visaSkipped.push(skipped); continue; }

    shortlisted.push({ jobPostingId, title, listLocation, listDescription, url });
  }

  for (const item of shortlisted) {
    const detail = await fetchDetail(page, boardCfg, item.jobPostingId);
    if (!detail) continue;

    const description = buildJobDescriptionText(detail.jobPostingContent) || item.listDescription;
    const location = joinLocations(detail.postingLocations) || item.listLocation;
    const postedAt = detail.postingStartTimestampUTC ? Date.parse(detail.postingStartTimestampUTC) : undefined;

    found.push({
      url: item.url,
      company: boardCfg.name,
      title: decodeEntities(String(detail.jobTitle || item.title)),
      location,
      source: 'dayforce',
      description,
      postedAt: Number.isFinite(postedAt) ? postedAt : undefined,
    });
  }

  return {
    found,
    titleSkipped,
    locationSkipped,
    contentSkipped,
    countryEligibilitySkipped,
    visaSkipped,
    totalFound: listRows.length,
  };
}

export async function scanBoardWithRetry(boardCfg, filters, {
  debug = false,
  launch = () => chromium.launch({ headless: true }),
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let browser = null;
    let context = null;
    try {
      browser = await launch();
      context = await browser.newContext();
      const page = await context.newPage();
      return { result: await scanBoard(page, boardCfg, filters, { debug }), error: null };
    } catch (err) {
      lastError = err;
      if (!(err && err.retriable) || attempt === 2) break;
      if (debug) console.log(`\n  [debug] ${boardCfg.tenant}: ${err.message} — re-bootstrapping session and retrying once`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
  return { result: null, error: lastError };
}

async function main() {
  const { dryRun, debug, singleTenant } = parseArgs();
  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
  const { boards, invalidCount, filters } = loadConfig(PORTALS_PATH, singleTenant);

  if (invalidCount > 0) {
    console.log(`  Skipping ${invalidCount} malformed dayforce_boards entr${invalidCount === 1 ? 'y' : 'ies'} (bad tenant/board/culture/jobBoardId)`);
  }
  if (boards.length === 0) {
    console.log('  No dayforce_boards configured in portals.yml (or none matched --tenant). Nothing to scan.');
    console.log('  Add a dayforce_boards: section — see scan-dayforce.mjs header comment for the shape.');
    return;
  }

  const { seen } = loadSeenUrls();
  const date = localToday();

  let totalFound = 0;
  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const contentSkipped = [];
  const countryEligibilitySkipped = [];
  const visaSkipped = [];
  const dupeSkipped = [];
  const errors = [];

  for (const boardCfg of boards) {
    process.stdout.write(`  Scanning ${boardCfg.tenant}/${boardCfg.board}... `);

    const { result, error } = await scanBoardWithRetry(boardCfg, filters, { debug });

    if (!result) {
      errors.push({ tenant: boardCfg.tenant, error: error?.message ?? String(error) });
      process.stdout.write(error instanceof DayforceChallengeError ? 'SKIPPED (interactive challenge)\n' : 'ERROR\n');
      continue;
    }

    totalFound += result.totalFound;
    process.stdout.write(`${result.totalFound} found, ${result.found.length} passed filters\n`);

    for (const skip of result.titleSkipped) { seen.add(normalizeUrlForDedup(skip.url)); titleSkipped.push({ ...skip, source: 'dayforce', company: boardCfg.name }); }
    for (const skip of result.locationSkipped) { seen.add(normalizeUrlForDedup(skip.url)); locationSkipped.push({ ...skip, source: 'dayforce', company: boardCfg.name }); }
    for (const skip of result.contentSkipped) { seen.add(normalizeUrlForDedup(skip.url)); contentSkipped.push({ ...skip, source: 'dayforce', company: boardCfg.name }); }
    for (const skip of result.countryEligibilitySkipped) { seen.add(normalizeUrlForDedup(skip.url)); countryEligibilitySkipped.push({ ...skip, source: 'dayforce', company: boardCfg.name }); }
    for (const skip of result.visaSkipped) { seen.add(normalizeUrlForDedup(skip.url)); visaSkipped.push({ ...skip, source: 'dayforce', company: boardCfg.name }); }

    for (const offer of result.found) {
      const key = normalizeUrlForDedup(offer.url);
      if (seen.has(key)) { dupeSkipped.push(offer); continue; }
      seen.add(key);
      newOffers.push(offer);
    }
  }

  if (!dryRun) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (contentSkipped.length > 0) await appendToScanHistory(contentSkipped, date, 'skipped_content');
    if (countryEligibilitySkipped.length > 0) await appendToScanHistory(countryEligibilitySkipped, date, 'skipped_country_eligibility');
    if (visaSkipped.length > 0) await appendToScanHistory(visaSkipped, date, 'skipped_visa');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Dayforce Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Boards scanned:     ${boards.length}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered content:   ${contentSkipped.length}`);
  console.log(`Country ineligible: ${countryEligibilitySkipped.length}`);
  console.log(`Filtered by visa:   ${visaSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.tenant}: ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — not saved)');
    } else {
      console.log('\nSaved to data/pipeline.md');
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
