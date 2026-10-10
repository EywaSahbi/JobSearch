#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { parseActiveInterviews } from './process-quality.mjs';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';
import { isPlaceholderCompany } from './lib/placeholder-cell.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseDate } from './lib/parse-date.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_ACTIVE_INTERVIEWS_PATH = existsSync(join(DATA_ROOT, 'data/active-interviews.md'))
  ? join(DATA_ROOT, 'data/active-interviews.md')
  : join(DATA_ROOT, 'active-interviews.md');
export const DEFAULT_TRACKER_PATH = resolveTrackerPath(DATA_ROOT);
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(DATA_ROOT, 'config/profile.yml');

export const DEFAULT_COURTESY_DAYS = 30;

export const DISCLAIMER =
  'Elapsed-time observation only — not legal advice or a claim that the ' +
  'employer did anything wrong.';

const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  '--file', '--tracker', '--courtesy-days', '--today',
  '--summary', '--self-test', '--help', '-h',
];
const VALUE_FLAGS = ['--file', '--tracker', '--courtesy-days', '--today'];

const USAGE = `Usage:
  node rejection-latency.mjs                        # JSON report
  node rejection-latency.mjs --summary              # human-readable table
  node rejection-latency.mjs --file <path>          # a different active-interviews.md
  node rejection-latency.mjs --tracker <path>       # a different applications.md
  node rejection-latency.mjs --courtesy-days <N>    # override the courtesy threshold (default ${DEFAULT_COURTESY_DAYS})
  node rejection-latency.mjs --today <YYYY-MM-DD>   # evaluate as of a fixed date
  node rejection-latency.mjs --self-test            # run the built-in fixtures
  node rejection-latency.mjs --help                 # show this message

Suggestion-only: nothing is ever written to data/blacklist.md for you.
${DISCLAIMER}`;

validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const argValue = (flag) => {
  if (!hasFlag(args, flag)) return null;
  const value = flagValue(args, flag);
  if (value === undefined || value === '' || value.startsWith('--')) {
    console.error(`${flag} requires a value.`);
    process.exit(2);
  }
  return value;
};
const ACTIVE_INTERVIEWS_PATH = argValue('--file') || DEFAULT_ACTIVE_INTERVIEWS_PATH;
const TRACKER_PATH = argValue('--tracker') || DEFAULT_TRACKER_PATH;
const cliCourtesyDays = argValue('--courtesy-days');
const cliToday = argValue('--today');

export function extractDate(cell) {
  const match = String(cell || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? parseDate(match[0]) : null;
}

function daysBetween(d1, d2) {
  const first = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  const second = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  return (second - first) / (1000 * 60 * 60 * 24);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

export function companyKey(name) {
  return normalizeTextKey(name);
}

export function groupIdentity(company, via) {
  if (!isPlaceholderCompany(company)) {
    const key = companyKey(company);
    return key ? { key, label: String(company).trim() } : null;
  }
  const channel = String(via || '').trim();
  if (!channel || isPlaceholderCompany(channel)) return null;
  const label = `? (via ${channel})`;
  return { key: `?via:${companyKey(channel)}`, label };
}

function findColumn(row, name) {
  const key = Object.keys(row || {}).find(k => k.trim().toLowerCase() === name);
  return key ? String(row[key] ?? '') : '';
}

export function loadProfile(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return {};
  try {
    return yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

export function parseTrackerInterviewRows(content) {
  if (typeof content !== 'string' || !content.trim()) return new Map();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const colmap = resolveColumns(lines);
  const byCompany = new Map();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const status = String(row.status || '').replace(/\*\*/g, '').trim().toLowerCase();
    if (status !== 'interview') continue;
    const identity = groupIdentity(row.company, row.via);
    if (!identity) continue;
    if (!byCompany.has(identity.key)) byCompany.set(identity.key, []);
    byCompany.get(identity.key).push({ ...row, groupLabel: identity.label });
  }
  return byCompany;
}

export function placeholderInterviewRows(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const colmap = resolveColumns(lines);
  const excluded = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const status = String(row.status || '').replace(/\*\*/g, '').trim().toLowerCase();
    if (status !== 'interview') continue;
    if (!groupIdentity(row.company, row.via)) excluded.push(row);
  }
  return excluded;
}

export function buildBlacklistSuggestion(company, todayStr, reason) {
  return `| ${company} | ${todayStr} | company | ${reason} |`;
}

export function computeRejectionLatency(interviewRows, trackerByCompany, opts = {}) {
  const today = opts.today instanceof Date && !Number.isNaN(opts.today.getTime())
    ? opts.today
    : parseDate(localToday());
  const courtesyDays = Number.isFinite(opts.courtesyDays) && opts.courtesyDays > 0
    ? opts.courtesyDays
    : DEFAULT_COURTESY_DAYS;

  const warnings = [];
  const rows = Array.isArray(interviewRows) ? interviewRows : [];
  const tracker = trackerByCompany instanceof Map ? trackerByCompany : new Map();

  const byApplication = new Map();
  const companiesSeen = new Set();
  const placeholderRounds = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const company = findColumn(row, 'company').trim();
    if (!company) continue;
    const identity = groupIdentity(company, findColumn(row, 'via'));
    if (!identity) {
      placeholderRounds.push(row);
      continue;
    }
    const cKey = identity.key;

    const dateCell = findColumn(row, 'date/time') || findColumn(row, 'date');
    const date = extractDate(dateCell);
    if (!date) {
      warnings.push(`Skipped a "${company}" interview row with no parseable YYYY-MM-DD date (Date/Time cell: "${String(dateCell).trim() || 'empty'}").`);
      continue;
    }
    companiesSeen.add(cKey);

    const role = findColumn(row, 'role').trim();

    const companyRows = tracker.get(cKey);
    if (!companyRows || companyRows.length === 0) {
      continue;
    }

    const roleKey = companyKey(role);
    const trackerRows = roleKey
      ? companyRows.filter(r => companyKey(r.role) === roleKey || roleFuzzyMatch(role, r.role))
      : companyRows;

    if (trackerRows.length === 0) {
      const daysRow = daysBetween(date, today);
      if (daysRow > courtesyDays) {
        warnings.push(`"${company}" has tracker row(s) still in Interview state, but none match the interviewed role "${role}" — skipped (check role naming between data/active-interviews.md and data/applications.md).`);
      }
      continue;
    }

    const appKey = trackerRows.map(r => r.num).sort((a, b) => a - b).join(',');
    if (!byApplication.has(appKey)) {
      byApplication.set(appKey, { company: identity.label, role, lastDate: date, trackerRows });
    } else {
      const entry = byApplication.get(appKey);
      if (date > entry.lastDate) {
        entry.lastDate = date;
        entry.role = role;
      }
    }
  }

  const todayStr = isoDay(today);
  const flags = [];
  for (const entry of byApplication.values()) {
    const daysAll = daysBetween(entry.lastDate, today);
    if (daysAll < 0) continue;
    if (daysAll <= courtesyDays) continue;

    const reason = `${daysAll} days post-interview silence exceeds the ${courtesyDays}-day courtesy threshold`;

    flags.push({
      company: entry.company,
      role: entry.role,
      trackerNums: entry.trackerRows.map(r => r.num),
      lastInterviewDate: isoDay(entry.lastDate),
      daysSinceLastInterview: daysAll,
      tier: 'courtesy',
      thresholdDays: courtesyDays,
      courtesyDays,
      reason,
      reasonCode: 'courtesy-threshold-exceeded',
      blacklistSuggestion: buildBlacklistSuggestion(entry.company, todayStr, reason),
    });
  }

  flags.sort((a, b) => {
    if (b.daysSinceLastInterview !== a.daysSinceLastInterview) {
      return b.daysSinceLastInterview - a.daysSinceLastInterview;
    }
    return a.company.localeCompare(b.company);
  });

  if (placeholderRounds.length) {
    warnings.push(
      `${placeholderRounds.length} interview round${placeholderRounds.length === 1 ? '' : 's'} in `
      + 'data/active-interviews.md could not be attributed: the employer cell is a placeholder and '
      + 'no via= channel is set, so there is nothing to group by. Adding via= groups them under that channel.',
    );
  }
  return { flags, warnings, companiesChecked: companiesSeen.size, placeholderRounds: placeholderRounds.length };
}

function readNormalized(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

function printSummary(result, meta) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Rejection Latency — career-ops');
  console.log(`  as of: ${meta.today} | courtesy: ${meta.courtesyDays}d`);
  console.log(`${'='.repeat(78)}\n`);

  if (result.flags.length === 0) {
    const unassessed = (meta.placeholderApplicationsExcluded || 0) + (result.placeholderRounds || 0);
    if (unassessed === 0) {
      console.log('  No post-interview silence exceeded the configured thresholds.\n');
    } else {
      console.log(`  Nothing flagged among the applications this check could assess — ${unassessed} could not be (see below).\n`);
    }
  } else {
    const header =
      '  ' +
      'Company'.padEnd(24) +
      'Last interview'.padEnd(16) +
      'Days'.padEnd(7) +
      'Tier'.padEnd(11) +
      'Threshold';
    console.log(header);
    console.log('  ' + '-'.repeat(70));
    for (const f of result.flags) {
      console.log(
        '  ' +
        (f.company || '').substring(0, 22).padEnd(24) +
        f.lastInterviewDate.padEnd(16) +
        String(f.daysSinceLastInterview).padEnd(7) +
        f.tier.padEnd(11) +
        `${f.thresholdDays}d`
      );
    }

    console.log('\n  Suggested data/blacklist.md rows (copy manually — nothing is written for you):\n');
    console.log('  | Company | Since | Scope | Reason |');
    console.log('  |---------|-------|-------|--------|');
    for (const f of result.flags) {
      console.log('  ' + f.blacklistSuggestion);
    }
  }

  for (const w of result.warnings) {
    console.log(`  ⚠ ${w}`);
  }
  console.log(`\n  Note: ${DISCLAIMER}\n`);
}

function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const activeMd = [
    '# Active Interviews',
    '',
    '| Company | Role | Round | Date/Time | Interviewer | Status | Notes |',
    '|---------|------|-------|-----------|-------------|--------|-------|',
    '| Acme Corp | Backend Engineer | Prescreen | 2026-04-01 | Recruiter | Done | went fine |',
    '| Acme Corp | Backend Engineer | Round 2 | 2026-05-01 14:00 EST | Panel | Done | final round |',
    '| Globex | Coordinator | Prescreen | 2026-06-10 | HM | Done | quick chat |',
    '| Initech | Analyst | Round 1 | 2026-05-20 | Panel | Done | they rejected later |',
    '| Umbrella LLC | Designer | Round 1 | not scheduled yet | HM | Pending | date TBD |',
    '| Hooli | PM | Round 1 | 2026-07-10 | Panel | Done | recent, on time |',
    '| Vandelay Industries | Importer | Prescreen | 2026-04-10 | Recruiter | Done | screening only |',
    '| Stark Labs | Researcher | Round 1 | 2025-11-01 | Panel | Done | interviewed a while ago |',
    '| Wayne Corp | Analyst | Round 1 | 2026-04-01 | Panel | Done | this application was later rejected |',
    '| Initrode | Senior Data Engineer | Round 1 | 2026-05-01 | Panel | Done | tracker spells the role Sr Data Engineer |',
    '| Soylent Corp | Analyst | Round 1 | 2026-07-15 | Panel | Done | recent interview, role mismatch expected |',
    '| Massive Dynamic | Senior Data Engineer | Round 1 | 2026-05-01 | Panel | Done | fuzzy-spelling variant, round 1 |',
    '| Massive Dynamic | Sr Data Engineer | Round 2 | 2026-06-01 | Panel | Done | fuzzy-spelling variant, round 2 — must aggregate with round 1 |',
  ].join('\r\n');

  const trackerMd = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-03-20 | Acme Corp | Backend Engineer | 4.2/5 | Interview | ✅ | — | waiting since final round |',
    '| 2 | 2026-05-30 | Globex | Coordinator | 3.8/5 | Interview | ❌ | — | prescreen done |',
    '| 3 | 2026-05-01 | Initech | Analyst | 4.0/5 | Rejected | ❌ | — | form rejection |',
    '| 4 | 2026-06-25 | Hooli | PM | 4.5/5 | Interview | ✅ | — | fresh |',
    '| 5 | 2026-03-15 | Vandelay Industries | Importer | 3.5/5 | Interview | ❌ | — | prescreen only so far |',
    '| 6 | 2025-10-01 | Stark Labs | Researcher | 4.1/5 | Interview | ❌ | — | pre-2026 interview |',
    '| 7 | 2026-03-01 | Wayne Corp | Analyst | 4.0/5 | Rejected | ❌ | — | resolved application |',
    '| 8 | 2026-03-05 | Wayne Corp | Designer | 3.9/5 | Interview | ❌ | — | different application, never interviewed |',
    '| 9 | 2026-04-01 | Initrode | Sr Data Engineer | 4.3/5 | Interview | ❌ | — | role spelled differently |',
    '| 10 | 2026-06-01 | Soylent Corp | Coordinator | 3.7/5 | Interview | ❌ | — | different role from the interview |',
    '| 11 | 2026-04-01 | Massive Dynamic | Data Engineer | 4.0/5 | Interview | ❌ | — | single tracker application, two fuzzy-spelling interview rounds |',
  ].join('\r\n');

  const interviewRows = parseActiveInterviews(activeMd.replace(/\r\n/g, '\n'));
  const trackerByCompany = parseTrackerInterviewRows(trackerMd);
  const today = parseDate('2026-07-17');

  const result = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays: 30,
  });

  const acme = result.flags.find(f => f.company === 'Acme Corp');
  check(!!acme, 'Acme Corp (77 days, still Interview) is flagged');
  if (acme) {
    check(acme.tier === 'courtesy', 'Acme Corp flag is the courtesy tier');
    check(acme.lastInterviewDate === '2026-05-01', 'latest interview date wins (2026-05-01, not 2026-04-01)');
    check(acme.daysSinceLastInterview === 77, 'elapsed days computed from last interview to --today');
    check(acme.reason.includes('30-day courtesy threshold'), 'reason names the courtesy threshold');
    check(acme.reasonCode === 'courtesy-threshold-exceeded', 'flag carries the language-neutral reasonCode');
    check(acme.blacklistSuggestion === '| Acme Corp | 2026-07-17 | company | ' + acme.reason + ' |',
      'blacklist suggestion row matches data/blacklist.md column format');
    check(acme.trackerNums.includes(1), 'flag carries the tracker row number(s)');
  }

  const globex = result.flags.find(f => f.company === 'Globex');
  check(!!globex, 'Globex (37 days, still Interview) is flagged');
  if (globex) {
    check(globex.tier === 'courtesy', 'Globex is courtesy tier (37 > 30)');
    check(globex.reason.includes('30-day courtesy threshold'), 'courtesy reason names the courtesy threshold');
  }

  const vandelay = result.flags.find(f => f.company === 'Vandelay Industries');
  check(vandelay && vandelay.tier === 'courtesy', 'Vandelay Industries (98 days) is flagged courtesy tier');

  const stark = result.flags.find(f => f.company === 'Stark Labs');
  check(stark && stark.tier === 'courtesy', 'Stark Labs (interviewed 2025-11-01) is flagged courtesy tier');

  check(!result.flags.some(f => f.company === 'Wayne Corp'),
    'Wayne Corp is not flagged — the interviewed role is resolved, the Interview-state row is a different role');
  check(result.warnings.some(w => w.includes('Wayne Corp') && w.includes('Analyst')),
    'role mismatch at Wayne Corp (107 days, past threshold) produces an explicit warning');

  const initrode = result.flags.find(f => f.company === 'Initrode');
  check(initrode && initrode.tier === 'courtesy' && initrode.trackerNums.includes(9),
    'Initrode matches "Senior Data Engineer" ↔ "Sr Data Engineer" via roleFuzzyMatch');

  const massiveFlags = result.flags.filter(f => f.company === 'Massive Dynamic');
  check(massiveFlags.length === 1,
    'fuzzy-spelling variant interview rows for the same tracker application aggregate into exactly one flag');
  if (massiveFlags.length === 1) {
    check(massiveFlags[0].lastInterviewDate === '2026-06-01',
      'aggregate keeps the LATEST interview date among the fuzzy-spelling variant rows (round 2, not round 1)');
    check(massiveFlags[0].trackerNums.includes(11),
      'aggregate resolves to the stable tracker row number (#11), not role text');
  }

  check(!result.flags.some(f => f.company === 'Soylent Corp'),
    'Soylent Corp (2 days elapsed, role mismatch) is not flagged — under the courtesy threshold');
  check(!result.warnings.some(w => w.includes('Soylent Corp')),
    'role mismatch at Soylent Corp produces NO warning — the silence is not threshold-relevant');

  check(!result.flags.some(f => f.company === 'Initech'),
    'Initech (Rejected in tracker — response recorded) is never flagged');
  check(!result.flags.some(f => f.company === 'Hooli'),
    'Hooli (7 days elapsed) is under the courtesy threshold — not flagged');
  check(result.warnings.some(w => w.includes('Umbrella LLC')),
    'row with unparseable date produces a warning, not a crash');
  check(result.companiesChecked === 10,
    'all 10 companies with at least one dated interview row were considered (Umbrella LLC has none)');

  const lateToday = new Date('2026-07-17T18:30:00Z');
  const resultLate = computeRejectionLatency(interviewRows, trackerByCompany, {
    today: lateToday, courtesyDays: 30,
  });
  const acmeLate = resultLate.flags.find(f => f.company === 'Acme Corp');
  check(acmeLate && acmeLate.daysSinceLastInterview === 77,
    'elapsed days ignore time-of-day (UTC-midnight calendar math)');

  const strict = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays: 5,
  });
  check(strict.flags.some(f => f.company === 'Hooli' && f.tier === 'courtesy'),
    'lowering courtesy days flags fresher silences (Hooli at 7 days > 5)');

  check(trackerByCompany.size === 9, 'CRLF tracker content parses (9 companies still in Interview)');
  check(!trackerByCompany.has(companyKey('Initech')), 'Rejected tracker rows are excluded');

  check(companyKey('Acme Corp.') === companyKey('acme corp'), 'company match is case/punctuation-insensitive');

  check(computeRejectionLatency([], new Map(), { today }).flags.length === 0, 'empty inputs return no flags');
  check(computeRejectionLatency(null, null, { today }).flags.length === 0, 'null inputs return no flags (no crash)');
  check(parseTrackerInterviewRows('').size === 0, 'empty tracker content returns no rows');
  check(parseTrackerInterviewRows(null).size === 0, 'non-string tracker content returns no rows (no crash)');

  console.log(`\n  rejection-latency self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  if (selfTestMode) {
    runSelfTest();
  }

  const profile = loadProfile();
  const profileCourtesy = Number.parseInt(profile.rejection_latency?.courtesy_days, 10);
  const cliCourtesy = Number.parseInt(cliCourtesyDays, 10);
  const courtesyDays = Number.isFinite(cliCourtesy) && cliCourtesy > 0
    ? cliCourtesy
    : (Number.isFinite(profileCourtesy) && profileCourtesy > 0 ? profileCourtesy : DEFAULT_COURTESY_DAYS);

  let today = new Date();
  if (cliToday) {
    const parsed = parseDate(cliToday);
    if (!parsed) {
      console.error(`--today expects YYYY-MM-DD, received "${cliToday}".`);
      process.exit(2);
    }
    today = parsed;
  }

  const interviewRows = parseActiveInterviews(readNormalized(ACTIVE_INTERVIEWS_PATH));
  const trackerMd = readNormalized(TRACKER_PATH);
  const trackerByCompany = parseTrackerInterviewRows(trackerMd);
  const excluded = placeholderInterviewRows(trackerMd);

  const result = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays,
  });

  if (excluded.length) {
    const nums = excluded.map(r => `#${r.num}`).join(', ');
    result.warnings.push(
      `${excluded.length} Interview-state application${excluded.length === 1 ? '' : 's'} (${nums}) `
      + 'excluded: the employer cell is a placeholder and no via= channel is set, so there is nothing '
      + 'to group by. Setting via= groups them under that channel — the only remediation this check reads.',
    );
  }

  const metadata = {
    today: isoDay(today),
    courtesyDays,
    interviewRows: interviewRows.length,
    companiesChecked: result.companiesChecked,
    placeholderApplicationsExcluded: excluded.length,
    flagged: result.flags.length,
    disclaimer: DISCLAIMER,
  };

  if (summaryMode) {
    printSummary(result, metadata);
  } else {
    console.log(JSON.stringify({
      metadata,
      flags: result.flags,
      warnings: result.warnings,
    }, null, 2));
  }
}
