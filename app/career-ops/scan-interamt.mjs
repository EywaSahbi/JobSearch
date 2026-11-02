#!/usr/bin/env node

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';

const SCAN_HISTORY    = SCAN_HISTORY_PATH;
const DATA_ROOT       = getCareerOpsRoot();
const INTERAMT_HOME   = 'https://interamt.de/koop/app/';
const OFFER_BASE_URL  = 'https://interamt.de/koop/app/stelle?id=';

const DEFAULT_KEYWORDS = [
  'Informatiker',
  'Softwareentwickler',
  'IT-Spezialist',
  'Datenwissenschaftler',
  'Systemadministrator',
  'Datenanalyst',
];

const KNOWN_FLAGS = ['--dry-run', '--debug', '--all', '--keyword', '--help', '-h'];
const VALUE_FLAGS = ['--keyword'];

const USAGE = `Usage:
  node scan-interamt.mjs
  node scan-interamt.mjs --dry-run
  node scan-interamt.mjs --all            # skip date filter (use for first scan)
  node scan-interamt.mjs --keyword "Softwareentwickler"
  node scan-interamt.mjs --debug          # save a screenshot and the page HTML to output/
  node scan-interamt.mjs --help|-h        # print this usage block and exit`;

const args = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const DEBUG      = args.includes('--debug');
const NO_DATE_FILTER = args.includes('--all');
const SINGLE_KEYWORD = flagValue(args, '--keyword') ?? null;
if (hasFlag(args, '--keyword') && (!SINGLE_KEYWORD || SINGLE_KEYWORD.startsWith('--'))) {
  console.error('Error: --keyword requires a value, e.g. --keyword "Softwareentwickler"');
  process.exit(1);
}

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

const interamtSearches = config.interamt_searches || DEFAULT_KEYWORDS.map(k => ({ was: k }));
const keywords = SINGLE_KEYWORD
  ? [SINGLE_KEYWORD]
  : interamtSearches.map(s => s.was).filter(Boolean);

const titleFilter = config.title_filter || {};
const positiveKw = (titleFilter.positive || []).map(k => k.toLowerCase());
const negativeKw = (titleFilter.negative || []).map(k => k.toLowerCase());

function matchesTitle(title) {
  const lower = title.toLowerCase();
  if (negativeKw.some(k => lower.includes(k))) return false;
  if (positiveKw.length === 0) return true;
  return positiveKw.some(k => lower.includes(k));
}

const locFilter = config.location_filter || {};
const locAllow = (locFilter.allow || []).map(k => k.toLowerCase());
const locBlock = (locFilter.block || []).map(k => k.toLowerCase());

function matchesLocation(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();
  if (locBlock.some(k => lower.includes(k))) return false;
  if (locAllow.length === 0) return true;
  return locAllow.some(k => lower.includes(k));
}

function parseDE(str) {
  if (!str) return null;
  const [d, m, y] = str.trim().split('.');
  if (!d || !m || !y) return null;
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00Z`);
}

function loadLastScanDate() {
  if (!existsSync(SCAN_HISTORY)) return null;
  let latest = null;
  readFileSync(SCAN_HISTORY, 'utf-8').split('\n').slice(1).forEach(line => {
    const parts = line.split('\t');
    if (parts[2] !== 'interamt') return;
    const d = new Date((parts[1] || '') + 'T00:00:00Z');
    if (!isNaN(d) && (!latest || d > latest)) latest = d;
  });
  return latest;
}

const SEL_EDIT_BTN    = 'a.ia-e-link--icon:has-text("Suchkriterien ändern"), a:has-text("Suchkriterien ändern")';
const SEL_NEXT_INPUT  = 'input[name="stellensucheFilterAttributes.suchtextContainer:stellensucheFilterAttributes.suchText"]';
const SEL_NEXT_SUBMIT = 'button.ia-e-button--primary:has-text("Detailsuche")';

async function extractRows(page) {
  return page.$$eval('tr.ia-e-table__row', rows =>
    rows.map(row => {
      const cell = field => row.querySelector(`td[data-field="${field}"]`)?.textContent?.trim() || '';

      const title        = cell('Stellenbezeichnung');
      const id           = row.querySelector('td[data-field="StellenangebotId"] span')?.textContent?.trim() || '';
      const company      = cell('Behoerde') || 'Interamt';
      const modality     = cell('Dienstort');
      const city         = cell('PLZOrte');
      const publishedDate = cell('Von');
      const deadline     = cell('Bewerbungsfrist');

      return { title, id, company, modality, city, publishedDate, deadline };
    }).filter(r => r.title && r.id)
  );
}

async function searchInteramt(page, keyword, isFirst) {
  const found = [];

  if (isFirst) {
    await page.goto(INTERAMT_HOME, { waitUntil: 'networkidle', timeout: 30000 });

    const cookieModal = page.locator('#ia-m-cookie-modal');
    const isModalVisible = await cookieModal.isVisible().catch(() => false);
    if (isModalVisible) {
      await page.locator('#ia-m-cookie-modal .ia-m-modal__close').click();
      await cookieModal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
    }

    await page.waitForSelector('#idOrSuchtext', { state: 'visible', timeout: 15000 });
    await page.fill('#idOrSuchtext', keyword);

    const submitBtn = page.locator('#ida, button.ia-e-button--primary.ia-e-button--icon').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await submitBtn.click();
  } else {
    const editBtn = page.locator(SEL_EDIT_BTN).first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      const anyModal = page.locator('.ia-m-modal__close').first();
      if (await anyModal.isVisible({ timeout: 2000 }).catch(() => false)) {
        await anyModal.evaluate(el => el.click());
        await page.locator('.ia-m-modal__container').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => null);
      }
      await page.locator('.ia-e-backdrop').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
      await editBtn.evaluate(el => el.click());
      await page.waitForSelector(SEL_NEXT_INPUT, { state: 'visible', timeout: 15000 });
      await page.fill(SEL_NEXT_INPUT, keyword);
      const submitBtn = page.locator(SEL_NEXT_SUBMIT);
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
    } else {
      await page.goto(INTERAMT_HOME, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('#idOrSuchtext', { state: 'visible', timeout: 15000 });
      await page.fill('#idOrSuchtext', keyword);
      const submitBtn = page.locator('#ida, button.ia-e-button--primary.ia-e-button--icon').first();
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
    }
  }

  await Promise.race([
    page.waitForSelector('tr.ia-e-table__row', { timeout: 20000 }),
    page.waitForSelector('.ia-e-no-results, .ia-no-results, [class*="no-result"]', { timeout: 20000 }),
  ]).catch(() => null);

  if (DEBUG) {
    const debugDir = join(DATA_ROOT, 'output');
    const debugPng = join(debugDir, 'debug-interamt.png');
    const debugHtml = join(debugDir, 'debug-interamt.html');
    mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: debugPng, fullPage: true });
    const { writeFileSync: wf } = await import('fs');
    wf(debugHtml, await page.content());
    console.log(`  [debug] screenshot → ${debugPng}`);
    console.log(`  [debug] html       → ${debugHtml}`);
    console.log('  [debug] url:', page.url());
    const rowCount = await page.$$eval('tr', rows => rows.length);
    console.log(`  [debug] total <tr> on page: ${rowCount}`);
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);

  const loadMoreBtn = page.locator('button.ia-m-searchresults__btn-load').first();
  let pageNum = 1;
  while (pageNum <= 50) {
    const visible = await loadMoreBtn.isVisible().catch(() => false);
    if (!visible) break;
    const beforeCount = await page.$$eval('tr.ia-e-table__row', rows => rows.length);
    await loadMoreBtn.evaluate(el => el.click());
    await page.locator('.ia-e-backdrop').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
    await page.waitForFunction(
      n => document.querySelectorAll('tr.ia-e-table__row').length > n,
      beforeCount,
      { timeout: 15000 }
    ).catch(() => null);
    pageNum++;
  }

  const rows = await extractRows(page);
  for (const row of rows) {
    found.push({
      title:         row.title,
      url:           `${OFFER_BASE_URL}${row.id}`,
      company:       row.company,
      modality:      row.modality,
      city:          row.city,
      publishedDate: row.publishedDate,
      deadline:      row.deadline,
    });
  }

  return found;
}

async function main() {
  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });

  const { seen } = loadSeenUrls();
  const date = localToday();

  const lastScanDate = NO_DATE_FILTER ? null : loadLastScanDate();
  if (NO_DATE_FILTER) {
    console.log(`  --all: date filter disabled — fetching all available offers`);
  } else if (lastScanDate) {
    console.log(`  Last Interamt scan: ${lastScanDate.toISOString().slice(0,10)} — skipping older offers`);
  }

  let totalFound = 0;
  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dateSkipped = [];
  const dupeSkipped = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();

  try {
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      process.stdout.write(`  Searching "${kw}"... `);
      try {
        const found = await searchInteramt(page, kw, i === 0);
        totalFound += found.length;
        process.stdout.write(`${found.length} found\n`);

        for (const offer of found) {
          const location = [offer.modality, offer.city].filter(Boolean).join(' ')
            + (offer.deadline ? ` (Frist: ${offer.deadline})` : '');
          const pubDate = parseDE(offer.publishedDate);
          const canonical = {
            url: offer.url,
            company: offer.company,
            title: offer.title,
            location,
            source: 'interamt',
            postedAt: pubDate ? pubDate.getTime() : undefined,
          };

          if (!matchesTitle(offer.title)) { seen.add(canonical.url); titleSkipped.push(canonical); continue; }
          if (!matchesLocation(location)) { seen.add(canonical.url); locationSkipped.push(canonical); continue; }
          if (lastScanDate && pubDate && pubDate < lastScanDate) { seen.add(canonical.url); dateSkipped.push(canonical); continue; }
          if (seen.has(canonical.url)) { dupeSkipped.push(canonical); continue; }
          seen.add(canonical.url);
          newOffers.push(canonical);
        }
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        errors.push({ keyword: kw, error: err.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!DRY_RUN) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (dateSkipped.length > 0) await appendToScanHistory(dateSkipped, date, 'skipped_date');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('Interamt Scan', date);
  console.log(`Keywords searched:  ${keywords.length}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered by date:   ${dateSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.keyword}": ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (DRY_RUN) {
      console.log('\n(dry run — not saved)');
    } else {
      console.log(`\nSaved to data/pipeline.md`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
