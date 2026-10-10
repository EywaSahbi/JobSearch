#!/usr/bin/env node

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
  jitteredDelayMs,
  sleep,
} from './liveness-browser.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { planExpiredHistoryRows } from './liveness-core.mjs';
import { appendToScanHistory, normalizeUrlForDedup, SCAN_HISTORY_PATH } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { existsSync, readFileSync } from 'fs';

const USAGE = `Usage:
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] [--no-record] <url1> [url2] ...
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] [--no-record] --file urls.txt
  node check-liveness.mjs --no-record             # check only; write nothing to scan-history
  node check-liveness.mjs --help                  # print this usage block and exit
  node check-liveness.mjs -h                      # alias for --help`;

export function recordingEnabled(args = []) {
  return !args.includes('--no-record');
}

export async function recordExpiredVerdicts(verdicts) {
  if (!existsSync(SCAN_HISTORY_PATH)) return 0;
  return withPipelineLock(SCAN_HISTORY_PATH, async () => {
    const rows = planExpiredHistoryRows(
      readFileSync(SCAN_HISTORY_PATH, 'utf-8'),
      verdicts,
      normalizeUrlForDedup,
    );
    if (rows.length > 0) await appendToScanHistory(rows, localToday(), 'skipped_expired', { alreadyLocked: true });
    return rows.length;
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const noFallback = args.includes('--no-fallback');
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  const record = recordingEnabled(args);
  const positional = args.filter((a) => a !== '--no-fallback' && a !== '--no-record' && a !== throttleArg);

  if (positional.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let urls;
  if (positional[0] === '--file') {
    const text = await readFile(positional[1], 'utf-8');
    urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else {
    urls = positional;
  }

  const notes = [
    noFallback ? null : 'headed fallback on challenge',
    throttleBaseMs ? `throttle ~${throttleBaseMs / 1000}-${(throttleBaseMs * 2) / 1000}s` : null,
    record ? null : 'no-record',
  ].filter(Boolean);
  console.log(`Checking ${urls.length} URL(s)...${notes.length ? ` (${notes.join(', ')})` : ''}\n`);

  let browser = null, page = null, headed = null;
  async function ensureBrowser() {
    if (browser) return;
    browser = await chromium.launch({ headless: true });
    page = await newLivenessPage(browser);
    headed = noFallback ? null : createHeadedPageProvider(chromium);
  }

  let active = 0, expired = 0, uncertain = 0, viaApi = 0;
  const verdicts = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let result, reason, code, usedBrowser = false;

    const api = await checkLivenessViaApi(url);
    if (api) {
      ({ result, reason, code } = api);
      viaApi++;
    } else {
      await ensureBrowser();
      const getHeadedPage = headed ? () => headed.get() : undefined;
      ({ result, reason, code } = await checkUrlLivenessWithFallback(page, url, { getHeadedPage }));
      usedBrowser = true;
    }

    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} ${api ? '(api) ' : '      '}${url}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired++;
    else uncertain++;
    verdicts.push({ url, result, code });

    const wait = usedBrowser && i < urls.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
    if (wait) await sleep(wait);
  }

  if (headed) await headed.close();
  if (browser) await browser.close();

  console.log(`\nResults: ${active} active  ${expired} expired  ${uncertain} uncertain  (${viaApi} via API, no browser)`);

  if (record) {
    const recorded = await recordExpiredVerdicts(verdicts);
    if (recorded > 0) console.log(`Recorded ${recorded} expired posting(s) in ${SCAN_HISTORY_PATH}`);
  }

  if (expired > 0 || uncertain > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  });
}
