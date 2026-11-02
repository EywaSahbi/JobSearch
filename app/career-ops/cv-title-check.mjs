#!/usr/bin/env node

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { normalizeCompany } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  boldLineText, findExperienceSections, headingText, toPlainText, EXPERIENCE_HEADING_NAMES,
} from './lib/cv-markdown.mjs';

const CV_PATH = join(getCareerOpsRoot(), 'cv.md');

export function parseCvExperience(cvText) {
  const entries = [];

  for (const lines of findExperienceSections(cvText)) {
    for (let i = 0; i < lines.length; i++) {
      const heading = headingText(lines[i], 3);
      if (heading === null) continue;

      const [companyPart] = heading.split(/\s+[-–—]{1,2}\s+/);
      const company = companyPart.trim();
      if (!company) continue;

      let title = null;
      let dates = null;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^#{2,3}\s+/.test(next)) break;
        if (next.trim() === '') continue;
        if (title === null) {
          const bold = boldLineText(next);
          if (bold) {
            title = bold;
            continue;
          }
          break;
        }
        if (dates === null) {
          dates = toPlainText(next);
        }
        break;
      }

      if (title && dates) entries.push({ company, title, dates });
    }
  }

  return entries;
}

export function parseTailoredExperience(payload) {
  const experience = payload?.experience;
  if (!Array.isArray(experience)) {
    throw new Error('tailored CV payload must contain an experience array');
  }
  const parsed = [];
  const incomplete = [];

  experience.forEach((e, index) => {
    const company = String(e?.company ?? '').trim();
    const title = String(e?.role ?? '').trim();
    const dates = String(e?.dates ?? '').trim();
    const missingFields = [];
    if (!company) missingFields.push('company');
    if (!title) missingFields.push('role');
    if (!dates) missingFields.push('dates');

    if (missingFields.length > 0) {
      incomplete.push(`experience[${index}] is missing ${missingFields.join(', ')}`);
    } else {
      parsed.push({ company, title, dates });
    }
  });

  if (incomplete.length > 0) {
    throw new Error(
      `tailored CV payload has ${incomplete.length} incomplete experience entr${incomplete.length === 1 ? 'y' : 'ies'} — ` +
      `title check cannot run on a partial comparison set: ${incomplete.join('; ')}`
    );
  }

  return parsed;
}

export function normalizeDates(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s*-+\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchKey(company, dates) {
  return `${normalizeCompany(company)}||${normalizeDates(dates)}`;
}

function groupByKey(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = matchKey(entry.company, entry.dates);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

export function checkTitles(cvEntries, tailoredEntries) {
  const cvGroups = groupByKey(cvEntries);
  const tailoredGroups = groupByKey(tailoredEntries);

  const matched = [];
  const mismatches = [];
  const ambiguous = [];
  const unmatchedTailored = [];
  const unmatchedCv = [];
  const seenKeys = new Set();

  for (const [key, tailoredGroup] of tailoredGroups) {
    seenKeys.add(key);
    const cvGroup = cvGroups.get(key);

    if (!cvGroup) {
      unmatchedTailored.push(...tailoredGroup);
      continue;
    }

    if (cvGroup.length > 1 || tailoredGroup.length > 1) {
      ambiguous.push({
        company: cvGroup[0].company,
        dates: cvGroup[0].dates,
        cvTitles: cvGroup.map(e => e.title),
        tailoredTitles: tailoredGroup.map(e => e.title),
      });
      continue;
    }

    const cvEntry = cvGroup[0];
    const t = tailoredGroup[0];
    const pair = {
      company: cvEntry.company,
      dates: cvEntry.dates,
      cvTitle: cvEntry.title,
      tailoredTitle: t.title,
    };
    if (normalizeTitle(cvEntry.title) === normalizeTitle(t.title)) {
      matched.push(pair);
    } else {
      mismatches.push(pair);
    }
  }

  for (const [key, cvGroup] of cvGroups) {
    if (!seenKeys.has(key)) unmatchedCv.push(...cvGroup);
  }

  return { matched, mismatches, ambiguous, unmatchedTailored, unmatchedCv };
}

export function diagnoseUnverified(cvEntries, tailoredEntries, result) {
  if (tailoredEntries.length === 0) return null;
  if (result.matched.length + result.mismatches.length + result.ambiguous.length > 0) return null;
  if (cvEntries.length === 0) {
    return {
      reason: 'cv-unparsed',
      message:
        'cv.md entries could not be parsed — title check did not run. ' +
        `Expected a "## ${EXPERIENCE_HEADING_NAMES.join('" / "## ')}" section whose entries are ` +
        '"### Company — Location", then a bold **Title** line, then a dates line (see examples/cv-example.md).',
    };
  }
  return {
    reason: 'no-pairs',
    message:
      `cv.md has ${cvEntries.length} parsed entr${cvEntries.length === 1 ? 'y' : 'ies'}, but no tailored entry ` +
      'matched one by {company, dates} — title check did not run. Compare the company names and date ' +
      'phrasing in the payload against cv.md.',
  };
}

function runSelfTest() {
  let passed = 0, failed = 0;
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
      passed++;
    } else {
      failed++;
      console.log(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
    }
  };

  const cvText = `
# CV -- Jane Doe

## Work Experience

### Acme Corp -- Remote

**Senior Software Engineer**
2020-2024

- Did things

### Globex Inc. -- Austin, TX

**Engineer**
2018-2020

- Did other things

## Projects

### Not A Job -- should be ignored
`;

  const cvEntries = parseCvExperience(cvText);
  eq('parses two experience entries from cv.md', cvEntries.length, 2);
  eq('does not parse ### headings outside Work Experience', cvEntries.some(e => e.company === 'Not A Job'), false);

  const unchangedPayload = { experience: [{ company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' }] };
  const unchangedResult = checkTitles(cvEntries, parseTailoredExperience(unchangedPayload));
  eq('unchanged title produces zero mismatches', unchangedResult.mismatches.length, 0);
  eq('unchanged title is reported as matched', unchangedResult.matched.length, 1);

  const driftedPayload = { experience: [{ company: 'Acme Corp', role: 'Engineering Lead', dates: '2020-2024' }] };
  const driftedResult = checkTitles(cvEntries, parseTailoredExperience(driftedPayload));
  eq('drifted title produces one mismatch', driftedResult.mismatches.length, 1);
  eq('mismatch carries the cv.md canonical title', driftedResult.mismatches[0]?.cvTitle, 'Senior Software Engineer');
  eq('mismatch carries the tailored CV title', driftedResult.mismatches[0]?.tailoredTitle, 'Engineering Lead');

  const formattingPayload = { experience: [{ company: '  Globex   Inc  ', role: 'Engineer', dates: '2018 - 2020' }] };
  const formattingResult = checkTitles(cvEntries, parseTailoredExperience(formattingPayload));
  eq('company formatting differences still pair the entry', formattingResult.mismatches.length + formattingResult.matched.length, 1);
  eq('formatting-only differences do not produce a false mismatch', formattingResult.mismatches.length, 0);
  eq('formatting-only differences still match', formattingResult.matched.length, 1);

  const unmatchedPayload = { experience: [{ company: 'Brand New Co', role: 'Founder', dates: '2024-Present' }] };
  const unmatchedResult = checkTitles(cvEntries, parseTailoredExperience(unmatchedPayload));
  eq('an entry with no cv.md counterpart is unmatched, not a mismatch', unmatchedResult.unmatchedTailored.length, 1);
  eq('an unmatched entry never appears as a mismatch', unmatchedResult.mismatches.length, 0);

  const caseOnlyPayload = { experience: [{ company: 'Acme Corp', role: '  senior software engineer ', dates: '2020-2024' }] };
  const caseOnlyResult = checkTitles(cvEntries, parseTailoredExperience(caseOnlyPayload));
  eq('case/whitespace-only title differences are not a mismatch', caseOnlyResult.mismatches.length, 0);

  const throwsFor = (label, payload) => {
    try {
      parseTailoredExperience(payload);
      failed++;
      console.log(`  FAIL: ${label}\n    expected: throw\n    actual:   no throw`);
    } catch {
      passed++;
    }
  };
  throwsFor('an entry missing dates throws instead of being dropped', {
    experience: [{ company: 'Acme Corp', role: 'Senior Software Engineer' }],
  });
  throwsFor('an entry missing role throws instead of being dropped', {
    experience: [{ company: 'Acme Corp', dates: '2020-2024' }],
  });
  throwsFor('an entry missing company throws instead of being dropped', {
    experience: [{ role: 'Senior Software Engineer', dates: '2020-2024' }],
  });
  throwsFor('one incomplete entry throws even alongside an otherwise-valid entry (no partial comparison)', {
    experience: [
      { company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' },
      { company: 'Globex Inc.', role: 'Engineer' },
    ],
  });
  try {
    parseTailoredExperience({
      experience: [{ company: 'Acme Corp', role: 'Senior Software Engineer' }],
    });
    failed++;
    console.log('  FAIL: incomplete-entry error names the missing field\n    expected: throw mentioning "dates"\n    actual:   no throw');
  } catch (err) {
    eq('incomplete-entry error names the missing field', err.message.includes('dates'), true);
    eq('incomplete-entry error names the entry index', err.message.includes('experience[0]'), true);
  }

  throwsFor('a payload with no experience key throws instead of defaulting to []', {});
  throwsFor('a non-array experience value (object) throws', { experience: {} });
  throwsFor('a non-array experience value (string) throws', { experience: 'none' });
  eq('an explicit empty experience array is still valid (no experience entries)',
    parseTailoredExperience({ experience: [] }).length, 0);

  const dupCvText = `
# CV -- Jane Doe

## Work Experience

### Acme Corp -- Remote

**Senior Software Engineer**
2020-2024

- Did things

### Acme Corp -- Remote

**Contractor**
2020-2024

- Did other things
`;
  const dupCvEntries = parseCvExperience(dupCvText);
  eq('parses both duplicate-key cv.md entries (neither is dropped)', dupCvEntries.length, 2);
  const dupCvPayload = { experience: [{ company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' }] };
  const dupCvResult = checkTitles(dupCvEntries, parseTailoredExperience(dupCvPayload));
  eq('a cv.md-side duplicate key is reported as ambiguous', dupCvResult.ambiguous.length, 1);
  eq('an ambiguous cv.md-side key is not silently matched', dupCvResult.matched.length, 0);
  eq('an ambiguous cv.md-side key is not silently reported as a mismatch either', dupCvResult.mismatches.length, 0);
  eq('the ambiguous group carries both cv.md titles', dupCvResult.ambiguous[0]?.cvTitles.sort(), ['Contractor', 'Senior Software Engineer']);

  const dupTailoredPayload = {
    experience: [
      { company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' },
      { company: 'Acme Corp', role: 'Engineering Lead', dates: '2020-2024' },
    ],
  };
  const dupTailoredResult = checkTitles(cvEntries, parseTailoredExperience(dupTailoredPayload));
  eq('a tailored-CV-side duplicate key is reported as ambiguous', dupTailoredResult.ambiguous.length, 1);
  eq('an ambiguous tailored-CV-side key is not silently matched', dupTailoredResult.matched.length, 0);
  eq('an ambiguous tailored-CV-side key is not silently reported as a mismatch either', dupTailoredResult.mismatches.length, 0);
  eq('the ambiguous group carries both tailored titles', dupTailoredResult.ambiguous[0]?.tailoredTitles.sort(), ['Engineering Lead', 'Senior Software Engineer']);

  const pandocCv = [
    '# Jane Example',
    '',
    '## **[Technical Platforms & Tools]{.smallcaps}**',
    '',
    '- Cloud: AWS, Kubernetes, Terraform',
    '',
    '## **[Professional Experience]{.smallcaps}**',
    '',
    '### **Acme Health, Inc.** --- New York, NY (Remote)',
    '',
    '**Senior Director, Platform Engineering**\\',
    '**09/2021 -- Present**',
    '',
    '- Owned the cloud platform.',
    '',
    '### **Globex Corp.** --- Stamford, CT',
    '',
    '**Principal Infrastructure Engineer**\\',
    '**03/2015 -- 08/2021**',
    '',
    '- Built the data platform.',
  ].join('\n');
  const pandocEntries = parseCvExperience(pandocCv);
  eq('Pandoc cv.md: parses both experience entries', pandocEntries, [
    { company: 'Acme Health, Inc.', title: 'Senior Director, Platform Engineering', dates: '09/2021 – Present' },
    { company: 'Globex Corp.', title: 'Principal Infrastructure Engineer', dates: '03/2015 – 08/2021' },
  ]);
  const inflatedPayload = { experience: [
    { company: 'Acme Health, Inc.', role: 'VP, Platform Engineering', dates: '09/2021 - Present' },
    { company: 'Globex Corp.', role: 'Principal Infrastructure Engineer', dates: '03/2015 - 08/2021' },
  ] };
  const pandocResult = checkTitles(pandocEntries, parseTailoredExperience(inflatedPayload));
  eq('Pandoc cv.md: the planted title inflation is caught', pandocResult.mismatches.map(m => m.tailoredTitle), ['VP, Platform Engineering']);
  eq('Pandoc cv.md: the unchanged title still matches', pandocResult.matched.length, 1);
  eq('Pandoc cv.md: a conclusive run is not flagged unverified',
    diagnoseUnverified(pandocEntries, parseTailoredExperience(inflatedPayload), pandocResult), null);

  const oneEntry = (h2, h3, title, dates) => parseCvExperience(`${h2}\n\n${h3}\n\n${title}\n${dates}\n`);
  const plainEntry = [{ company: 'Co', title: 'Engineer', dates: '2020-2024' }];
  for (const heading of ['Experience', 'Work Experience', 'Professional Experience', 'Employment History', 'Work History']) {
    eq(`"## ${heading}" is a recognized Experience section`, oneEntry(`## ${heading}`, '### Co -- City', '**Engineer**', '2020-2024'), plainEntry);
  }
  eq('a bold + span h2 is recognized', oneEntry('## **[Experience]{.smallcaps}**', '### Co -- City', '**Engineer**', '2020-2024'), plainEntry);
  eq('a Pandoc {#id} attribute on the h2 is ignored', oneEntry('## Experience {#experience}', '### Co -- City', '**Engineer**', '2020-2024'), plainEntry);
  eq('"---" between company and location splits like "--"', oneEntry('## Experience', '### Co --- City', '**Engineer**', '2020-2024'), plainEntry);
  eq('a bold company heading is unwrapped', oneEntry('## Experience', '### **Co** -- City', '**Engineer**', '2020-2024'), plainEntry);
  eq('a trailing hard-break backslash on the title line is dropped', oneEntry('## Experience', '### Co -- City', '**Engineer**\\', '2020-2024'), plainEntry);
  eq('escaped characters in a title are unescaped', oneEntry('## Experience', '### Co -- City', '**C\\# \\| Engineer**', '2020-2024')[0]?.title, 'C# | Engineer');
  eq('an unrelated "## Skills" section is still not Experience', oneEntry('## Skills', '### Co -- City', '**Engineer**', '2020-2024'), []);

  eq('"--" dates equal "-" dates', normalizeDates('09/2021 -- Present'), normalizeDates('09/2021 - Present'));
  eq('"–" dates equal "-" dates', normalizeDates('09/2021 – Present'), normalizeDates('09/2021 - Present'));
  eq('"—" dates equal "-" dates', normalizeDates('09/2021 — Present'), normalizeDates('09/2021-Present'));

  const someTailored = parseTailoredExperience(inflatedPayload);
  eq('zero parsed cv.md entries is unverified (cv-unparsed)',
    diagnoseUnverified([], someTailored, checkTitles([], someTailored))?.reason, 'cv-unparsed');
  const strangers = parseTailoredExperience({ experience: [{ company: 'Initech', role: 'Engineer', dates: '1999' }] });
  eq('parsed cv.md entries with no pairs is unverified (no-pairs)',
    diagnoseUnverified(cvEntries, strangers, checkTitles(cvEntries, strangers))?.reason, 'no-pairs');
  eq('an empty payload is not flagged (nothing to check)',
    diagnoseUnverified(cvEntries, [], checkTitles(cvEntries, []))?.reason ?? null, null);
  const ambiguousOnly = checkTitles(dupCvEntries, parseTailoredExperience(dupCvPayload));
  eq('an ambiguous-only run is reported as ambiguous, not as unverified',
    diagnoseUnverified(dupCvEntries, parseTailoredExperience(dupCvPayload), ambiguousOnly), null);

  const scriptPath = fileURLToPath(import.meta.url);
  const cliTmp = mkdtempSync(join(tmpdir(), 'cv-title-check-cli-'));
  try {
    const validCv = `
# CV -- Jane Doe

## Work Experience

### Acme Corp -- Remote

**Senior Software Engineer**
2020-2024

- Did things
`;
    writeFileSync(join(cliTmp, 'cv.md'), validCv);

    const runCli = (args, cwd = cliTmp, root = cwd) => spawnSync(process.execPath, [scriptPath, ...args], {
      cwd, encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: root },
    });

    eq('CLI exits 1 with no payload argument', runCli([]).status, 1);

    eq('CLI exits 1 when the payload file does not exist', runCli(['does-not-exist.json']).status, 1);

    const noCvDir = mkdtempSync(join(tmpdir(), 'cv-title-check-nocv-'));
    try {
      writeFileSync(join(noCvDir, 'payload.json'), JSON.stringify({ experience: [] }));
      eq('CLI exits 1 when cv.md does not exist', runCli(['payload.json'], noCvDir).status, 1);
    } finally {
      rmSync(noCvDir, { recursive: true, force: true });
    }

    writeFileSync(join(cliTmp, 'malformed.json'), '{ this is not valid json');
    eq('CLI exits 1 on a malformed JSON payload', runCli(['malformed.json']).status, 1);

    writeFileSync(join(cliTmp, 'partial.json'), JSON.stringify({
      experience: [
        { company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' },
        { company: 'Globex Inc.', role: 'Engineer' },
      ],
    }));
    const partialRun = runCli(['partial.json', '--summary']);
    eq('CLI exits 1 for a payload with one incomplete experience entry (no silent partial comparison)', partialRun.status, 1);
    eq('the exit-1 partial-payload run does not print a clean-result summary', /No title drift found/i.test(partialRun.stdout), false);

    writeFileSync(join(cliTmp, 'mismatch.json'), JSON.stringify({
      experience: [{ company: 'Acme Corp', role: 'Engineering Lead', dates: '2020-2024' }],
    }));
    const mismatchRun = runCli(['mismatch.json', '--summary']);
    eq('CLI exits 0 for a completed comparison that finds a title mismatch (warn-only)', mismatchRun.status, 0);
    eq('the exit-0 mismatch run still prints the warning', /title mismatch/i.test(mismatchRun.stdout), true);

    const unparsedDir = mkdtempSync(join(tmpdir(), 'cv-title-check-unparsed-'));
    try {
      writeFileSync(join(unparsedDir, 'cv.md'), '# Jane Doe\n\n## Career\n\n### Acme Corp -- Remote\n\n**Senior Software Engineer**\n2020-2024\n');
      writeFileSync(join(unparsedDir, 'p.json'), JSON.stringify({
        experience: [{ company: 'Acme Corp', role: 'Engineering Lead', dates: '2020-2024' }],
      }));
      const unparsedRun = runCli(['p.json', '--summary'], unparsedDir);
      eq('CLI exits 0 when cv.md cannot be parsed (warn-only)', unparsedRun.status, 0);
      eq('an unparsed cv.md never prints the green check', /✅/.test(unparsedRun.stdout), false);
      eq('an unparsed cv.md says the title check did not run', /title check did not run/.test(unparsedRun.stdout), true);
      const unparsedJson = JSON.parse(runCli(['p.json'], unparsedDir).stdout);
      eq('JSON output carries the unverified reason', unparsedJson.unverified?.reason, 'cv-unparsed');
    } finally {
      rmSync(unparsedDir, { recursive: true, force: true });
    }

    const rootDir = mkdtempSync(join(tmpdir(), 'cv-title-check-root-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'cv-title-check-cwd-'));
    try {
      writeFileSync(join(rootDir, 'cv.md'), validCv);
      writeFileSync(join(cwdDir, 'cv.md'), '# Decoy\n');
      writeFileSync(join(cwdDir, 'p.json'), JSON.stringify({
        experience: [{ company: 'Acme Corp', role: 'Engineering Lead', dates: '2020-2024' }],
      }));
      const rootRun = runCli(['p.json', '--summary'], cwdDir, rootDir);
      eq('CLI reads cv.md from CAREER_OPS_ROOT, not the cwd', /title mismatch/i.test(rootRun.stdout), true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }

    const ambiguousCv = validCv + `
### Acme Corp -- Remote

**Contractor**
2020-2024

- Did other things
`;
    const ambiguousDir = mkdtempSync(join(tmpdir(), 'cv-title-check-ambiguous-'));
    try {
      writeFileSync(join(ambiguousDir, 'cv.md'), ambiguousCv);
      writeFileSync(join(ambiguousDir, 'mismatch.json'), JSON.stringify({
        experience: [{ company: 'Acme Corp', role: 'Senior Software Engineer', dates: '2020-2024' }],
      }));
      const ambiguousRun = runCli(['mismatch.json', '--summary'], ambiguousDir);
      eq('CLI exits 0 for a completed comparison that finds an ambiguous group (warn-only)', ambiguousRun.status, 0);
      eq('the exit-0 ambiguous run still prints the warning', /ambiguous/i.test(ambiguousRun.stdout), true);
    } finally {
      rmSync(ambiguousDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(cliTmp, { recursive: true, force: true });
  }

  console.log(`\ncv-title-check self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const payloadPathArg = args.find(a => !a.startsWith('--'));

if (isMainModule(import.meta.url)) {
  if (selfTestMode) {
    runSelfTest();
  } else {
    if (!payloadPathArg || !existsSync(payloadPathArg)) {
      console.error('Usage: node cv-title-check.mjs <tailored-cv-payload.json> [--summary]');
      console.error('       node cv-title-check.mjs --self-test');
      process.exit(1);
    }
    if (!existsSync(CV_PATH)) {
      console.error(`Error: ${CV_PATH} not found — this is a user-layer file, create it first.`);
      process.exit(1);
    }

    let payload;
    try {
      payload = JSON.parse(readFileSync(payloadPathArg, 'utf-8'));
    } catch (err) {
      console.error(`Error: could not parse ${payloadPathArg} as JSON: ${err.message}`);
      process.exit(1);
    }

    const cvEntries = parseCvExperience(readFileSync(CV_PATH, 'utf-8'));
    let tailoredEntries;
    try {
      tailoredEntries = parseTailoredExperience(payload);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const result = checkTitles(cvEntries, tailoredEntries);
    const unverified = diagnoseUnverified(cvEntries, tailoredEntries, result);
    const compared = result.matched.length + result.mismatches.length;

    if (summaryMode) {
      console.log('\nCV Title Consistency Check');
      console.log('─'.repeat(40));
      console.log(`Entries compared: ${compared}`);
      if (unverified) {
        console.log(`⚠️  ${unverified.message}`);
      } else if (result.mismatches.length > 0) {
        console.log(`⚠️  ${result.mismatches.length} title mismatch(es) found:`);
        for (const m of result.mismatches) {
          console.log(`\n  ${m.company} (${m.dates})`);
          console.log(`    cv.md:        "${m.cvTitle}"`);
          console.log(`    tailored CV:  "${m.tailoredTitle}"`);
        }
      } else if (compared > 0 || tailoredEntries.length === 0) {
        console.log('✅ No title drift found — every matched entry uses cv.md\'s canonical title.');
      }
      if (result.ambiguous.length > 0) {
        console.log(`\n⚠️  ${result.ambiguous.length} ambiguous {company, dates} key(s) — multiple entries on one or both sides, not auto-resolved:`);
        for (const a of result.ambiguous) {
          console.log(`\n  ${a.company} (${a.dates})`);
          console.log(`    cv.md titles:        ${a.cvTitles.map(t => `"${t}"`).join(', ')}`);
          console.log(`    tailored CV titles:  ${a.tailoredTitles.map(t => `"${t}"`).join(', ')}`);
        }
      }
      if (result.unmatchedTailored.length > 0) {
        console.log(`\n  (${result.unmatchedTailored.length} tailored entr${result.unmatchedTailored.length === 1 ? 'y has' : 'ies have'} no matching {company, dates} in cv.md — not checked)`);
      }
    } else {
      console.log(JSON.stringify({ ...result, unverified }, null, 2));
    }

    process.exit(0);
  }
}
