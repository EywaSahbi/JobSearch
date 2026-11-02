#!/usr/bin/env node

import { readFileSync } from 'fs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DEFAULT_COMPETENCIES_TITLE = 'Core Competencies';

function toItemList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : [];
  return raw
    .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function categoryKey(name) {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

function resolveCompetenciesCategory(payload) {
  return (typeof payload?.sections?.competencies === 'string'
    && payload.sections.competencies.trim())
    || DEFAULT_COMPETENCIES_TITLE;
}

function lostMembers(list) {
  const lost = [];
  list.forEach((value, index) => {
    if (value === null || value === undefined || typeof value === 'object') {
      lost.push({ index, type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value });
    }
  });
  return lost;
}

export function validatePayloadShape(payload) {
  const errors = [];
  const shapeOf = (v) => (Array.isArray(v) ? 'array' : typeof v);
  const present = (v) => v !== undefined && v !== null;

  if (present(payload.skills) && !Array.isArray(payload.skills)) {
    errors.push(`\`skills\` must be an array of {category, items} objects, got ${shapeOf(payload.skills)}. `
      + 'Folding into it would silently discard the value you supplied.');
  }
  if (present(payload.competencies)
      && !Array.isArray(payload.competencies)
      && typeof payload.competencies !== 'string') {
    errors.push(`\`competencies\` must be an array of strings (a comma-separated string is also accepted), `
      + `got ${shapeOf(payload.competencies)}.`);
  }
  if (present(payload.experience) && !Array.isArray(payload.experience)) {
    errors.push(`\`experience\` must be an array of entries, got ${shapeOf(payload.experience)}. `
      + 'The lints would report nothing, which is indistinguishable from a clean payload.');
  }

  const describe = (lost) => lost.map((l) => `[${l.index}] (${l.type})`).join(', ');
  if (Array.isArray(payload.competencies)) {
    const lost = lostMembers(payload.competencies);
    if (lost.length > 0) {
      errors.push(`\`competencies\` has ${lost.length} member(s) with no scalar value to move: `
        + `${describe(lost)}. They would be dropped rather than folded. `
        + 'Strings are expected; numbers and booleans are coerced.');
    }
  }

  if (toItemList(payload.competencies).length > 0 && Array.isArray(payload.skills)) {
    const category = resolveCompetenciesCategory(payload);
    const target = payload.skills.find(
      (entry) => entry && typeof entry === 'object' && categoryKey(entry.category) === categoryKey(category),
    );
    if (target && Array.isArray(target.items)) {
      const lost = lostMembers(target.items);
      if (lost.length > 0) {
        errors.push(`the existing \`${category}\` skills category has ${lost.length} member(s) in \`items\` `
          + `with no scalar value: ${describe(lost)}. Merging the competencies into it would drop them.`);
      }
    } else if (target && present(target.items) && typeof target.items !== 'string') {
      errors.push(`the existing \`${category}\` skills category has \`items\` of type `
        + `${shapeOf(target.items)}; a string or array is expected. Merging the competencies `
        + 'into it would overwrite that value.');
    }
  }

  return errors;
}

export function foldCompetencies(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const competencies = toItemList(source.competencies);
  const category = resolveCompetenciesCategory(source);

  if (competencies.length === 0) {
    return {
      payload: source,
      transform: {
        name: 'fold-competencies-into-skills',
        applied: false,
        reason: 'no competencies to fold',
        category,
        moved: 0,
      },
    };
  }

  const skills = Array.isArray(source.skills) ? source.skills : [];
  const existingIndex = skills.findIndex(
    (s) => s && typeof s === 'object' && categoryKey(s.category) === categoryKey(category),
  );

  let nextSkills;
  let merged;
  if (existingIndex === -1) {
    nextSkills = [{ category, items: competencies.join(', ') }, ...skills];
    merged = false;
  } else {
    const existing = skills[existingIndex];
    const existingItems = toItemList(existing.items);
    const seen = new Set(existingItems.map((i) => i.toLowerCase()));
    const added = competencies.filter((i) => {
      const key = i.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    nextSkills = skills.slice();
    nextSkills[existingIndex] = {
      ...existing,
      items: [...existingItems, ...added].join(', '),
    };
    merged = true;
  }

  return {
    payload: { ...source, competencies: [], skills: nextSkills },
    transform: {
      name: 'fold-competencies-into-skills',
      applied: true,
      merged,
      category,
      moved: competencies.length,
      items: competencies,
    },
  };
}

const CORPORATE_SUFFIX_RE = /\b(?:inc|llc|l\.l\.c|ltd|limited|gmbh|mbh|ag|s\.?a\.?s|sarl|s\.?a|s\.?l|b\.?v|n\.?v|plc|corp|corporation|co|company|pty|oy|ab|a\/s|aps|kk|k\.k|holdings|group)\b\.?/i;

const EMPLOYER_PREPOSITION_RE = /(?:\s(?:at|@)\s|\s@|^@)/i;

const CLIENT_MARKER_RE = /\b(?:client|customer|on behalf of|seconded to|via|through)\s*[:—–-]?\s*\S/i;

const PARENTHETICAL_RE = /[(（]\s*([^)）]*?)\s*[)）]/;

const DATE_POINT = '(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s*,?\\s*\\d{4}'
  + '|\\d{1,2}\\s*[/.]\\s*\\d{4}'
  + '|\\d{4}'
  + '|present|current|now|ongoing|date)';
const DATE_SEPARATOR = '\\s*(?:[-–—]{1,2}|\\bto\\b|\\buntil\\b|\\bthrough\\b)\\s*';
const DATE_RANGE_RE = new RegExp(`${DATE_POINT}${DATE_SEPARATOR}${DATE_POINT}`, 'gi');

export function countDateRanges(dates) {
  if (typeof dates !== 'string') return 0;
  DATE_RANGE_RE.lastIndex = 0;
  return (dates.match(DATE_RANGE_RE) || []).length;
}

function containsAsToken(haystack, needle) {
  const hay = String(haystack).toLowerCase();
  const need = String(needle).trim().toLowerCase();
  if (need.length < 3) return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(need, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + need.length] ?? '';
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
    from = at + 1;
  }
}

export function lintPayload(payload) {
  const entries = Array.isArray(payload?.experience) ? payload.experience : [];
  const findings = [];

  const knownCompanies = entries
    .filter((e) => e && typeof e === 'object' && typeof e.company === 'string')
    .map((e) => e.company.trim())
    .filter((c) => c.length >= 3);

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;

    const role = typeof entry.role === 'string' ? entry.role : '';
    if (role) {
      const signals = [];
      if (CORPORATE_SUFFIX_RE.test(role)) signals.push('corporate-suffix');
      if (EMPLOYER_PREPOSITION_RE.test(role)) signals.push('employer-preposition');
      if (CLIENT_MARKER_RE.test(role)) signals.push('client-marker');
      const matchedCompany = knownCompanies.find((c) => containsAsToken(role, c));
      if (matchedCompany) signals.push('known-company-name');
      if (signals.length > 0) {
        findings.push({
          code: 'employer-in-role',
          severity: 'review',
          path: `experience[${index}].role`,
          value: role,
          signals,
          ...(matchedCompany ? { matchedCompany } : {}),
          message: `Role reads as if it carries an employer name (${signals.join(', ')}). `
            + 'A parser lifts that into the employer field and the record gains a phantom '
            + 'employer. Rewriting a job title is authoring, not cleanup — decide yourself '
            + 'whether the employer belongs in `company` instead.',
        });
      }
    }

    const company = typeof entry.company === 'string' ? entry.company : '';
    const paren = company.match(PARENTHETICAL_RE);
    if (paren) {
      findings.push({
        code: 'parenthetical-in-company',
        severity: 'review',
        path: `experience[${index}].company`,
        value: company,
        parenthetical: paren[1],
        message: `The parenthetical "${paren[1]}" is kept verbatim as part of the employer `
          + 'name, so the record matches no search for the employer. Stripping it is easy; '
          + 'deciding where that detail goes instead (role, location, a bullet) is yours.',
      });
    }

    const dates = typeof entry.dates === 'string' ? entry.dates : '';
    const ranges = countDateRanges(dates);
    if (ranges > 1) {
      findings.push({
        code: 'multiple-date-ranges',
        severity: 'review',
        path: `experience[${index}].dates`,
        value: dates,
        ranges,
        message: `${ranges} date ranges in one entry parse as one continuous stint. Splitting `
          + 'them into separate entries needs someone to decide which bullets belong to which '
          + 'stint — this script can see the second range, it cannot allocate the bullets.',
      });
    }
  });

  return findings;
}

export function transformPayload(payload) {
  const { payload: folded, transform } = foldCompetencies(payload);
  return { payload: folded, transform, findings: lintPayload(folded) };
}

function formatSummary({ transform, findings }) {
  const lines = [];
  lines.push('');
  lines.push('ATS Payload Transform');
  lines.push('─'.repeat(60));
  if (transform.applied) {
    lines.push(`  ✅ Folded ${transform.moved} competenc${transform.moved === 1 ? 'y' : 'ies'} `
      + `into skills[] as "${transform.category}" (${transform.merged ? 'merged into existing category' : 'new category'}).`);
  } else {
    lines.push(`  ⏭️  No fold applied — ${transform.reason}.`);
  }
  lines.push('');
  if (findings.length === 0) {
    lines.push('  ✅ No lint findings.');
  } else {
    lines.push(`  ⚠️  ${findings.length} finding${findings.length === 1 ? '' : 's'} — reported, NOT applied:`);
    for (const f of findings) {
      lines.push('');
      lines.push(`  [${f.code}] ${f.path}`);
      lines.push(`     value: ${f.value}`);
      lines.push(`     ${f.message}`);
    }
  }
  lines.push('');
  lines.push('  The transformed payload is on stdout; these findings are yours to decide on.');
  lines.push('');
  return lines.join('\n');
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const eq = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
  };

  const base = {
    competencies: ['RAG Pipelines', 'LLMOps', 'Kubernetes & Docker'],
    skills: [{ category: 'Languages', items: 'Python, Go' }],
  };
  const once = transformPayload(base);
  eq('competencies are emptied', once.payload.competencies, []);
  eq('competencies become a comma-delimited skills category',
    once.payload.skills[0], { category: 'Core Competencies', items: 'RAG Pipelines, LLMOps, Kubernetes & Docker' });
  eq('the existing skills categories survive after it', once.payload.skills[1], base.skills[0]);
  eq('the input payload is not mutated', base.competencies.length, 3);

  const twice = transformPayload(once.payload);
  eq('a second run is a no-op on skills', twice.payload.skills, once.payload.skills);
  eq('a second run applies no fold', twice.transform.applied, false);
  eq('a second run leaves competencies empty', twice.payload.competencies, []);

  const reAdded = { ...once.payload, competencies: ['LLMOps', 'Evaluation Harnesses'] };
  const remerged = transformPayload(reAdded);
  eq('a re-added competency merges instead of duplicating the category',
    remerged.payload.skills.filter((s) => s.category === 'Core Competencies').length, 1);
  eq('the merge unions items and drops the duplicate',
    remerged.payload.skills[0].items, 'RAG Pipelines, LLMOps, Kubernetes & Docker, Evaluation Harnesses');
  eq('the merge is reported as a merge', remerged.transform.merged, true);

  const localized = transformPayload({
    sections: { competencies: 'Competencias Clave' },
    competencies: ['Arquitectura Cloud'],
  });
  eq('a localized section title becomes the category label',
    localized.payload.skills[0].category, 'Competencias Clave');

  eq('an absent competencies key applies no fold', foldCompetencies({}).transform.applied, false);
  eq('an empty competencies array applies no fold', foldCompetencies({ competencies: [] }).transform.applied, false);
  eq('a payload with no skills key still gets the folded category',
    foldCompetencies({ competencies: ['A'] }).payload.skills.length, 1);

  eq('a string skills field is refused, naming the field',
    validatePayloadShape({ competencies: ['AWS'], skills: 'Python' }).length, 1);
  eq('the skills error says the value would be discarded',
    /skills.*discard/is.test(validatePayloadShape({ competencies: ['AWS'], skills: 'Python' })[0]), true);
  eq('a non-array experience is refused',
    validatePayloadShape({ experience: { company: 'Acme' } }).length, 1);
  eq('an object competencies field is refused',
    validatePayloadShape({ competencies: { a: 1 } }).length, 1);

  eq('a valid payload passes validation',
    validatePayloadShape({ competencies: ['AWS'], skills: [{ category: 'L', items: 'Go' }], experience: [] }), []);
  eq('absent fields pass validation', validatePayloadShape({}), []);
  eq('null fields mean "not supplied" and pass validation',
    validatePayloadShape({ skills: null, competencies: null, experience: null }), []);
  eq('a comma-separated competencies string is accepted, not refused',
    validatePayloadShape({ competencies: 'AWS, GCP' }), []);
  eq('and that string still folds into a category',
    foldCompetencies({ competencies: 'AWS, GCP' }).payload.skills[0].items, 'AWS, GCP');

  const mixed = { competencies: ['AWS', { name: 'Kubernetes' }] };
  eq('a mixed-type competencies array is refused', validatePayloadShape(mixed).length, 1);
  eq('the error names the offending index and type',
    /\[1\] \(object\)/.test(validatePayloadShape(mixed)[0]), true);
  eq('and that member really was being dropped before the guard',
    foldCompetencies(mixed).payload.skills[0].items, 'AWS');
  eq('a null member is refused too',
    validatePayloadShape({ competencies: ['AWS', null] }).length, 1);
  eq('a nested-array member is refused too',
    validatePayloadShape({ competencies: ['AWS', ['GCP']] }).length, 1);

  eq('a numeric competency is accepted, not refused',
    validatePayloadShape({ competencies: ['AWS', 2024] }), []);
  eq('and it keeps its value through the fold',
    foldCompetencies({ competencies: ['AWS', 2024] }).payload.skills[0].items, 'AWS, 2024');
  eq('a boolean competency is accepted too',
    validatePayloadShape({ competencies: [true] }), []);

  eq('a non-scalar in the merged-into skills category is refused',
    validatePayloadShape({
      competencies: ['A'],
      skills: [{ category: 'Core Competencies', items: ['X', { y: 1 }] }],
    }).length, 1);
  eq('an untouched skills category is not policed for it',
    validatePayloadShape({
      competencies: ['A'],
      skills: [{ category: 'Languages', items: ['X', { y: 1 }] }],
    }), []);
  eq('and neither is it when no fold will happen',
    validatePayloadShape({
      skills: [{ category: 'Core Competencies', items: ['X', { y: 1 }] }],
    }), []);

  const scalarItems = (items) => ({ competencies: ['A'], skills: [{ category: 'Core Competencies', items }] });
  eq('a numeric items on the merge target is refused', validatePayloadShape(scalarItems(2024)).length, 1);
  eq('a boolean items on the merge target is refused', validatePayloadShape(scalarItems(true)).length, 1);
  eq('an object items on the merge target is refused', validatePayloadShape(scalarItems({ a: 1 })).length, 1);
  eq('the error names the offending type',
    /items` of type number/.test(validatePayloadShape(scalarItems(2024))[0]), true);
  eq('and that value really was being overwritten before the guard',
    foldCompetencies(scalarItems(2024)).payload.skills[0].items, 'A');

  eq('a string items on the merge target is accepted', validatePayloadShape(scalarItems('X')), []);
  eq('and it merges rather than being replaced',
    foldCompetencies(scalarItems('X')).payload.skills[0].items, 'X, A');
  eq('an array items on the merge target is accepted', validatePayloadShape(scalarItems(['X'])), []);
  eq('an absent items on the merge target is accepted',
    validatePayloadShape({ competencies: ['A'], skills: [{ category: 'Core Competencies' }] }), []);

  eq('a scalar items on an untouched category is not policed',
    validatePayloadShape({ competencies: ['A'], skills: [{ category: 'Languages', items: 2024 }] }), []);

  const codes = (p) => lintPayload(p).map((f) => f.code);

  eq('a clean entry produces no findings', codes({
    experience: [{ company: 'Acme', role: 'Senior Engineer', dates: 'June 2022 - Present' }],
  }), []);

  eq('an employer preposition in the role is reported', codes({
    experience: [{ company: 'Consultancy', role: 'Lead Engineer at Globex', dates: '2020 - 2022' }],
  }), ['employer-in-role']);

  eq('a corporate suffix in the role is reported', codes({
    experience: [{ company: 'Consultancy', role: 'Platform Lead, Initech Inc.', dates: '2020 - 2022' }],
  }), ['employer-in-role']);

  eq("another entry's employer appearing in a role is reported", codes({
    experience: [
      { company: 'Globex', role: 'Staff Engineer', dates: '2018 - 2020' },
      { company: 'Consultancy', role: 'Globex Platform Lead', dates: '2020 - 2022' },
    ],
  }), ['employer-in-role']);

  eq('a company substring inside a longer word is not reported', codes({
    experience: [
      { company: 'Acme', role: 'Staff Engineer', dates: '2018 - 2020' },
      { company: 'Consultancy', role: 'Acmerican Studies Lead', dates: '2020 - 2022' },
    ],
  }), []);

  eq('a team named with "for" is not mistaken for an employer', codes({
    experience: [{ company: 'Acme', role: 'Engineer for Payments Platform', dates: '2020 - 2022' }],
  }), []);

  eq('a parenthetical in the company is reported', codes({
    experience: [{ company: 'Globex (Cloud Platform Division)', role: 'Engineer', dates: '2020 - 2022' }],
  }), ['parenthetical-in-company']);

  eq('a full-width parenthetical is reported too', codes({
    experience: [{ company: '日立製作所（クラウド事業部）', role: 'エンジニア', dates: '2020 - 2022' }],
  }), ['parenthetical-in-company']);

  eq('one date range is not reported', countDateRanges('June 2022 - Present'), 1);
  eq('a numeric single range is not reported', countDateRanges('06/2018 - 09/2020'), 1);
  eq('two comma-separated ranges are counted', countDateRanges('2016 - 2019, 2021 - Present'), 2);
  eq('two ranges joined by "and" are counted', countDateRanges('Jan 2016 to Dec 2018 and Mar 2021 until Present'), 2);
  eq('two date ranges in one entry are reported', codes({
    experience: [{ company: 'Acme', role: 'Engineer', dates: '2016 - 2019, 2021 - Present' }],
  }), ['multiple-date-ranges']);

  const full = transformPayload({
    competencies: ['RAG Pipelines'],
    experience: [{
      company: 'Globex (Cloud Platform Division)',
      role: 'Lead Engineer at Initech',
      dates: '2016 - 2019, 2021 - Present',
    }],
  });
  eq('one transform applied', full.transform.applied, true);
  eq('three lints reported, none applied', full.findings.map((f) => f.code),
    ['employer-in-role', 'parenthetical-in-company', 'multiple-date-ranges']);
  eq('every finding is advisory', full.findings.every((f) => f.severity === 'review'), true);
  eq('the lints changed nothing in the payload',
    full.payload.experience[0], {
      company: 'Globex (Cloud Platform Division)',
      role: 'Lead Engineer at Initech',
      dates: '2016 - 2019, 2021 - Present',
    });

  console.log(`\nats-payload self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const USAGE = `Usage: node ats-payload.mjs <payload.json|-> [--summary] > payload-ats.json
       node ats-payload.mjs --self-test

Applies ONE safe transform and reports THREE lints on a build-cv-html.mjs payload.

  transform  fold competencies[] into skills[] as one comma-delimited category
             under a header ATS parsers recognise (idempotent, reversible)
  lints      employer-in-role · parenthetical-in-company · multiple-date-ranges
             — reported only, because each needs a decision only you can make

The transformed payload goes to STDOUT; findings go to STDERR (JSON by default,
a human summary with --summary). Read-only: nothing is written back to cv.md or
config/profile.yml. Exits 0 whenever the transform succeeded, findings or not.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args.filter((a) => a !== '-'), ['--summary', '--self-test', '--help', '-h'], USAGE);

  if (args.includes('--self-test')) {
    runSelfTest();
  } else {
    const summaryMode = args.includes('--summary');
    const positional = args.filter((a) => !a.startsWith('-') || a === '-');
    if (positional.length > 1) {
      console.error(`Error: unexpected extra positional argument: ${positional[1]}`);
      console.error(USAGE);
      process.exit(1);
    }

    const source = positional[0] ?? '-';
    let raw;
    try {
      raw = readFileSync(source === '-' ? 0 : source, 'utf-8');
    } catch (err) {
      console.error(`Error: cannot read payload: ${source} (${err.code || err.message})`);
      process.exit(1);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      console.error(`Error: ${source === '-' ? 'stdin' : source} is not valid JSON (${err.message})`);
      process.exit(1);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.error(`Error: ${source === '-' ? 'stdin' : source} is not a CV payload object`);
      process.exit(1);
    }

    const shapeErrors = validatePayloadShape(payload);
    if (shapeErrors.length > 0) {
      console.error(`Error: ${source === '-' ? 'stdin' : source} has an unusable payload shape:`);
      for (const message of shapeErrors) console.error(`  - ${message}`);
      process.exit(1);
    }

    const result = transformPayload(payload);
    console.log(JSON.stringify(result.payload, null, 2));
    if (summaryMode) {
      console.error(formatSummary(result));
    } else {
      console.error(JSON.stringify({ transform: result.transform, findings: result.findings }, null, 2));
    }
  }
}
