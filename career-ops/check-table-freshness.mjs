#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseDate } from './lib/parse-date.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const TEMPLATES_DIR = join(CAREER_OPS, 'templates');
const DEFAULT_MAX_AGE_MONTHS = 12;

const args = process.argv.slice(2);

const KNOWN_FLAGS = ['--summary', '--self-test', '--max-age-months', '--today', '--help', '-h'];

const VALUE_FLAGS = ['--max-age-months', '--today'];

const USAGE = `Usage:
  node check-table-freshness.mjs                       # JSON freshness report
  node check-table-freshness.mjs --summary             # human-readable table
  node check-table-freshness.mjs --max-age-months <n>  # review-due threshold (default: 12)
  node check-table-freshness.mjs --today <YYYY-MM-DD>  # evaluate as of a fixed date
  node check-table-freshness.mjs --self-test           # run the inline self-test
  node check-table-freshness.mjs --help                # show this message

Exits 1 when any row is expired (past next_effective without re-verification).`;

const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const maxAgeRaw = flagValue(args, '--max-age-months') ?? null;
const todayFlag = flagValue(args, '--today') ?? null;

export function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

export function addMonthsUTC(date, deltaMonths) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const daysInTarget = new Date(Date.UTC(y, m + deltaMonths + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + deltaMonths, Math.min(d, daysInTarget)));
}

export function extractRows(doc) {
  const isObjectRow = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arrays = [];
  const mappings = [];
  if (Array.isArray(doc)) {
    arrays.push({ container: '(top-level)', items: doc });
  } else if (doc !== null && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (Array.isArray(value)) {
        arrays.push({ container: key, items: value });
      } else if (isObjectRow(value)) {
        mappings.push({ container: key, entries: value });
      }
    }
  }
  const rows = [];
  for (const { container, items } of arrays) {
    if (!items.some(item => isObjectRow(item) && Object.hasOwn(item, 'as_of'))) continue;
    items.forEach((item, index) => {
      if (!isObjectRow(item)) return;
      rows.push({ row: item, container, index, missingAsOf: !Object.hasOwn(item, 'as_of') });
    });
  }
  for (const { container, entries } of mappings) {
    const children = Object.entries(entries).filter(([, v]) => isObjectRow(v));
    if (!children.some(([, v]) => Object.hasOwn(v, 'as_of'))) continue;
    children.forEach(([key, item], index) => {
      const row = Object.hasOwn(item, 'jurisdiction') ? item : { jurisdiction: key, ...item };
      rows.push({ row, container, index, missingAsOf: !Object.hasOwn(item, 'as_of') });
    });
  }
  return rows;
}

export function checkFreshness(tables, todayDate, maxAgeMonths = DEFAULT_MAX_AGE_MONTHS) {
  const reviewCutoff = addMonthsUTC(todayDate, -maxAgeMonths);
  const findings = [];
  const warnings = [];
  let tablesScanned = 0;
  let rowsChecked = 0;

  for (const { file, doc } of tables) {
    const rows = extractRows(doc);
    if (rows.length === 0) continue;
    tablesScanned += 1;

    for (const { row, container, index, missingAsOf } of rows) {
      const jurisdiction = typeof row.jurisdiction === 'string' && row.jurisdiction.trim()
        ? row.jurisdiction.trim()
        : `${container}[${index}]`;
      const sources = row.sources ?? row.source ?? null;

      if (missingAsOf) {
        warnings.push({
          type: 'warning', file, jurisdiction, field: 'as_of',
          detail: 'row is missing the mandatory as_of field — every jurisdiction row must carry one (quoted YYYY-MM-DD); row skipped',
        });
        continue;
      }

      const asOf = parseDate(row.as_of);
      if (asOf === null) {
        warnings.push({
          type: 'warning', file, jurisdiction, field: 'as_of',
          detail: `malformed as_of value ${JSON.stringify(row.as_of ?? null)} — expected quoted YYYY-MM-DD; row skipped`,
        });
        continue;
      }

      let nextEffective = null;
      if (Object.hasOwn(row, 'next_effective') && row.next_effective !== null) {
        nextEffective = parseDate(row.next_effective);
        if (nextEffective === null) {
          warnings.push({
            type: 'warning', file, jurisdiction, field: 'next_effective',
            detail: `malformed next_effective value ${JSON.stringify(row.next_effective)} — expected quoted YYYY-MM-DD; row skipped`,
          });
          continue;
        }
      }

      rowsChecked += 1;

      if (nextEffective !== null && todayDate >= nextEffective && asOf < nextEffective) {
        findings.push({
          type: 'expired', file, jurisdiction, field: 'next_effective',
          detail: `next_effective ${isoDay(nextEffective)} has passed (today ${isoDay(todayDate)}) and the row was last verified ${isoDay(asOf)} — the pre-announced change arrived but the table was not updated`,
          sources,
        });
      }

      if (asOf < reviewCutoff) {
        findings.push({
          type: 'review-due', file, jurisdiction, field: 'as_of',
          detail: `as_of ${isoDay(asOf)} is older than ${maxAgeMonths} months (review cutoff ${isoDay(reviewCutoff)})`,
          sources,
        });
      }
    }
  }

  return { tablesScanned, rowsChecked, findings, warnings };
}

export const hasExpired = (findings) => findings.some(f => f.type === 'expired');

function loadTables(dir = TEMPLATES_DIR) {
  if (!existsSync(dir)) return { tables: [], parseWarnings: [] };
  const tables = [];
  const parseWarnings = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(file)) continue;
    let doc;
    try {
      doc = yaml.load(readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n'));
    } catch (e) {
      parseWarnings.push({
        type: 'warning', file, jurisdiction: null, field: null,
        detail: `YAML parse error — file skipped: ${e.message.split('\n')[0]}`,
      });
      continue;
    }
    tables.push({ file, doc });
  }
  return { tables, parseWarnings };
}

function loadConfigMaxAge() {
  const profilePath = join(DATA_ROOT, 'config/profile.yml');
  if (!existsSync(profilePath)) return { months: null, warning: null };
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
    if (!Object.hasOwn(profile?.table_freshness ?? {}, 'max_age_months')) {
      return { months: null, warning: null };
    }
    const raw = profile.table_freshness.max_age_months;
    const months = parsePositiveInt(raw);
    if (months === null) {
      return {
        months: null,
        warning: {
          type: 'warning', file: 'config/profile.yml', jurisdiction: null, field: 'table_freshness.max_age_months',
          detail: `invalid value ${JSON.stringify(raw)} — expected a positive integer (whole months); using default ${DEFAULT_MAX_AGE_MONTHS}`,
        },
      };
    }
    return { months, warning: null };
  } catch {
    return { months: null, warning: null };
  }
}

function printSummary(result, todayStr, maxAgeMonths) {
  const { tablesScanned, rowsChecked, findings, warnings } = result;
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Table Freshness — career-ops');
  console.log(`  today: ${todayStr} | review threshold: ${maxAgeMonths} months | tables: ${tablesScanned} | rows: ${rowsChecked}`);
  console.log(`${'='.repeat(78)}\n`);

  if (findings.length === 0) {
    console.log(tablesScanned === 0
      ? '  No jurisdiction tables found under templates/ (none have as_of rows yet).\n'
      : '  All checked rows are fresh.\n');
  } else {
    const header =
      '  ' +
      'Type'.padEnd(12) +
      'File'.padEnd(30) +
      'Jurisdiction'.padEnd(16) +
      'Detail';
    console.log(header);
    console.log('  ' + '-'.repeat(90));
    for (const f of findings) {
      const type = f.type.padEnd(12);
      const file = (f.file || '').substring(0, 28).padEnd(30);
      const jur = (f.jurisdiction || '').substring(0, 14).padEnd(16);
      console.log('  ' + type + file + jur + f.detail);
      if (f.sources) {
        const src = Array.isArray(f.sources) ? f.sources.join(', ') : String(f.sources);
        console.log('  ' + ' '.repeat(12) + `re-verify at: ${src}`);
      }
    }
    console.log('');
  }

  if (warnings.length) {
    console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (rows/files skipped, never fatal):`);
    for (const w of warnings) {
      console.log(`    ${w.file}${w.jurisdiction ? ` [${w.jurisdiction}]` : ''}: ${w.detail}`);
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

  const today = parseDate('2026-07-01');
  check(today !== null, 'fixture today parses');

  const NESTED_TABLE = yaml.load([
    'covenants:',
    '  # expired: next_effective passed, row not re-verified since',
    '  - jurisdiction: "XX-TEST"',
    '    rule: "test floor rises"',
    '    as_of: "2026-01-15"',
    '    next_effective: "2026-06-01"',
    '    sources:',
    '      - "https://example.com/xx-test-employment-standards"',
    '  # review-due: as_of older than 12 months',
    '  - jurisdiction: "YY-TEST"',
    '    rule: "test posting rule"',
    '    as_of: "2024-03-01"',
    '    sources: "https://example.com/yy-test-register"',
    '  # fresh: recent as_of, no next_effective',
    '  - jurisdiction: "ZZ-TEST"',
    '    rule: "test disclosure rule"',
    '    as_of: "2026-06-20"',
    '  # future next_effective: no finding',
    '  - jurisdiction: "WW-TEST"',
    '    rule: "test pre-announced change"',
    '    as_of: "2026-06-20"',
    '    next_effective: "2026-10-01"',
    '  # re-verified after the change landed: NOT expired',
    '  - jurisdiction: "VV-TEST"',
    '    rule: "test updated row"',
    '    as_of: "2026-06-05"',
    '    next_effective: "2026-06-01"',
    '  # malformed as_of: warning + skip',
    '  - jurisdiction: "UU-TEST"',
    '    rule: "test malformed date"',
    '    as_of: "June 2026"',
    '  # malformed next_effective: warning + skip',
    '  - jurisdiction: "TT-TEST"',
    '    rule: "test malformed next_effective"',
    '    as_of: "2026-06-20"',
    '    next_effective: "2026-13-45"',
    '  # missing as_of entirely: the row-set qualifies (siblings carry as_of),',
    '  # so this row must WARN, not silently vanish from validation',
    '  - jurisdiction: "RR-TEST"',
    '    rule: "test missing as_of"',
  ].join('\n'));

  const TOP_LEVEL_ARRAY_TABLE = yaml.load([
    '- jurisdiction: "SS-TEST"',
    '  rule: "top-level-array shape"',
    '  as_of: "2026-06-25"',
  ].join('\n'));

  const NOT_A_TABLE = yaml.load([
    'states:',
    '  - name: "Evaluated"',
    '  - name: "Applied"',
    'notes: "no as_of anywhere"',
  ].join('\n'));

  const MAPPING_TABLE = yaml.load([
    'jurisdictions:',
    '  QQ-TEST:',
    '    rule: "test mapping-shaped fresh row"',
    '    as_of: "2026-06-20"',
    '  PP-TEST:',
    '    rule: "test another mapping-shaped fresh row"',
    '    as_of: "2026-06-10"',
  ].join('\n'));

  const tables = [
    { file: 'jurisdiction-fixture.yml', doc: NESTED_TABLE },
    { file: 'flat-fixture.yml', doc: TOP_LEVEL_ARRAY_TABLE },
    { file: 'states-fixture.yml', doc: NOT_A_TABLE },
    { file: 'mapping-fixture.yml', doc: MAPPING_TABLE },
  ];
  const result = checkFreshness(tables, today, DEFAULT_MAX_AGE_MONTHS);

  check(result.tablesScanned === 3, `all qualifying table shapes discovered, non-table skipped (got ${result.tablesScanned})`);
  check(extractRows(NESTED_TABLE).length === 8, 'nested-under-key shape: all rows in the qualifying row-set extracted (incl. the missing-as_of one)');
  check(extractRows(TOP_LEVEL_ARRAY_TABLE).length === 1, 'top-level-array shape: as_of row extracted');
  check(extractRows(NOT_A_TABLE).length === 0, 'file without as_of rows yields no rows');
  const mappingRows = extractRows(MAPPING_TABLE);
  check(mappingRows.length === 2, 'mapping-shaped row-set: both keyed rows extracted');
  check(mappingRows.every(r => typeof r.row.jurisdiction === 'string'), 'mapping-shaped rows get their jurisdiction synthesized from the map key');
  check(mappingRows.some(r => r.row.jurisdiction === 'QQ-TEST') && mappingRows.some(r => r.row.jurisdiction === 'PP-TEST'),
    'mapping-shaped row jurisdiction matches its map key');
  check(result.rowsChecked === 8, `8 rows checked (2 malformed + 1 missing as_of skipped), got ${result.rowsChecked}`);

  const expired = result.findings.filter(f => f.type === 'expired');
  check(expired.length === 1 && expired[0].jurisdiction === 'XX-TEST',
    'expired: past next_effective without re-verification is flagged');
  check(Array.isArray(expired[0]?.sources) && expired[0].sources[0].includes('xx-test'),
    'expired finding copies the row sources for re-verification');

  const reviewDue = result.findings.filter(f => f.type === 'review-due');
  check(reviewDue.length === 1 && reviewDue[0].jurisdiction === 'YY-TEST',
    'review-due: as_of older than 12 months is flagged');
  check(reviewDue[0]?.sources === 'https://example.com/yy-test-register',
    'review-due finding copies a scalar sources field as-is');

  const flagged = new Set(result.findings.map(f => f.jurisdiction));
  check(!flagged.has('ZZ-TEST'), 'fresh row produces no finding');
  check(!flagged.has('WW-TEST'), 'future next_effective produces no finding');
  check(!flagged.has('VV-TEST'), 'row re-verified on/after next_effective is NOT expired');
  check(!flagged.has('SS-TEST'), 'fresh top-level-array row produces no finding');

  check(result.warnings.length === 3, `3 warnings (2 malformed dates + 1 missing as_of), got ${result.warnings.length}`);
  check(result.warnings.some(w => w.jurisdiction === 'UU-TEST' && w.field === 'as_of'),
    'malformed as_of produces a warning and skips the row');
  check(result.warnings.some(w => w.jurisdiction === 'TT-TEST' && w.field === 'next_effective'),
    'malformed next_effective produces a warning and skips the row');
  check(result.warnings.some(w => w.jurisdiction === 'RR-TEST' && w.field === 'as_of' && w.detail.includes('missing the mandatory as_of')),
    'row missing as_of inside a qualifying row-set produces a warning, not a silent skip');
  check(!flagged.has('UU-TEST') && !flagged.has('TT-TEST') && !flagged.has('RR-TEST'), 'skipped rows never produce findings');

  check(hasExpired(result.findings) === true, 'expired finding present -> exit 1 path');
  check(hasExpired(result.findings.filter(f => f.type !== 'expired')) === false,
    'review-due alone -> exit 0 path (CI-friendly)');

  const mappingStale = checkFreshness([{
    file: 'mapping-stale.yml',
    doc: { jurisdictions: { 'OO-TEST': { rule: 'test stale mapping row', as_of: '2024-01-01' } } },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(mappingStale.findings.some(f => f.type === 'review-due' && f.jurisdiction === 'OO-TEST'),
    'mapping-shaped row with stale as_of is flagged review-due (freshness logic, not just extraction, covers this shape)');

  const boundary = checkFreshness([{
    file: 'boundary.yml',
    doc: { rows: [{ jurisdiction: 'XX-TEST', as_of: '2026-01-01', next_effective: '2026-07-01' }] },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(boundary.findings.some(f => f.type === 'expired'), 'today == next_effective counts as expired (today >= next_effective)');

  const exactAge = checkFreshness([{
    file: 'exact-age.yml',
    doc: { rows: [{ jurisdiction: 'XX-TEST', as_of: '2025-07-01' }] },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(exactAge.findings.length === 0, 'as_of exactly 12 months ago is not yet review-due');

  check(isoDay(addMonthsUTC(parseDate('2026-03-31'), -1)) === '2026-02-28',
    'addMonthsUTC clamps 2026-03-31 minus 1 month to 2026-02-28');
  check(isoDay(addMonthsUTC(parseDate('2024-03-31'), -1)) === '2024-02-29',
    'addMonthsUTC clamps to leap-day in leap years');

  check(parseDate('2026-02-30') === null, 'impossible calendar date rejected');
  check(parseDate('2026-6-1') === null, 'non-padded date rejected (tables use quoted YYYY-MM-DD)');
  check(parseDate(20260601) === null, 'non-string date value rejected');

  check(parsePositiveInt('6') === 6, 'parsePositiveInt accepts "6"');
  check(parsePositiveInt(' 12 ') === 12, 'parsePositiveInt tolerates surrounding whitespace');
  check(parsePositiveInt(6) === 6, 'parsePositiveInt accepts a YAML integer');
  check(parsePositiveInt('6months') === null, 'parsePositiveInt rejects "6months" (no parseInt truncation)');
  check(parsePositiveInt('6.5') === null, 'parsePositiveInt rejects decimal strings');
  check(parsePositiveInt(6.5) === null, 'parsePositiveInt rejects a YAML float');
  check(parsePositiveInt('0') === null, 'parsePositiveInt rejects zero');
  check(parsePositiveInt('-3') === null, 'parsePositiveInt rejects negatives');
  check(parsePositiveInt('') === null, 'parsePositiveInt rejects empty string');
  check(parsePositiveInt(null) === null, 'parsePositiveInt rejects null/missing value');

  const empty = checkFreshness([], today, DEFAULT_MAX_AGE_MONTHS);
  check(empty.tablesScanned === 0 && empty.findings.length === 0 && !hasExpired(empty.findings),
    'no jurisdiction tables -> empty result, exit 0 (the designed empty-main case)');

  for (const file of ['states.yml', 'portals.example.yml', 'benchmarks.yml']) {
    const p = join(TEMPLATES_DIR, file);
    if (!existsSync(p)) continue;
    let doc = null;
    try { doc = yaml.load(readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')); } catch { }
    check(extractRows(doc).length === 0, `existing template ${file} does not qualify as a jurisdiction table`);
  }

  console.log(`\n  check-table-freshness self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  if (selfTestMode) {
    runSelfTest();
  }

  let todayDate;
  if (todayFlag !== null) {
    todayDate = parseDate(todayFlag);
    if (todayDate === null) {
      console.error(`Invalid --today value "${todayFlag}" — expected YYYY-MM-DD`);
      process.exit(1);
    }
  } else {
    todayDate = parseDate(localToday());
  }

  const configWarnings = [];
  let maxAgeMonths;
  if (maxAgeRaw !== null) {
    maxAgeMonths = parsePositiveInt(maxAgeRaw);
    if (maxAgeMonths === null) {
      console.error(`Error: invalid --max-age-months value ${JSON.stringify(maxAgeRaw ?? null)} — expected a positive integer (whole months)`);
      process.exit(1);
    }
  } else {
    const cfg = loadConfigMaxAge();
    if (cfg.warning) configWarnings.push(cfg.warning);
    maxAgeMonths = cfg.months ?? DEFAULT_MAX_AGE_MONTHS;
  }

  const { tables, parseWarnings } = loadTables();
  const result = checkFreshness(tables, todayDate, maxAgeMonths);
  result.warnings = [...configWarnings, ...parseWarnings, ...result.warnings];

  if (summaryMode) {
    printSummary(result, isoDay(todayDate), maxAgeMonths);
  } else {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      today: isoDay(todayDate),
      maxAgeMonths,
      tablesScanned: result.tablesScanned,
      rowsChecked: result.rowsChecked,
      findings: result.findings,
      warnings: result.warnings,
    }, null, 2));
  }

  process.exit(hasExpired(result.findings) ? 1 : 0);
}
