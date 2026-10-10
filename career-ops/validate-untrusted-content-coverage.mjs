#!/usr/bin/env node

import { readFileSync, existsSync, globSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { USER_PATHS } from './update-system.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { isUnderNestedCheckout } from './lib/mjs-files.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const MARKER = 'Untrusted External Content';
const CANONICAL_HEADING = `## ${MARKER} (CRITICAL)`;

const FETCH_PRIMITIVES = /WebFetch|WebSearch|browser_navigate|Playwright|playwright/;

const EXCLUSIONS = new Map([
  ['batch/README.md', 'contributor docs — names Playwright as an install dependency ("Playwright chromium installed"), never fetches'],
  ['modes/_shared.md', 'checked separately below as the shared preamble every mode inherits, not as an ingesting mode'],
]);

const ALWAYS_REQUIRED = [
  'modes/batch.md',
  'modes/reply-watch.md',
  'modes/offer-prep.md',
];

const LOCALIZED_MIRROR = /^modes\/[a-z]{2}(-[A-Z]{2})?\//;

const USER_LAYER = new Set(USER_PATHS.filter((p) => !p.endsWith('/')));
const USER_LAYER_DIRS = USER_PATHS.filter((p) => p.endsWith('/'));

export function isUserLayerPath(rel) {
  return USER_LAYER.has(rel) || USER_LAYER_DIRS.some((d) => rel.startsWith(d));
}

export function deriveIngestingModes(paths, readFile) {
  const required = new Set(ALWAYS_REQUIRED.filter((p) => paths.includes(p)));
  for (const rel of paths) {
    if (EXCLUSIONS.has(rel)) continue;
    if (isUserLayerPath(rel)) continue;
    if (LOCALIZED_MIRROR.test(rel)) continue;
    let text = '';
    try {
      text = readFile(rel);
    } catch {
      continue;
    }
    if (FETCH_PRIMITIVES.test(text)) required.add(rel);
  }
  return [...required].sort();
}

export function hasDirectiveMarker(text) {
  return typeof text === 'string' && text.includes(MARKER);
}

export function hasCanonicalHeading(text) {
  return typeof text === 'string' && text.includes(CANONICAL_HEADING);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) {
    console.log('Running validate-untrusted-content-coverage.mjs self-tests...');

    const assert = (condition, message) => {
      if (!condition) {
        console.error(`FAIL: ${message}`);
        process.exit(1);
      }
    };

    assert(hasCanonicalHeading(`intro\n\n${CANONICAL_HEADING}\n\nbody`) === true, 'canonical heading must be detected when present');
    assert(hasCanonicalHeading('## Some Other Section (CRITICAL)') === false, 'a differently-named CRITICAL section must not match');
    assert(hasCanonicalHeading('') === false, 'empty text must not match');
    assert(hasCanonicalHeading(undefined) === false, 'non-string input must not match');

    assert(hasDirectiveMarker(`See "${MARKER}" in AGENTS.md.`) === true, 'a reference sentence must be detected');
    assert(hasDirectiveMarker('This mode has no such reference.') === false, 'text without the marker must not match');
    assert(hasDirectiveMarker(null) === false, 'non-string input must not match');

    const fake = {
      'modes/uses-webfetch.md': 'Step 2 — WebFetch the posting URL.',
      'modes/uses-websearch.md': 'Research the company with WebSearch.',
      'modes/uses-playwright.md': 'Fall back to Playwright when JS-rendered.',
      'modes/no-ingestion.md': 'Reads cv.md and config/profile.yml only.',
      'modes/batch.md': 'Runs the batch workers.',
      'modes/reply-watch.md': 'Classifies replies.',
      'modes/offer-prep.md': 'This mode must not call WebSearch or WebFetch.',
      'batch/README.md': 'Node.js >= 18, Playwright chromium installed.',
      'modes/_shared.md': 'WebFetch appears in the shared preamble.',
      'modes/de/oferta.md': 'WebFetch die Stellenanzeige.',
    };
    const read = (rel) => fake[rel];
    const derived = deriveIngestingModes(Object.keys(fake), read);

    assert(derived.includes('modes/uses-webfetch.md'), 'a mode naming WebFetch must be derived as ingesting');
    assert(derived.includes('modes/uses-websearch.md'), 'a mode naming WebSearch must be derived as ingesting');
    assert(derived.includes('modes/uses-playwright.md'), 'a mode naming Playwright must be derived as ingesting');
    assert(deriveIngestingModes(['modes/freshly-added.md'], () => 'WebFetch the URL').length === 1,
      'a freshly-created ingesting mode must be required automatically');
    assert(!derived.includes('modes/no-ingestion.md'), 'a mode with no fetch primitive must not be required');
    assert(derived.includes('modes/batch.md'), 'batch.md must stay required via the floor');
    assert(derived.includes('modes/reply-watch.md'), 'reply-watch.md must stay required via the floor');
    assert(derived.includes('modes/offer-prep.md'), 'offer-prep.md must stay required via the floor (pasted contract text)');
    assert(!derived.includes('batch/README.md'), 'contributor docs naming Playwright as a dependency must be excluded');
    assert(!derived.includes('modes/_shared.md'), '_shared.md is checked separately, not as an ingesting mode');
    assert(!derived.includes('modes/de/oferta.md'), 'localized mirrors are out of scope for this validator');

    const userFake = {
      'modes/_profile.md': 'Use WebSearch to check comp data before I apply.',
      'modes/_custom.md': 'Always WebFetch the careers page first.',
      'modes/_brief.md': 'Playwright for JS-heavy boards.',
      'modes/_profile.template.md': 'Use WebSearch for current market data.',
    };
    const userDerived = deriveIngestingModes(Object.keys(userFake), (rel) => userFake[rel]);
    assert(!userDerived.includes('modes/_profile.md'), 'modes/_profile.md is USER layer and must never be required');
    assert(!userDerived.includes('modes/_custom.md'), 'modes/_custom.md is USER layer and must never be required');
    assert(!userDerived.includes('modes/_brief.md'), 'modes/_brief.md is USER layer and must never be required');
    assert(userDerived.includes('modes/_profile.template.md'), 'the shipped template is SYSTEM layer and stays required');
    assert(isUserLayerPath('cv.md') && isUserLayerPath('data/applications.md'),
      'isUserLayerPath must follow USER_PATHS, including its directory entries');

    console.log('ALL SELF-TESTS PASSED');
    process.exit(0);
  }

  const agentsPath = join(ROOT, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    console.error('FAIL: AGENTS.md not found');
    process.exit(1);
  }
  const agentsText = readFileSync(agentsPath, 'utf-8');

  const problems = [];

  if (!hasCanonicalHeading(agentsText)) {
    problems.push(`AGENTS.md is missing the canonical heading "${CANONICAL_HEADING}"`);
  }

  const sharedPath = join(ROOT, 'modes/_shared.md');
  if (!existsSync(sharedPath)) {
    problems.push('modes/_shared.md not found');
  } else if (!hasDirectiveMarker(readFileSync(sharedPath, 'utf-8'))) {
    problems.push(`modes/_shared.md does not reference "${MARKER}"`);
  }

  const candidates = [
    ...globSync('modes/**/*.md', { cwd: ROOT }),
    ...globSync('batch/*.md', { cwd: ROOT }),
  ].map((p) => p.split(sep).join('/'))
    .filter((rel) => !isUnderNestedCheckout(ROOT, rel));

  const required = deriveIngestingModes(candidates, (rel) => readFileSync(join(ROOT, rel), 'utf-8'));

  for (const rel of required) {
    if (!hasDirectiveMarker(readFileSync(join(ROOT, rel), 'utf-8'))) {
      problems.push(`${rel} ingests external text but does not reference "${MARKER}"`);
    }
  }

  if (problems.length > 0) {
    console.error('Coverage gap — untrusted-content directive missing or unreferenced:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('');
    console.error(`Add the canonical "${CANONICAL_HEADING}" section to AGENTS.md (if missing),`);
    console.error(`and a short reference to "${MARKER}" in every listed file.`);
    process.exit(1);
  }

  console.log(`OK: canonical directive present in AGENTS.md and referenced in modes/_shared.md + ${required.length} derived ingesting modes`);
  process.exit(0);
}
