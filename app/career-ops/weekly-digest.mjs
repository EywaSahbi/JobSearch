#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_SESSIONS_DIR = join(DATA_ROOT, 'interview-prep', 'sessions');
const DEFAULT_QUESTION_BANK_PATH = join(DATA_ROOT, 'interview-prep', 'question-bank.md');

const ROUND_ENUM = ['screen', 'hiring-manager', 'technical', 'system-design', 'behavioral', 'onsite', 'final'];

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function computeDefaultRange(now = new Date()) {
  const d = new Date(`${localToday(now)}T00:00:00Z`);
  const dayIdx = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIdx);
  const from = d.toISOString().slice(0, 10);
  const end = new Date(d);
  end.setUTCDate(d.getUTCDate() + 6);
  const to = end.toISOString().slice(0, 10);
  return { from, to };
}

function inRange(dateStr, from, to) {
  return isValidDateStr(dateStr) && dateStr >= from && dateStr <= to;
}

export function flagValue(args, flag) {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export function parseSessionFile(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  let front;
  try {
    front = yaml.load(match[1]) || {};
  } catch {
    return null;
  }
  if (typeof front !== 'object' || front === null) return null;
  const company = String(front.company ?? '').trim();
  const role = String(front.role ?? '').trim();
  const rawDate = front.date instanceof Date ? front.date.toISOString().slice(0, 10) : String(front.date ?? '').trim();
  if (!company || !role || !isValidDateStr(rawDate)) return null;
  const date = rawDate;

  const round = String(front.round ?? '').trim();
  const source = String(front.source ?? '').trim();
  const interviewerRole = String(front.interviewer_role ?? '').trim();

  const body = match[2] || '';
  const competencyTags = [];
  for (const m of body.matchAll(/<!--\s*competency:\s*(.*?)\s*-->/g)) {
    for (const tag of m[1].split(',')) {
      const t = tag.trim().toLowerCase();
      if (t) competencyTags.push(t);
    }
  }

  return { company, role, date, round, source, interviewerRole, competencyTags };
}

export function loadSessions(dir = DEFAULT_SESSIONS_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md');
  const sessions = [];
  for (const f of files) {
    let content;
    try {
      content = readFileSync(join(dir, f), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseSessionFile(content);
    if (parsed) sessions.push({ ...parsed, file: f });
  }
  return sessions;
}

export function extractGapsByCompany(content, companyNames) {
  const byCompany = new Map();
  if (!content || !Array.isArray(companyNames) || companyNames.length === 0) return byCompany;
  const lookup = companyNames.map((n) => ({ raw: n, lower: n.toLowerCase() }));
  let currentCompany = null;
  for (const rawLine of String(content).replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) {
      const headingText = line.replace(/^#{1,6}\s*/, '').toLowerCase();
      const found = lookup.find((c) => headingText.includes(c.lower));
      if (found) currentCompany = found.raw;
      else currentCompany = null;
      continue;
    }
    if (line.includes('🔴') && currentCompany) {
      const label = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      if (!byCompany.has(currentCompany)) byCompany.set(currentCompany, []);
      byCompany.get(currentCompany).push(label);
    }
  }
  return byCompany;
}

export function buildDigest(sessionsInRange, gapsByCompany = new Map()) {
  const byCompany = new Map();
  const tagCounts = new Map();

  for (const s of sessionsInRange) {
    const key = `${s.company.toLowerCase()}::${s.role.toLowerCase()}`;
    if (!byCompany.has(key)) {
      byCompany.set(key, { company: s.company, role: s.role, rounds: [] });
    }
    byCompany.get(key).rounds.push({ round: s.round, date: s.date, source: s.source, competencyTags: s.competencyTags });
    for (const tag of s.competencyTags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }

  const companies = [...byCompany.values()]
    .map((c) => ({
      ...c,
      rounds: c.rounds.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return String(a.round || '').localeCompare(String(b.round || ''));
      }),
    }))
    .sort((a, b) => a.company.localeCompare(b.company) || a.role.localeCompare(b.role));

  const recurringCompetencies = [...tagCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const recurringGaps = [...gapsByCompany.entries()]
    .map(([company, gaps]) => ({ company, gaps }))
    .filter((g) => g.gaps.length > 0)
    .sort((a, b) => b.gaps.length - a.gaps.length || a.company.localeCompare(b.company));

  return {
    companies,
    competencyTagCounts: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    recurringCompetencies,
    recurringGaps,
  };
}

export function computeWeeklyDigest({
  from,
  to,
  sessionsDir = DEFAULT_SESSIONS_DIR,
  questionBankPath = DEFAULT_QUESTION_BANK_PATH,
} = {}) {
  let range;
  if (from === undefined && to === undefined) {
    range = computeDefaultRange();
  } else if (from === undefined || to === undefined) {
    throw new Error('--from and --to must both be supplied together (or neither, to use the default current-week range).');
  } else if (from > to) {
    throw new Error(`--from (${from}) must not be after --to (${to}).`);
  } else {
    range = { from, to };
  }

  const allSessions = loadSessions(sessionsDir);
  const sessionsInRange = allSessions.filter((s) => inRange(s.date, range.from, range.to));

  const companyNames = [...new Set(sessionsInRange.map((s) => s.company))];
  const questionBankFound = existsSync(questionBankPath);
  let qbContent = null;
  if (questionBankFound) {
    try {
      qbContent = readFileSync(questionBankPath, 'utf-8');
    } catch {
      qbContent = null;
    }
  }
  const gapsByCompany = qbContent ? extractGapsByCompany(qbContent, companyNames) : new Map();

  const digest = buildDigest(sessionsInRange, gapsByCompany);

  const uniqueCompanyCount = new Set(sessionsInRange.map((s) => s.company.toLowerCase())).size;

  return {
    metadata: {
      range,
      sessionsDirFound: existsSync(sessionsDir),
      questionBankFound,
      totalSessionsFound: allSessions.length,
      sessionsInRange: sessionsInRange.length,
      companiesInRange: uniqueCompanyCount,
    },
    ...digest,
  };
}

function printSummary(result) {
  const line = '━'.repeat(45);
  console.log(`\n${line}`);
  console.log(`Weekly Interview Digest — ${result.metadata.range.from} to ${result.metadata.range.to}`);
  console.log(line);

  if (result.metadata.sessionsInRange === 0) {
    const reason = !result.metadata.sessionsDirFound
      ? '(interview-prep/sessions/ not found)'
      : '(no session files fall inside this range)';
    console.log(`No interviews recorded in this range ${reason}.`);
    console.log('');
    return;
  }

  console.log(`Sessions:    ${result.metadata.sessionsInRange} in range across ${result.metadata.companiesInRange} companies (${result.metadata.totalSessionsFound} total on file)`);
  console.log('');
  for (const c of result.companies) {
    const rounds = c.rounds.map((r) => `${r.round || 'round'} (${r.date})`).join(' → ');
    console.log(`• ${c.company} — ${c.role}`);
    console.log(`    Rounds: ${rounds}`);
  }

  if (result.recurringCompetencies.length > 0) {
    console.log('');
    console.log('Recurring competencies this week:');
    for (const t of result.recurringCompetencies) {
      console.log(`  - ${t.tag} (${t.count}x)`);
    }
  }

  if (result.recurringGaps.length > 0) {
    console.log('');
    console.log('Open gaps by company (from question-bank.md, best-effort):');
    for (const g of result.recurringGaps) {
      console.log(`  - ${g.company}: ${g.gaps.length} 🔴 item(s)`);
      for (const gap of g.gaps) console.log(`      ↳ ${gap}`);
    }
  } else if (result.metadata.questionBankFound) {
    console.log('');
    console.log('Open gaps by company: none matched (question-bank.md present but no 🔴 items tied to this week\'s companies)');
  }
  console.log('');
}

async function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const localNoon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
  const wed = computeDefaultRange(localNoon(2026, 7, 22));
  check(wed.from === '2026-07-20' && wed.to === '2026-07-26', 'computeDefaultRange resolves the containing Mon-Sun week');
  const mon = computeDefaultRange(localNoon(2026, 7, 20));
  check(mon.from === '2026-07-20' && mon.to === '2026-07-26', 'computeDefaultRange handles Monday itself as the range start');
  const sun = computeDefaultRange(localNoon(2026, 7, 26));
  check(sun.from === '2026-07-20' && sun.to === '2026-07-26', 'computeDefaultRange handles Sunday itself as the range end');
  for (const [now, label] of [
    [new Date(2026, 6, 26, 23, 30, 0), 'Sunday 23:30 local'],
    [new Date(2026, 6, 20, 0, 30, 0), 'Monday 00:30 local'],
  ]) {
    const r = computeDefaultRange(now);
    check(r.from <= localToday(now) && localToday(now) <= r.to,
      `computeDefaultRange contains the caller's own day (${label})`);
  }

  check(flagValue(['--from', '2020-01-01'], '--from') === '2020-01-01', 'flagValue reads the space-separated form');
  check(flagValue(['--from=2020-01-01'], '--from') === '2020-01-01', 'flagValue reads the --flag=value form');
  check(flagValue(['--summary'], '--from') === undefined, 'flagValue returns undefined for an absent flag');
  check(flagValue(['--from='], '--from') === '', 'flagValue reports an explicitly empty value as empty, not absent');
  check(flagValue(['--dir=/tmp/x=y'], '--dir') === '/tmp/x=y', 'flagValue keeps later "=" characters in the value');
  check(flagValue(['--to=2020-01-07', '--from=2020-01-01'], '--from') === '2020-01-01', 'flagValue matches its own flag, not a similarly-shaped neighbour');

  const goodSession = [
    '---',
    'company: Acme Corp',
    'role: Instructional Designer',
    'round: behavioral',
    'date: 2026-07-21',
    'interviewer_role: Senior HR Partner',
    'source: debrief',
    '---',
    '',
    '## Q1',
    '**Interviewer:** Tell me about a time you led a project.',
    '<!-- competency: stakeholder-management -->',
    '**Candidate:** ...answer...',
    '',
    '## Q2',
    '**Interviewer:** How do you handle ambiguous scope?',
    '<!-- competency: stakeholder-management, scope-management -->',
    '**Candidate:** ...answer...',
  ].join('\n');
  const parsed = parseSessionFile(goodSession);
  check(!!parsed, 'well-formed session file parses');
  if (parsed) {
    check(parsed.company === 'Acme Corp', 'company extracted');
    check(parsed.role === 'Instructional Designer', 'role extracted');
    check(parsed.round === 'behavioral' && ROUND_ENUM.includes(parsed.round), 'round extracted and in enum');
    check(parsed.date === '2026-07-21', 'date extracted');
    check(parsed.competencyTags.length === 3, 'all competency tags collected across Q&A pairs');
    check(parsed.competencyTags.filter((t) => t === 'stakeholder-management').length === 2, 'repeated tag counted once per occurrence');
  }

  check(parseSessionFile('no front matter here') === null, 'missing front matter returns null, not a crash');
  check(parseSessionFile('---\ncompany: Acme\n---\nbody') === null, 'front matter missing required fields (role/date) returns null');
  check(parseSessionFile(null) === null, 'null input returns null, not a crash');

  check(loadSessions('/definitely/does/not/exist/anywhere') .length === 0, 'missing sessions directory returns empty array');

  const sessionsInRange = [
    { company: 'Acme Corp', role: 'Instructional Designer', date: '2026-07-21', round: 'behavioral', source: 'debrief', competencyTags: ['stakeholder-management'] },
    { company: 'Acme Corp', role: 'Instructional Designer', date: '2026-07-23', round: 'technical', source: 'debrief', competencyTags: ['curriculum-design'] },
    { company: 'Beta Learning', role: 'LXD', date: '2026-07-22', round: 'screen', source: 'practice', competencyTags: ['stakeholder-management'] },
  ];
  const digest = buildDigest(sessionsInRange);
  check(digest.companies.length === 2, 'two distinct companies grouped');
  const acme = digest.companies.find((c) => c.company === 'Acme Corp');
  check(!!acme && acme.rounds.length === 2, 'Acme Corp rolls up both of its rounds');
  check(acme.rounds[0].date === '2026-07-21' && acme.rounds[1].date === '2026-07-23', 'rounds sorted chronologically');
  check(digest.recurringCompetencies.some((t) => t.tag === 'stakeholder-management' && t.count === 2), 'competency tag recurring across two different companies is surfaced');
  check(!digest.recurringCompetencies.some((t) => t.tag === 'curriculum-design'), 'a tag seen only once is not flagged as recurring');

  const emptyDigest = buildDigest([]);
  check(emptyDigest.companies.length === 0 && emptyDigest.recurringCompetencies.length === 0, 'empty session list returns an empty, non-crashing digest');

  const qb = [
    '# Question Bank',
    '',
    '## Acme Corp — Instructional Designer',
    '- **Q:** Explain backward design. Status: 🔴 Gap',
    '- **Q:** What is a rubric? Status: ✅ Strong',
    '',
    '## Some Unrelated Company',
    '- **Q:** Off-topic question. Status: 🔴 Gap',
    '',
    '## Beta Learning — LXD',
    '- **Q:** Describe your LMS migration experience. Status: 🔴 Gap',
  ].join('\n');
  const gaps = extractGapsByCompany(qb, ['Acme Corp', 'Beta Learning']);
  check(gaps.get('Acme Corp')?.length === 1, 'gap attributed to Acme Corp under its own heading');
  check(!gaps.has('Some Unrelated Company'), 'gap under an unrelated heading is not attributed to any in-range company');
  check(gaps.get('Beta Learning')?.length === 1, 'gap attributed to Beta Learning under its own heading');
  check(extractGapsByCompany('', ['Acme Corp']).size === 0, 'empty question-bank content returns an empty map');
  check(extractGapsByCompany(qb, []).size === 0, 'no company names to match against returns an empty map');

  const tmpBase = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const tmpDir = mkdtempSync(join(tmpBase, 'weekly-digest-selftest-'));
  try {
    writeFileSync(join(tmpDir, 'acme-corp-instructional-designer-behavioral-2026-07-21.md'), goodSession);
    writeFileSync(join(tmpDir, 'README.md'), 'not a session');
    const result = computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: tmpDir, questionBankPath: '/definitely/does/not/exist/question-bank.md' });
    check(result.metadata.sessionsInRange === 1, 'end-to-end: one in-range session found in the fixture dir, README.md ignored');
    check(result.metadata.questionBankFound === false, 'end-to-end: missing question-bank.md is reported, not an error');
    check(result.companies.length === 1 && result.companies[0].company === 'Acme Corp', 'end-to-end: company rollup present');

    const outOfRange = computeWeeklyDigest({ from: '2020-01-01', to: '2020-01-07', sessionsDir: tmpDir, questionBankPath: '/definitely/does/not/exist/question-bank.md' });
    check(outOfRange.metadata.sessionsInRange === 0, 'end-to-end: a range with no matching sessions reports zero, not an error');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const missingDirResult = computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: '/definitely/does/not/exist/sessions', questionBankPath: '/definitely/does/not/exist/question-bank.md' });
  check(missingDirResult.metadata.sessionsDirFound === false, 'missing sessions directory is reported, not an error');
  check(missingDirResult.metadata.sessionsInRange === 0, 'missing sessions directory yields zero sessions, exit 0 contract');

  const twoRoleSessions = [
    { company: 'Acme Corp', role: 'Instructional Designer', date: '2026-07-21', round: 'behavioral', source: 'debrief', competencyTags: [] },
    { company: 'Acme Corp', role: 'LXD', date: '2026-07-22', round: 'screen', source: 'debrief', competencyTags: [] },
  ];
  const twoRoleDigest = buildDigest(twoRoleSessions);
  check(twoRoleDigest.companies.length === 2, 'buildDigest still groups by company+role (two rollup rows for one company)');
  const uniqueCompanyCount = new Set(twoRoleSessions.map((s) => s.company.toLowerCase())).size;
  check(uniqueCompanyCount === 1, 'unique-company count collapses a two-role company to one');

  const tmpTwoRoleDir = mkdtempSync(join(tmpBase, 'weekly-digest-selftest-tworole-'));
  try {
    writeFileSync(
      join(tmpTwoRoleDir, 'acme-corp-instructional-designer-behavioral-2026-07-21.md'),
      ['---', 'company: Acme Corp', 'role: Instructional Designer', 'round: behavioral', 'date: 2026-07-21', 'source: debrief', '---', ''].join('\n'),
    );
    writeFileSync(
      join(tmpTwoRoleDir, 'acme-corp-lxd-screen-2026-07-22.md'),
      ['---', 'company: Acme Corp', 'role: LXD', 'round: screen', 'date: 2026-07-22', 'source: debrief', '---', ''].join('\n'),
    );
    const twoRoleResult = computeWeeklyDigest({
      from: '2026-07-20',
      to: '2026-07-26',
      sessionsDir: tmpTwoRoleDir,
      questionBankPath: '/definitely/does/not/exist/question-bank.md',
    });
    check(twoRoleResult.metadata.companiesInRange === 1, 'computeWeeklyDigest end-to-end: metadata.companiesInRange collapses a two-role company to one');
    check(twoRoleResult.companies.length === 2, 'computeWeeklyDigest end-to-end: rollup still has two rows (company+role grouping preserved)');
  } finally {
    rmSync(tmpTwoRoleDir, { recursive: true, force: true });
  }

  const sameDateSessions = [
    { company: 'Gamma Inc', role: 'EdTech Specialist', date: '2026-07-21', round: 'technical', source: 'debrief', competencyTags: [] },
    { company: 'Gamma Inc', role: 'EdTech Specialist', date: '2026-07-21', round: 'behavioral', source: 'debrief', competencyTags: [] },
  ];
  const sameDateDigest = buildDigest(sameDateSessions);
  const gamma = sameDateDigest.companies.find((c) => c.company === 'Gamma Inc');
  check(!!gamma && gamma.rounds.length === 2, 'Gamma Inc rolls up both same-date rounds');
  check(!!gamma && gamma.rounds[0].round === 'behavioral' && gamma.rounds[1].round === 'technical', 'same-date rounds break ties alphabetically by round name, deterministically');

  const tmpQbDir = mkdtempSync(join(tmpBase, 'weekly-digest-selftest-qb-'));
  try {
    writeFileSync(join(tmpQbDir, 'acme-corp-instructional-designer-behavioral-2026-07-21.md'), goodSession);
    const emptyQbPath = join(tmpQbDir, 'question-bank.md');
    writeFileSync(emptyQbPath, '');
    const emptyQbResult = computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: tmpQbDir, questionBankPath: emptyQbPath });
    check(emptyQbResult.metadata.questionBankFound === true, 'existing-but-empty question-bank.md is reported as found');
    check(emptyQbResult.recurringGaps.length === 0, 'existing-but-empty question-bank.md yields no gaps, no crash');

    const missingQbResult = computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: tmpQbDir, questionBankPath: join(tmpQbDir, 'does-not-exist.md') });
    check(missingQbResult.metadata.questionBankFound === false, 'a genuinely missing question-bank.md is still reported as not found');
  } finally {
    rmSync(tmpQbDir, { recursive: true, force: true });
  }

  const tmpQbDirAsPath = mkdtempSync(join(tmpBase, 'weekly-digest-selftest-qbdir-'));
  try {
    const unreadableQbDir = mkdtempSync(join(tmpQbDirAsPath, 'question-bank-'));
    writeFileSync(join(tmpQbDirAsPath, 'acme-corp-instructional-designer-behavioral-2026-07-21.md'), goodSession);
    const dirAsQbResult = computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: tmpQbDirAsPath, questionBankPath: unreadableQbDir });
    check(dirAsQbResult.metadata.questionBankFound === true, 'a question-bank path that is a directory is still reported as found (existsSync is true)');
    check(dirAsQbResult.recurringGaps.length === 0, 'a question-bank path that fails to read (EISDIR) yields no gaps, no thrown exception');
  } finally {
    rmSync(tmpQbDirAsPath, { recursive: true, force: true });
  }

  let threwFromOnly = false;
  try {
    computeWeeklyDigest({ from: '2026-07-20', sessionsDir: '/definitely/does/not/exist/sessions' });
  } catch {
    threwFromOnly = true;
  }
  check(threwFromOnly, '--from without --to throws instead of silently using the default range');

  let threwToOnly = false;
  try {
    computeWeeklyDigest({ to: '2026-07-26', sessionsDir: '/definitely/does/not/exist/sessions' });
  } catch {
    threwToOnly = true;
  }
  check(threwToOnly, '--to without --from throws instead of silently using the default range');

  let threwReversed = false;
  try {
    computeWeeklyDigest({ from: '2026-07-26', to: '2026-07-20', sessionsDir: '/definitely/does/not/exist/sessions' });
  } catch {
    threwReversed = true;
  }
  check(threwReversed, 'from > to throws instead of silently returning an empty digest');

  let validRangeOk = true;
  try {
    computeWeeklyDigest({ from: '2026-07-20', to: '2026-07-26', sessionsDir: '/definitely/does/not/exist/sessions' });
  } catch {
    validRangeOk = false;
  }
  check(validRangeOk, 'both --from and --to supplied with from <= to computes the digest without error');

  console.log(`\n  weekly-digest self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

const KNOWN_FLAGS = ['--from', '--to', '--dir', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--from', '--to', '--dir'];

const USAGE = `Usage:
  node weekly-digest.mjs                        # JSON digest for the current ISO week
  node weekly-digest.mjs --summary              # human-readable roll-up
  node weekly-digest.mjs --from <YYYY-MM-DD>    # start of the window
  node weekly-digest.mjs --to <YYYY-MM-DD>      # end of the window
  node weekly-digest.mjs --dir <path>           # a different interview-prep/sessions dir
  node weekly-digest.mjs --self-test            # run the built-in fixtures
  node weekly-digest.mjs --help                 # show this message

Both bounds are optional; supplying one without the other is rejected rather
than silently widened.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (args.includes('--self-test')) {
    await runSelfTest();
  }

  const summaryMode = args.includes('--summary');
  const from = flagValue(args, '--from');
  const to = flagValue(args, '--to');
  const dirValue = flagValue(args, '--dir');
  const sessionsDir = dirValue ? dirValue : DEFAULT_SESSIONS_DIR;

  if ((from !== undefined && !isValidDateStr(from)) || (to !== undefined && !isValidDateStr(to))) {
    console.error('  Invalid --from/--to date — expected YYYY-MM-DD');
    process.exit(1);
  }

  let result;
  try {
    result = computeWeeklyDigest({ from, to, sessionsDir });
  } catch (err) {
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  if (summaryMode) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
