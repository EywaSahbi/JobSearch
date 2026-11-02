#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { isAbsolute, join, resolve, relative, sep, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { findExperienceSections, parseCompanyHeading, EXPERIENCE_HEADING_NAMES } from './lib/cv-markdown.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = 'cv.md';

export function parseCvMdExperience(cvMdText) {
  return findExperienceSections(cvMdText).flat().map(parseCompanyHeading).filter(Boolean);
}

function normalizeCompany(name) {
  return String(name || '').toLowerCase().trim();
}

function companiesMatch(payloadCompany, cvMdCompany) {
  const a = normalizeCompany(payloadCompany);
  const b = normalizeCompany(cvMdCompany);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

function findCompanyIndex(entries, company, sourceEntries = []) {
  const target = normalizeCompany(company);
  const exactIndex = entries.findIndex((e) => normalizeCompany(e.company) === target);
  if (exactIndex !== -1) return exactIndex;
  const sourceExactNames = new Set(sourceEntries.map((e) => normalizeCompany(e.company)));
  return entries.findIndex((e) => {
    const candidate = normalizeCompany(e.company);
    return companiesMatch(company, e.company) && !sourceExactNames.has(candidate);
  });
}

export function checkExperienceOrder(payloadExperience, cvMdExperience) {
  const violations = [];
  const cvMdIndexOf = (company) => findCompanyIndex(cvMdExperience, company, payloadExperience);
  const resolved = payloadExperience
    .map((e, payloadIndex) => ({ payloadIndex, company: e.company, cvMdIndex: cvMdIndexOf(e.company) }))
    .filter((e) => e.cvMdIndex !== -1);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (a.cvMdIndex > b.cvMdIndex) {
        violations.push(`"${a.company}" is rendered before "${b.company}", but cv.md has them in the opposite order`);
      }
    }
  }
  return violations;
}

export function checkLocationDescriptors(payloadExperience, cvMdExperience) {
  const violations = [];
  for (const cvMdEntry of cvMdExperience) {
    const descriptorMatch = cvMdEntry.location.match(/·\s*(.+)$/);
    if (!descriptorMatch) continue;
    const descriptor = descriptorMatch[1].trim();
    const payloadIndex = findCompanyIndex(payloadExperience, cvMdEntry.company, cvMdExperience);
    const payloadEntry = payloadIndex === -1 ? undefined : payloadExperience[payloadIndex];
    if (!payloadEntry) continue;
    const payloadLocation = String(payloadEntry.location || '');
    if (!payloadLocation.includes(descriptor)) {
      violations.push(`"${cvMdEntry.company}" is missing its cv.md descriptor "${descriptor}" (payload location: "${payloadLocation || '(empty)'}")`);
    }
  }
  return violations;
}

export function verifyStructure(payload, cvMdText) {
  const cvMdExperience = parseCvMdExperience(cvMdText);
  if (cvMdExperience.length === 0) {
    return { verdict: 'unverified', orderViolations: [], descriptorViolations: [] };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { verdict: 'unverified', orderViolations: [], descriptorViolations: [] };
  }
  if (payload.experience !== undefined && !Array.isArray(payload.experience)) {
    return { verdict: 'unverified', orderViolations: [], descriptorViolations: [] };
  }
  if (Array.isArray(payload.experience) && payload.experience.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) {
    return { verdict: 'unverified', orderViolations: [], descriptorViolations: [] };
  }
  const payloadExperience = Array.isArray(payload.experience) ? payload.experience : [];
  const orderViolations = checkExperienceOrder(payloadExperience, cvMdExperience);
  const descriptorViolations = checkLocationDescriptors(payloadExperience, cvMdExperience);
  return {
    verdict: orderViolations.length || descriptorViolations.length ? 'warn' : 'pass',
    orderViolations,
    descriptorViolations,
  };
}

function resolveInputPath(path, cwd = process.cwd()) {
  return isAbsolute(path) ? path : join(cwd, path);
}

function resolveSourcePath(path) {
  if (isAbsolute(path)) {
    throw new Error('--source must be relative to CAREER_OPS_ROOT');
  }
  const root = resolve(getCareerOpsRoot());
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('--source must stay within CAREER_OPS_ROOT');
  }

  if (existsSync(candidate)) {
    const canonicalRoot = realpathSync(root);
    const canonicalCandidate = realpathSync(candidate);
    const canonicalRelativePath = relative(canonicalRoot, canonicalCandidate);
    if (canonicalRelativePath === '..' || canonicalRelativePath.startsWith(`..${sep}`) || isAbsolute(canonicalRelativePath)) {
      throw new Error('--source must stay within CAREER_OPS_ROOT');
    }
    return canonicalCandidate;
  }
  return candidate;
}

function usage() {
  return `Usage: node verify-cv-structure.mjs <payload.json> [--source cv.md]
       node verify-cv-structure.mjs --self-test

Checks a tailored CV JSON payload (the input to build-cv-html.mjs) against cv.md
for two structural regressions fabrication-checking cannot see: experience
entries rendered out of cv.md's chronological order, and a company descriptor
("· Series B healthcare automation") silently dropped from an entry's location.
Default source: cv.md
The --source path must be relative to CAREER_OPS_ROOT and cannot escape it.

This is a warning, not a hard gate: a structural pass, warn, or unverified
result always exits 0 — a finding means review the payload against cv.md and
decide whether the loss was intentional, but the check never stops the
pipeline over one. CLI usage errors, a missing/unreadable payload or source
file, invalid JSON, or a malformed payload shape (a non-object payload, or a
non-array/non-object payload.experience) exit 1 instead: those mean the
check itself could not run, not that it found something to review.

Understands ${EXPERIENCE_HEADING_NAMES.map((name) => `"## ${name}"`).join(', ')}
sections whose company headers use an em dash, en dash, double hyphen, or
single hyphen before the location, written plain or as Pandoc Markdown.
A cv.md written another way parses to zero entries; the check then reports
UNVERIFIED rather than a false "passed".`;
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const equal = (label, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      return;
    }
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  };

  const cvMd = [
    '## Experience',
    '',
    '### Acme Corp — Austin, TX · Series B fintech',
    '',
    '**VP of Engineering** · Feb 2023 – present',
    '',
    '### Career Break — Lake Tahoe, CA',
    '',
    '**Sabbatical** · Jul 2021 – Feb 2023',
    '',
    '### Beta Industries — Chicago, IL · Series A last-mile logistics SaaS',
    '',
    '**Co-founder & Chief Technology Officer** · Mar 2011 – Jul 2021',
    '',
    '### Early Career — Columbus, OH / Dayton, OH',
    '',
    '## Education',
    '',
    '### Decoy University — Springfield, IL',
    '',
    '**B.S. Computer Science** · 2005 – 2009',
  ].join('\n');

  const correctOrder = [
    { company: 'Acme Corp', location: 'Austin, TX · Series B fintech' },
    { company: 'Career Break', location: 'Lake Tahoe, CA' },
    { company: 'Beta Industries', location: 'Chicago, IL · Series A last-mile logistics SaaS' },
    { company: 'Early Career — Globex Inc, Initech, Umbrella Corp', location: 'Columbus, OH / Dayton, OH' },
  ];
  equal('correct order, all descriptors present: no violations',
    verifyStructure({ experience: correctOrder }, cvMd),
    { verdict: 'pass', orderViolations: [], descriptorViolations: [] });

  const swappedOrder = [
    { company: 'Acme Corp', location: 'Austin, TX · Series B fintech' },
    { company: 'Beta Industries', location: 'Chicago, IL · Series A last-mile logistics SaaS' },
    { company: 'Career Break', location: 'Lake Tahoe, CA' },
  ];
  const swappedResult = verifyStructure({ experience: swappedOrder }, cvMd);
  equal('swapped Career Break/Beta Industries: order violation caught', swappedResult.verdict, 'warn');
  equal('swapped order names both entries',
    swappedResult.orderViolations,
    ['"Beta Industries" is rendered before "Career Break", but cv.md has them in the opposite order']);

  const missingDescriptor = [
    { company: 'Acme Corp', location: 'Austin, TX' },
    { company: 'Career Break', location: 'Lake Tahoe, CA' },
    { company: 'Beta Industries', location: 'Chicago, IL · Series A last-mile logistics SaaS' },
  ];
  const missingResult = verifyStructure({ experience: missingDescriptor }, cvMd);
  equal('dropped descriptor: violation caught', missingResult.verdict, 'warn');
  equal('dropped descriptor names the entry and the missing text',
    missingResult.descriptorViolations,
    ['"Acme Corp" is missing its cv.md descriptor "Series B fintech" (payload location: "Austin, TX")']);

  const subsetOmitted = [
    { company: 'Acme Corp', location: 'Austin, TX · Series B fintech' },
    { company: 'Beta Industries', location: 'Chicago, IL · Series A last-mile logistics SaaS' },
  ];
  equal('a legitimately omitted entry (Career Break dropped for space) is not a violation',
    verifyStructure({ experience: subsetOmitted }, cvMd).verdict, 'pass');

  const noDescriptorInSource = [
    { company: 'Career Break', location: 'Lake Tahoe, CA, near the shoreline' },
  ];
  equal('an entry cv.md never gave a descriptor has nothing to check',
    verifyStructure({ experience: noDescriptorInSource }, cvMd).verdict, 'pass');

  const unrecognizedCvMd = '## Experience\n\nWorked at a company for a while.\n';
  const unverifiedResult = verifyStructure({ experience: correctOrder }, unrecognizedCvMd);
  equal('cv.md with no recognized headers: reports unverified, not a false pass',
    unverifiedResult.verdict, 'unverified');
  equal('unverified result names no violations (nothing was actually checked)',
    unverifiedResult.orderViolations.length + unverifiedResult.descriptorViolations.length, 0);

  const shippedCvMd = readFileSync(join(ROOT, 'examples', 'cv-example.md'), 'utf-8');
  const shippedEntries = parseCvMdExperience(shippedCvMd);
  equal('shipped example parses both Work Experience entries',
    shippedEntries.map((e) => e.company), ['TechFin Corp', 'DataStartup Inc']);
  equal('shipped example format produces a real structural verdict',
    verifyStructure({ experience: shippedEntries }, shippedCvMd).verdict, 'pass');

  const pandocCvMd = [
    '## **[Technical Platforms & Tools]{.smallcaps}**',
    '',
    '### **Not A Job** --- Should Be Ignored',
    '',
    '## **[Professional Experience]{.smallcaps}**',
    '',
    '### **Acme Health, Inc.** --- New York, NY (Remote) · Series B healthtech',
    '',
    '**Senior Director, Platform Engineering**\\',
    '**09/2021 -- Present**',
    '',
    '### **Globex Corp.** --- Stamford, CT',
    '',
    '**Principal Infrastructure Engineer**\\',
    '**03/2015 -- 08/2021**',
  ].join('\n');
  equal('Pandoc cv.md: entries parse from a bold + span Professional Experience section',
    parseCvMdExperience(pandocCvMd), [
      { company: 'Acme Health, Inc.', location: 'New York, NY (Remote) · Series B healthtech' },
      { company: 'Globex Corp.', location: 'Stamford, CT' },
    ]);
  equal('Pandoc cv.md: a swapped pair is caught instead of UNVERIFIED',
    verifyStructure({ experience: [
      { company: 'Globex Corp.', location: 'Stamford, CT' },
      { company: 'Acme Health, Inc.', location: 'New York, NY (Remote) · Series B healthtech' },
    ] }, pandocCvMd).verdict, 'warn');
  equal('Pandoc cv.md: a dropped descriptor is caught instead of UNVERIFIED',
    verifyStructure({ experience: [
      { company: 'Acme Health, Inc.', location: 'New York, NY (Remote)' },
      { company: 'Globex Corp.', location: 'Stamford, CT' },
    ] }, pandocCvMd).descriptorViolations.length, 1);
  for (const heading of ['Professional Experience', 'Employment History', 'Work History']) {
    equal(`"## ${heading}" is a recognized Experience section`,
      parseCvMdExperience(`## ${heading}\n\n### Co — City\n`), [{ company: 'Co', location: 'City' }]);
  }
  equal('an en-dash company/location separator is recognized',
    parseCvMdExperience('## Experience\n\n### Co – City\n'), [{ company: 'Co', location: 'City' }]);

  const twoSectionCvMd = [
    '## Professional Experience', '', '### Acme — Austin, TX · Series B fintech', '',
    '## Education', '', '### State University — Austin, TX', '',
    '## Work History', '', '### Beta — Chicago, IL · logistics SaaS', '',
  ].join('\n');
  equal('every recognized Experience section is parsed, in file order (Education skipped)',
    parseCvMdExperience(twoSectionCvMd).map((e) => e.company), ['Acme', 'Beta']);
  equal('a dropped descriptor in the second section is caught',
    verifyStructure({ experience: [
      { company: 'Acme', location: 'Austin, TX · Series B fintech' },
      { company: 'Beta', location: 'Chicago, IL' },
    ] }, twoSectionCvMd).descriptorViolations.length, 1);

  const singleHyphenCvMd = [
    '## Experience',
    '',
    '### Single Hyphen Co - Remote · developer tools',
  ].join('\n');
  equal('single-hyphen company/location separator is recognized',
    parseCvMdExperience(singleHyphenCvMd),
    [{ company: 'Single Hyphen Co', location: 'Remote · developer tools' }]);

  const decoyEntries = parseCvMdExperience(cvMd);
  equal('Education section header is excluded from parsed experience entries',
    decoyEntries.some((e) => e.company.includes('Decoy University')), false);
  equal('Experience section still yields its 4 real entries despite the Education decoy',
    decoyEntries.length, 4);

  const prefixCollisionCvMd = [
    '## Experience',
    '',
    '### Acme — City One, ST',
    '',
    '**Engineer** · Jan 2018 – Jan 2020',
    '',
    '### Acme Corp — City Two, ST',
    '',
    '**Senior Engineer** · Jan 2020 – present',
  ].join('\n');
  const prefixCollisionSwapped = [
    { company: 'Acme Corp', location: 'City Two, ST' },
    { company: 'Acme', location: 'City One, ST' },
  ];
  const prefixCollisionResult = verifyStructure({ experience: prefixCollisionSwapped }, prefixCollisionCvMd);
  equal('exact match beats fuzzy prefix: swapped "Acme"/"Acme Corp" is still caught',
    prefixCollisionResult.verdict, 'warn');
  equal('prefix-collision order violation names the correct pair',
    prefixCollisionResult.orderViolations,
    ['"Acme Corp" is rendered before "Acme", but cv.md has them in the opposite order']);

  const omittedPrefixCvMd = [
    '## Experience',
    '',
    '### Acme — City One, ST · consumer marketplace',
    '',
    '**Engineer** · Jan 2018 – Jan 2020',
    '',
    '### Acme Labs — City Two, ST · AI tooling',
    '',
    '**Senior Engineer** · Jan 2020 – present',
  ].join('\n');
  const onlyAcmeLabs = [
    { company: 'Acme Labs', location: 'City Two, ST · AI tooling' },
  ];
  equal('omitted Acme does not fuzzy-match retained Acme Labs',
    verifyStructure({ experience: onlyAcmeLabs }, omittedPrefixCvMd),
    { verdict: 'pass', orderViolations: [], descriptorViolations: [] });

  {
    const selfTestDir = mkdtempSync(join(tmpdir(), 'verify-cv-structure-selftest-'));
    try {
      const nullPayloadPath = join(selfTestDir, 'null-payload.json');
      writeFileSync(nullPayloadPath, 'null', 'utf-8');
      const validPayloadPath = join(selfTestDir, 'valid-payload.json');
      writeFileSync(validPayloadPath, JSON.stringify({ experience: correctOrder }), 'utf-8');
      const nullEntryPayloadPath = join(selfTestDir, 'null-entry-payload.json');
      writeFileSync(nullEntryPayloadPath, JSON.stringify({ experience: [null, ...correctOrder] }), 'utf-8');
      const nonArrayExperiencePath = join(selfTestDir, 'non-array-experience-payload.json');
      writeFileSync(nonArrayExperiencePath, JSON.stringify({ experience: null }), 'utf-8');
      const dataRoot = join(selfTestDir, 'data-root');
      mkdirSync(dataRoot);
      const cvMdPath = join(dataRoot, 'cv.md');
      writeFileSync(cvMdPath, cvMd, 'utf-8');
      const dirAsSourcePath = join(dataRoot, 'a-directory-not-a-file');
      mkdirSync(dirAsSourcePath);
      writeFileSync(join(selfTestDir, 'outside-cv.md'), cvMd, 'utf-8');
      const decoyCwd = join(selfTestDir, 'decoy-cwd');
      mkdirSync(decoyCwd);

      const origError = console.error;
      const origWarn = console.warn;
      const origLog = console.log;
      console.error = () => {};
      console.warn = () => {};
      console.log = () => {};
      let nullExit, dirSourceExit, nullEntryExit, nonArrayExperienceExit, dataRootSourceExit,
        absoluteSourceExit, traversalSourceExit;
      const origCwd = process.cwd();
      const origDataRoot = process.env.CAREER_OPS_ROOT;
      try {
        process.env.CAREER_OPS_ROOT = dataRoot;
        nullExit = runCli([nullPayloadPath, '--source', 'cv.md']);
        dirSourceExit = runCli([validPayloadPath, '--source', 'a-directory-not-a-file']);
        nullEntryExit = runCli([nullEntryPayloadPath, '--source', 'cv.md']);
        nonArrayExperienceExit = runCli([nonArrayExperiencePath, '--source', 'cv.md']);
        absoluteSourceExit = runCli([validPayloadPath, '--source', cvMdPath]);
        traversalSourceExit = runCli([validPayloadPath, '--source', '../outside-cv.md']);
        process.chdir(decoyCwd);
        dataRootSourceExit = runCli([validPayloadPath, '--source', 'cv.md']);
      } finally {
        process.chdir(origCwd);
        if (origDataRoot === undefined) delete process.env.CAREER_OPS_ROOT;
        else process.env.CAREER_OPS_ROOT = origDataRoot;
        console.error = origError;
        console.warn = origWarn;
        console.log = origLog;
      }
      equal('CLI rejects a null JSON payload instead of throwing', nullExit, 1);
      equal('CLI rejects an unreadable (directory) --source instead of throwing', dirSourceExit, 1);
      equal('CLI rejects a null entry inside payload.experience instead of throwing', nullEntryExit, 1);
      equal('CLI rejects a non-array payload.experience instead of a false pass', nonArrayExperienceExit, 1);
      equal('CLI rejects an absolute --source path even when it points inside the data root', absoluteSourceExit, 1);
      equal('CLI rejects a --source path that traverses outside the data root', traversalSourceExit, 1);
      equal('CLI resolves a relative --source from the configured data root, not cwd', dataRootSourceExit, 0);
    } finally {
      rmSync(selfTestDir, { recursive: true, force: true });
    }
  }

  const nonArrayExperienceResult = verifyStructure({ experience: 'not an array' }, cvMd);
  equal('verifyStructure never reports pass for a non-array experience value',
    nonArrayExperienceResult.verdict === 'pass', false);

  equal('verifyStructure(null, cvMd) reports unverified instead of throwing',
    verifyStructure(null, cvMd),
    { verdict: 'unverified', orderViolations: [], descriptorViolations: [] });
  equal('verifyStructure with a null experience entry reports unverified instead of throwing',
    verifyStructure({ experience: [null, ...correctOrder] }, cvMd),
    { verdict: 'unverified', orderViolations: [], descriptorViolations: [] });

  console.log(`verify-cv-structure self-test: ${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

export function runCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') return runSelfTest();
  let targetArg = '';
  let sourcePath = DEFAULT_SOURCE;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source') {
      if (!args[i + 1]) { console.error('ERROR: --source requires a path'); return 1; }
      sourcePath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else if (!targetArg) {
      targetArg = arg;
    } else {
      console.error(`ERROR: unexpected extra positional argument: ${arg}`);
      return 1;
    }
  }
  if (!targetArg) {
    console.log(usage());
    return 1;
  }
  const targetPath = resolveInputPath(targetArg);
  if (!existsSync(targetPath)) {
    console.error(`ERROR: payload not found: ${targetArg}`);
    return 1;
  }
  let srcPath;
  try {
    srcPath = resolveSourcePath(sourcePath);
  } catch (err) {
    console.error(`ERROR: invalid source path: ${sourcePath}: ${err.message}`);
    return 1;
  }
  if (!existsSync(srcPath)) {
    console.error(`ERROR: source not found: ${sourcePath}`);
    return 1;
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(targetPath, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: payload is not valid JSON: ${err.message}`);
    return 1;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    console.error(`ERROR: payload must be a JSON object, got ${payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload}: ${targetArg}`);
    return 1;
  }
  if ('experience' in payload && payload.experience !== undefined && !Array.isArray(payload.experience)) {
    const got = payload.experience === null ? 'null' : typeof payload.experience;
    console.error(`ERROR: payload.experience must be an array, got ${got}: ${targetArg}`);
    return 1;
  }
  if (Array.isArray(payload.experience)) {
    const badIndex = payload.experience.findIndex(
      (e) => e === null || typeof e !== 'object' || Array.isArray(e)
    );
    if (badIndex !== -1) {
      const bad = payload.experience[badIndex];
      const badType = bad === null ? 'null' : Array.isArray(bad) ? 'an array' : typeof bad;
      console.error(`ERROR: payload.experience[${badIndex}] must be an object, got ${badType}: ${targetArg}`);
      return 1;
    }
  }
  let cvMdText;
  try {
    cvMdText = readFileSync(srcPath, 'utf-8');
  } catch (err) {
    console.error(`ERROR: source is not readable: ${sourcePath}: ${err.message}`);
    return 1;
  }
  const result = verifyStructure(payload, cvMdText);
  if (result.verdict === 'unverified') {
    console.warn(`⚠️  CV structure check UNVERIFIED: ${basename(targetPath)}`);
    console.warn(`Could not find supported company/location headers in ${sourcePath} — nothing was checked.`);
    console.warn(`Expected a ${EXPERIENCE_HEADING_NAMES.map((name) => `"## ${name}"`).join(' / ')} section with "### Company — Location" headers (em dash, en dash, or hyphens); review the tailored CV structure manually.`);
    return 0;
  }
  if (result.verdict === 'pass') {
    console.log(`CV structure check passed: ${basename(targetPath)}`);
    return 0;
  }
  console.warn(`⚠️  CV structure check found possible regressions: ${basename(targetPath)}`);
  if (result.orderViolations.length) {
    console.warn('\nExperience entries out of cv.md order:');
    for (const v of result.orderViolations) console.warn(`  - ${v}`);
  }
  if (result.descriptorViolations.length) {
    console.warn('\nMissing company descriptors:');
    for (const v of result.descriptorViolations) console.warn(`  - ${v}`);
  }
  console.warn('\nThis is a warning, not a blocking gate — review against cv.md and fix the payload if the loss was unintentional, then rebuild the HTML and PDF.');
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}
