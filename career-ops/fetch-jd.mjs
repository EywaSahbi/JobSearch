#!/usr/bin/env node

import { fetchJdViaKnownApi } from './browser-extract.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TEXT_CAP = 20_000;
const TIMEOUT_MS = 15_000;

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error('usage: node fetch-jd.mjs <url>');
    process.exit(1);
  }

  const result = await fetchJdViaKnownApi(url, TEXT_CAP, TIMEOUT_MS);
  if (!result) process.exit(1);

  const header = result.title ? `${result.title}\n\n` : '';
  process.stdout.write(header + result.text);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-jd: unexpected error — ${err?.message || err}`);
    process.exit(1);
  });
}
