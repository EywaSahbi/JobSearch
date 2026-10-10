#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { findCaptureForReport } from './jd-capture.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from './tracker-parse.mjs';
import { loadCanonicalStates, resolveCanonicalState, resolveTrackerPath } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_REPORTS_DIR = join(DATA_ROOT, 'reports');
const DEFAULT_JDS_DIR = join(DATA_ROOT, 'jds');
const DEFAULT_TRACKER_PATH = resolveTrackerPath(DATA_ROOT);
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

const RETROACTIVE_TERMINAL_LABELS = new Set(['Rejected', 'Discarded', 'SKIP', 'Hired']);

const MIN_ARCHIVE_CHARS = 40;

const USAGE = `Usage:
  node check-jd-archive.mjs                      # full JSON findings to stdout
  node check-jd-archive.mjs --summary             # human-readable table
  node check-jd-archive.mjs --reports-dir <path>  # override reports/ (testing)
  node check-jd-archive.mjs --jds-dir <path>      # override jds/ (testing)
  node check-jd-archive.mjs --tracker <path>      # override data/applications.md (testing)
  node check-jd-archive.mjs --no-tracker          # skip the tracker join (legacy hard-only behavior)
  node check-jd-archive.mjs --self-test           # run the in-memory test suite
  node check-jd-archive.mjs --help                # print this usage block and exit`;

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const reportsDirArg = flagValue(args, '--reports-dir') ?? null;
const jdsDirArg = flagValue(args, '--jds-dir') ?? null;
const trackerArg = flagValue(args, '--tracker') ?? null;
const noTrackerMode = args.includes('--no-tracker');

const REPORT_FILENAME_RE = /^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/;

export function parseReportFilename(filename) {
  const m = REPORT_FILENAME_RE.exec(filename);
  if (!m) return null;
  return { reportNum: parseInt(m[1], 10), companySlug: m[2], date: m[3] };
}

const JD_HEADING_RE = /^##\s+Job Description\b.*$/im;
const NEXT_REPORT_SECTION_RE =
  /^##\s+(?:Machine Summary|Keywords extracted|[A-Z]\)|Block\s[A-Z]\b|Risk Summary|Cover Letter Draft|Post-evaluation|Liveness gate|Blacklist gate|Bounded Research Budget|Step 0\b)/im;

const UNFILLED_TEMPLATE_PLACEHOLDER =
  "(the posting's full text, pasted verbatim — see requirement below)";

const JDS_PATH_RE = /jds\/[^\s()]+\.md/;
const POSTED_LINE_RE = /^Posted:.*$/im;
const POINTER_SENTENCE_RE =
  /^See\s+jds\/[^\s()]+\.md\s+for the full archive(?:\s*\(archive-posting\.mjs\s+--report=\d+\))?\.?$/i;

function isPathOnlyPointer(strippedSection) {
  const withoutPostedLine = strippedSection.replace(POSTED_LINE_RE, '').trim();
  return POINTER_SENTENCE_RE.test(withoutPostedLine);
}

const NON_CONTENT_MARKERS = [
  {
    category: 'login-wall',
    reason: 'looks like a sign-in/login wall, not a posting',
    re: /(sign in to view this job|join linkedin to see who you know at|please log in to continue|sign in to continue)/i,
  },
  {
    category: '404-shell',
    reason: 'looks like a 404 / page-not-found shell, not a posting',
    re: /(404\s*(?:error|not found)|page not found|this job posting is no longer available)/i,
  },
  {
    category: 'paywall',
    reason: 'looks like a paywall/subscription interstitial, not a posting',
    re: /(subscribe to continue reading|this content is for subscribers)/i,
  },
  {
    category: 'js-required',
    reason: 'looks like a "please enable JavaScript" shell, not a posting',
    re: /(please enable javascript|this site requires javascript|<noscript)/i,
  },
  {
    category: 'bot-challenge',
    reason: 'looks like a bot-verification/challenge page, not a posting',
    re: /(checking your browser before accessing|verify(?:ing)? (?:that )?you are (?:a )?human|please stand by,? while we (?:are )?check(?:ing)? your browser|cloudflare ray id|captcha verification required to continue)/i,
  },
];

export function detectNonContentMarker(strippedSection) {
  for (const marker of NON_CONTENT_MARKERS) {
    if (marker.re.test(strippedSection)) return marker;
  }
  return null;
}

export function extractStrippedJdSection(content) {
  const text = String(content ?? '');
  const m = JD_HEADING_RE.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const nextHeadingOffset = rest.search(NEXT_REPORT_SECTION_RE);
  const section = nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset);
  let stripped = section;
  let prev;
  do {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== prev);
  return stripped.trim();
}

export function hasEmbeddedJdArchive(content) {
  const stripped = extractStrippedJdSection(content);
  if (stripped === null) return false;
  if (stripped === UNFILLED_TEMPLATE_PLACEHOLDER) return false;
  if (isPathOnlyPointer(stripped)) return false;
  if (detectNonContentMarker(stripped)) return false;
  return stripped.length >= MIN_ARCHIVE_CHARS;
}

export function classifyReportsByTrackerState(trackerPath, statesPath) {
  if (!trackerPath || !existsSync(trackerPath)) return null;

  let lines;
  try {
    lines = readFileSync(trackerPath, 'utf-8').split('\n');
  } catch {
    return null;
  }

  let states;
  try {
    states = loadCanonicalStates(statesPath);
  } catch {
    return null;
  }

  const colmap = resolveColumns(lines);
  const byReport = new Map();

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    for (const num of extractTrackerReportNumbers(row.report, row.notes)) {
      if (!byReport.has(num)) byReport.set(num, []);
      byReport.get(num).push(row);
    }
  }

  const classification = new Map();
  for (const [num, matches] of byReport) {
    if (matches.length !== 1) continue;
    const canonicalLabel = resolveCanonicalState(matches[0].status, states);
    if (canonicalLabel && RETROACTIVE_TERMINAL_LABELS.has(canonicalLabel)) {
      classification.set(num, 'terminal');
    }
  }

  return classification;
}

export function mapTrackerCaptureLinks(trackerPath, jdsDir) {
  const map = new Map();
  if (!trackerPath || !existsSync(trackerPath)) return map;

  let lines;
  try {
    lines = readFileSync(trackerPath, 'utf-8').split('\n');
  } catch {
    return map;
  }

  const dataRoot = dirname(jdsDir);
  const colmap = resolveColumns(lines);

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const cell = `${row.report ?? ''} ${row.notes ?? ''}`;
    const match = cell.match(JDS_PATH_RE);
    if (!match) continue;
    const abs = [join(dataRoot, match[0]), join(jdsDir, basename(match[0]))]
      .find((candidate) => existsSync(candidate));
    if (!abs) continue;
    const keys = extractTrackerReportNumbers(row.report, row.notes);
    if (!keys.length && Number.isInteger(row.num)) keys.push(row.num);
    for (const num of keys) {
      if (!map.has(num)) map.set(num, abs);
    }
  }

  return map;
}

export function checkJdArchive(reportsDir, jdsDir, { trackerPath = null, statesPath = STATES_FILE } = {}) {
  const findings = [];
  const warnings = [];
  let reportsScanned = 0;

  if (!existsSync(reportsDir)) {
    return { reportsScanned, findings, warnings };
  }

  const classification = classifyReportsByTrackerState(trackerPath, statesPath);
  const trackerCaptures = mapTrackerCaptureLinks(trackerPath, jdsDir);

  const files = readdirSync(reportsDir)
    .filter((f) => f.endsWith('.md') && !/^\d+-RESERVED\.md$/.test(f))
    .sort();

  for (const file of files) {
    reportsScanned += 1;

    let content;
    try {
      content = readFileSync(join(reportsDir, file), 'utf-8');
    } catch (e) {
      warnings.push({ type: 'warning', file, detail: `could not read file: ${e.message.split('\n')[0]}` });
      continue;
    }

    if (hasEmbeddedJdArchive(content)) continue;

    const meta = parseReportFilename(file);
    let capture = null;
    if (meta && existsSync(jdsDir)) {
      capture = findCaptureForReport(jdsDir, meta.reportNum, { companySlug: meta.companySlug });
    }
    if (capture !== null) continue;

    const reportNum = meta ? meta.reportNum : null;
    if (reportNum !== null && trackerCaptures.has(reportNum)) continue;
    const state = classification === null
      ? null
      : (reportNum !== null && classification.get(reportNum) === 'terminal' ? 'terminal' : 'live');

    if (state === 'terminal') continue;

    const strippedSection = extractStrippedJdSection(content);
    const marker = strippedSection !== null ? detectNonContentMarker(strippedSection) : null;

    const detail = marker
      ? `"## Job Description" section ${marker.reason} — not credited as an archive, and no jds/ capture found${meta ? ` for report ${meta.reportNum} (company slug "${meta.companySlug}")` : ''}`
      : meta
        ? `no "## Job Description" section with archived JD text, and no jds/ capture found for report ${meta.reportNum} (company slug "${meta.companySlug}")`
        : `no "## Job Description" section with archived JD text, and the filename does not match the {###}-{company-slug}-{YYYY-MM-DD}.md convention so no jds/ capture could be resolved`;

    findings.push(state === 'live'
      ? {
        type: 'jd-archive-review-due',
        file,
        report: reportNum,
        companySlug: meta ? meta.companySlug : null,
        detail: `${detail} — tracker row is still live (or unresolved), so this is a soft warning, not a blocker`,
      }
      : {
        type: 'missing-jd-archive',
        file,
        report: reportNum,
        companySlug: meta ? meta.companySlug : null,
        detail,
      });
  }

  return { reportsScanned, findings, warnings };
}

export const hasMissingArchive = (findings) => findings.some((f) => f.type === 'missing-jd-archive');

const SUBMITTED_LABELS = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);

export function findUnarchivedApplications(trackerPath, reportsDir, jdsDir, statesPath = STATES_FILE) {
  if (!trackerPath || !existsSync(trackerPath)) return [];

  let lines;
  let states;
  try {
    lines = readFileSync(trackerPath, 'utf-8').split('\n');
    states = loadCanonicalStates(statesPath);
  } catch {
    return [];
  }

  const trackerCaptures = mapTrackerCaptureLinks(trackerPath, jdsDir);
  const reportFiles = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((f) => f.endsWith('.md'))
    : [];
  const reportsByNum = new Map();
  for (const f of reportFiles) {
    const meta = parseReportFilename(f);
    if (meta) reportsByNum.set(meta.reportNum, f);
  }

  const colmap = resolveColumns(lines);
  const out = [];

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const label = resolveCanonicalState(row.status, states);
    if (!label || !SUBMITTED_LABELS.has(label)) continue;

    const nums = extractTrackerReportNumbers(row.report, row.notes);
    const keys = nums.length ? nums : (Number.isInteger(row.num) ? [row.num] : []);
    const hasCapture = keys.some((n) => trackerCaptures.has(n));
    const hasReport = keys.some((n) => reportsByNum.has(n));
    if (hasCapture || hasReport) continue;

    out.push({
      type: 'application-no-archive',
      row: row.num ?? '?',
      company: row.company ?? '?',
      role: row.role ?? '?',
      status: label,
      detail: 'application was sent but has no report file and no jds/ capture — '
        + 'nothing records what the role asked for',
    });
  }

  return out;
}

function printSummary(result) {
  const { reportsScanned, findings, warnings } = result;
  console.log(`\n${'='.repeat(78)}`);
  console.log('  JD Archive Coverage — career-ops');
  console.log(`  reports scanned: ${reportsScanned}`);
  console.log(`${'='.repeat(78)}\n`);

  if (findings.length === 0) {
    console.log(reportsScanned === 0
      ? '  No report files found under reports/.\n'
      : '  Every report has an archived JD (embedded section or jds/ capture).\n');
  } else {
    const header = '  ' + 'Type'.padEnd(22) + 'Report'.padEnd(10) + 'File'.padEnd(30) + 'Detail';
    console.log(header);
    console.log('  ' + '-'.repeat(90));
    for (const f of findings) {
      const typeCol = f.type.padEnd(22);
      const reportCol = (f.report !== null ? String(f.report) : '?').padEnd(10);
      const fileCol = f.file.substring(0, 28).padEnd(30);
      console.log('  ' + typeCol + reportCol + fileCol + f.detail);
    }
    console.log('');
  }

  if (warnings.length) {
    console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (files skipped, never fatal):`);
    for (const w of warnings) {
      console.log(`    ${w.file}: ${w.detail}`);
    }
    console.log('');
  }
}

function printUnarchivedApplications(rows) {
  if (!rows.length) return;
  console.log('  Applications sent with no archive at all (soft — never blocks):');
  console.log('  ' + 'Row'.padEnd(8) + 'Status'.padEnd(12) + 'Company'.padEnd(28) + 'Role');
  console.log('  ' + '-'.repeat(90));
  for (const r of rows) {
    console.log('  '
      + String(r.row).padEnd(8)
      + r.status.padEnd(12)
      + String(r.company).substring(0, 26).padEnd(28)
      + String(r.role).substring(0, 44));
  }
  console.log('\n  These were applied to, so the posting had real consequences, but nothing');
  console.log('  on disk records what the role asked for. Capture one with:');
  console.log('    node archive-posting.mjs --report=<N>   (live posting)');
  console.log('  or save the original description to jds/ and link it from the tracker row.\n');
}

function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  check(parseReportFilename('042-acme-2026-01-15.md')?.reportNum === 42, 'parseReportFilename extracts the report number');
  check(parseReportFilename('042-acme-2026-01-15.md')?.companySlug === 'acme', 'parseReportFilename extracts a simple company slug');
  check(parseReportFilename('042-confidential-hays-2026-01-15.md')?.companySlug === 'confidential-hays',
    'parseReportFilename extracts a hyphenated company slug (agency-mediated posting, #1596)');
  check(parseReportFilename('not-a-report.md') === null, 'parseReportFilename rejects a non-conforming filename');
  check(parseReportFilename('042-acme-2026-01-15.txt') === null, 'parseReportFilename requires the .md extension');

  check(hasEmbeddedJdArchive('## Job Description (archived verbatim)\n\n' + 'A'.repeat(50) + '\n\n## Machine Summary\nfoo'),
    'hasEmbeddedJdArchive recognizes the canonical heading with substantive content');
  check(hasEmbeddedJdArchive('## Job Description\n\nWe are looking for a Senior Widget Engineer to join our growing platform team.'),
    'hasEmbeddedJdArchive recognizes a bare "## Job Description" heading (no parenthetical) with content');
  check(!hasEmbeddedJdArchive('## Job Description (archived verbatim)\n\n<!-- paste JD here -->\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a section containing only an HTML-comment placeholder');
  check(!hasEmbeddedJdArchive('## Job Description (archived verbatim)\n\n<!--<!---->-->\n\n## Machine Summary'),
    'hasEmbeddedJdArchive strips nested/overlapping comment markers to a fixed point rather than leaving a reconstructed <!-- --> behind after one pass (CodeQL incomplete-sanitization fix, PR #2791)');
  check(!hasEmbeddedJdArchive('## Job Description (archived verbatim)\n\nTBD\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a section too short to be real JD text');
  check(!hasEmbeddedJdArchive('# Evaluation: Acme — Engineer\n\n**URL:** https://example.com\n'),
    'hasEmbeddedJdArchive returns false when there is no Job Description section at all');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nWe are looking for a Senior Widget Engineer.\n\n## Responsibilities\n\nShip widgets and mentor the team.\n\n## Machine Summary\nfoo'),
    'hasEmbeddedJdArchive keeps a JD-internal "## Responsibilities" sub-heading inside the section instead of truncating on it (CodeRabbit, PR #2791)');
  check(!hasEmbeddedJdArchive(
    "## Job Description (archived verbatim)\n(the posting's full text, pasted verbatim — see requirement below)\n\n## Machine Summary"),
    'hasEmbeddedJdArchive rejects the unfilled modes/oferta.md template placeholder even though it exceeds MIN_ARCHIVE_CHARS by length alone (CodeRabbit, PR #2791)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nSee jds/042-acme-corp-2026-01-15.md for the full archive (archive-posting.mjs --report=042).\n\n## Machine Summary'),
    'hasEmbeddedJdArchive does not credit a path-only pointer sentence as embedded text, even though it clears MIN_ARCHIVE_CHARS by length alone — the pointer must resolve via findCaptureForReport instead (CodeRabbit, PR #2791)');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nThis role owns curriculum design end to end, including SCORM packaging and LMS rollout, across three regional teams and a portfolio of concurrent projects.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive still credits substantive real prose with no jds/ path reference at all');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nThis role owns curriculum design end to end, including SCORM packaging and LMS rollout. See jds/legacy-notes.md for historical context on the prior version of this posting.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive credits substantive JD prose even when it also mentions a jds/*.md path in passing — the section is not JUST the canonical pointer sentence, so it is read as archived text, not a pointer (CodeRabbit, PR #2791 round 4)');

  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nSign in to view this job · Join LinkedIn to see who you know at Acme Corporation.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a LinkedIn-style login-wall shell even though it clears MIN_ARCHIVE_CHARS by length alone (#3829)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nPlease log in to continue. You must sign in to view this content and manage your job alerts.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a generic "please log in to continue" auth-wall shell (#3829)');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nThis role manages our online course catalog. Please log in to our internal LMS after onboarding to review the current curriculum before your first day.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive does not false-positive on real JD prose containing a bare "Please log in" instruction unrelated to the archive itself being a login wall (CodeRabbit, PR #3837)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\n404 Not Found. The page you requested could not be located on this server.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a 404 error shell (#3829)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nThis job posting is no longer available. It may have been filled or removed by the employer.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a "this job posting is no longer available" removed-posting shell (#3829)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nSubscribe to continue reading. This content is for subscribers only — create a free account to keep reading.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a paywall/subscription interstitial (#3829)');
  check(!hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nPlease enable JavaScript to run this application. This site requires JavaScript to display job listings.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive rejects a "please enable JavaScript" shell (#3829)');
  check(detectNonContentMarker('Sign in to view this job · Join LinkedIn to see who you know at Acme.')?.category === 'login-wall',
    'detectNonContentMarker classifies a login-wall shell with the login-wall category');
  check(detectNonContentMarker('404 Not Found. Page not found.')?.category === '404-shell',
    'detectNonContentMarker classifies a 404 shell with the 404-shell category');
  check(detectNonContentMarker('Subscribe to continue reading this article.')?.category === 'paywall',
    'detectNonContentMarker classifies a paywall interstitial with the paywall category');
  check(detectNonContentMarker('Please enable JavaScript to run this application.')?.category === 'js-required',
    'detectNonContentMarker classifies a JS-required shell with the js-required category');
  check(detectNonContentMarker('This role owns curriculum design end to end, including SCORM packaging and LMS rollout across three teams.') === null,
    'detectNonContentMarker returns null for substantive real JD prose with no non-content phrasing');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nWe are hiring a part-time Instructional Design Assistant to support course updates in our LMS, 10 hours/week, remote, $28/hr. Email your resume to hiring@example.com.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive still credits a genuine, terse real JD excerpt — the non-content-marker rejection is not over-aggressive (#3829)');
  check(hasEmbeddedJdArchive(
    '## Job Description (archived verbatim)\n\nOnce hired, you will sign in to our internal LMS daily to manage learner rosters and publish course updates across three regional campuses.\n\n## Machine Summary'),
    'hasEmbeddedJdArchive does not false-positive on real JD prose that merely mentions signing in to an internal system, since it does not match the anchored login-wall phrasing (#3829)');

  const tmpDir = mkdtempSync(join(tmpdir(), 'check-jd-archive-test-'));
  const reportsDir = join(tmpDir, 'reports');
  const jdsDir = join(tmpDir, 'jds');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(jdsDir, { recursive: true });

  try {
    writeFileSync(join(reportsDir, '001-acme-2026-01-15.md'), [
      '# Evaluation: Acme — Senior Widget Engineer',
      '',
      '**Date:** 2026-01-15',
      '**URL:** https://example.com/jobs/acme-widget-engineer',
      '**Score:** 4.2/5',
      '',
      '## Machine Summary',
      'score: 4.2',
    ].join('\n'));

    writeFileSync(join(reportsDir, '002-globex-2026-01-16.md'), [
      '# Evaluation: Globex — Instructional Designer',
      '',
      '**Date:** 2026-01-16',
      '**URL:** https://example.com/jobs/globex-id',
      '**Score:** 4.5/5',
      '',
      '## Job Description (archived verbatim)',
      '',
      'Globex Corporation is seeking an Instructional Designer to build learning',
      'experiences for our internal enablement platform. Requirements: 3+ years',
      'of L&D experience, familiarity with Articulate 360, strong stakeholder',
      'communication skills.',
      '',
      '## Machine Summary',
      'score: 4.5',
    ].join('\n'));

    writeFileSync(join(reportsDir, '003-initech-2026-01-17.md'), [
      '# Evaluation: Initech — EdTech Specialist',
      '',
      '**Date:** 2026-01-17',
      '**URL:** https://example.com/jobs/initech-edtech',
      '**Score:** 4.0/5',
      '',
      '## Machine Summary',
      'score: 4.0',
    ].join('\n'));
    writeFileSync(join(jdsDir, '003-2026-01-17_initech_edtech-specialist.pdf'), 'fake-pdf-bytes');

    writeFileSync(join(reportsDir, 'hand-named-report.md'), '# Evaluation: Weyland — Analyst\n\n**URL:** https://example.com\n');

    writeFileSync(join(reportsDir, '005-umbrella-2026-01-20.md'), [
      '# Evaluation: Umbrella Corp — Analyst',
      '',
      '**URL:** https://example.com/jobs/umbrella-analyst',
      '',
      '## Job Description (archived verbatim)',
      'See jds/005-umbrella-2026-01-20.md for the full archive (archive-posting.mjs --report=005).',
      '',
      '## Machine Summary',
      'score: 4.0',
    ].join('\n'));

    writeFileSync(join(reportsDir, '006-oscorp-2026-01-21.md'), [
      '# Evaluation: Oscorp — Analyst',
      '',
      '**URL:** https://example.com/jobs/oscorp-analyst',
      '',
      '## Job Description (archived verbatim)',
      'Posted: 2026-01-18',
      'See jds/006-oscorp-2026-01-21.md for the full archive (archive-posting.mjs --report=006).',
      '',
      '## Machine Summary',
      'score: 4.0',
    ].join('\n'));
    writeFileSync(join(jdsDir, '006-2026-01-21_oscorp_analyst.pdf'), 'fake-pdf-bytes');

    writeFileSync(join(reportsDir, '007-wayne-2026-01-22.md'), [
      '# Evaluation: Wayne Enterprises — Analyst',
      '',
      '**URL:** https://linkedin.com/jobs/view/wayne-analyst',
      '',
      '## Job Description (archived verbatim)',
      '',
      'Sign in to view this job · Join LinkedIn to see who you know at Wayne Enterprises.',
      '',
      '## Machine Summary',
      'score: 4.0',
    ].join('\n'));

    const result = checkJdArchive(reportsDir, jdsDir);

    check(result.reportsScanned === 7, `all 7 fixture reports scanned (got ${result.reportsScanned})`);

    const flaggedFiles = new Set(result.findings.map((f) => f.file));
    check(flaggedFiles.has('001-acme-2026-01-15.md'), 'report with neither archive form is flagged missing-jd-archive');
    check(!flaggedFiles.has('002-globex-2026-01-16.md'), 'report with an embedded archive section is not flagged');
    check(!flaggedFiles.has('003-initech-2026-01-17.md'), 'report with a matching jds/ capture (no embedded section) is not flagged');
    check(flaggedFiles.has('005-umbrella-2026-01-20.md'), 'a path-only pointer to a NONEXISTENT jds/ capture is flagged, not accepted on length alone');
    check(!flaggedFiles.has('006-oscorp-2026-01-21.md'), 'a path-only pointer to an EXISTING jds/ capture is not flagged — resolves via findCaptureForReport');
    check(flaggedFiles.has('007-wayne-2026-01-22.md'), 'a LinkedIn-style login-wall archive is flagged, not accepted on length alone (#3829)');
    check(flaggedFiles.has('hand-named-report.md'), 'report with a non-conforming filename and no archive section is flagged');

    const handNamedFinding = result.findings.find((f) => f.file === 'hand-named-report.md');
    check(handNamedFinding?.report === null, 'non-conforming filename finding carries report: null instead of guessing');

    const loginWallFinding = result.findings.find((f) => f.file === '007-wayne-2026-01-22.md');
    check(loginWallFinding?.detail?.includes('sign-in/login wall'),
      'the login-wall finding names the specific reason in its detail, not a generic miss (#3829)');

    check(result.findings.every((f) => f.type === 'missing-jd-archive'), 'every finding uses the missing-jd-archive type');
    check(hasMissingArchive(result.findings) === true, 'hasMissingArchive is true when findings are present');

    const mismatchReportsDir = join(tmpDir, 'reports-mismatch');
    const mismatchJdsDir = join(tmpDir, 'jds-mismatch');
    mkdirSync(mismatchReportsDir, { recursive: true });
    mkdirSync(mismatchJdsDir, { recursive: true });
    writeFileSync(join(mismatchReportsDir, '005-umbrella-2026-01-20.md'), '# Evaluation: Umbrella — Analyst\n\n**URL:** https://example.com\n');
    writeFileSync(join(mismatchJdsDir, '005-2026-01-20_othercorp_analyst.pdf'), 'fake-pdf-bytes');
    const mismatchResult = checkJdArchive(mismatchReportsDir, mismatchJdsDir);
    check(mismatchResult.findings.some((f) => f.file === '005-umbrella-2026-01-20.md'),
      'a jds/ capture for the same report number but a different company is not credited (company-slug guard)');

    const emptyReportsDir = join(tmpDir, 'reports-empty');
    mkdirSync(emptyReportsDir, { recursive: true });
    const emptyResult = checkJdArchive(emptyReportsDir, jdsDir);
    check(emptyResult.reportsScanned === 0 && emptyResult.findings.length === 0 && !hasMissingArchive(emptyResult.findings),
      'no report files -> empty result, exit 0 (the designed empty-repo case, matches a fresh checkout with reports/*.md gitignored)');

    const neverCreatedResult = checkJdArchive(join(tmpDir, 'does-not-exist'), jdsDir);
    check(neverCreatedResult.reportsScanned === 0 && neverCreatedResult.findings.length === 0,
      'missing reports directory -> empty result, no crash');

    const noJdsDirResult = checkJdArchive(reportsDir, join(tmpDir, 'jds-does-not-exist'));
    check(noJdsDirResult.findings.some((f) => f.file === '001-acme-2026-01-15.md'),
      'missing jds/ directory does not crash the lookup — falls through to flagged');

    const trackerReportsDir = join(tmpDir, 'reports-tracker');
    mkdirSync(trackerReportsDir, { recursive: true });
    writeFileSync(join(trackerReportsDir, '101-acme-2026-01-01.md'), '# Evaluation: Acme — Analyst\n\n**URL:** https://example.com\n');
    writeFileSync(join(trackerReportsDir, '102-globex-2026-01-02.md'), '# Evaluation: Globex — Analyst\n\n**URL:** https://example.com\n');
    writeFileSync(join(trackerReportsDir, '103-initech-2026-01-03.md'), '# Evaluation: Initech — Analyst\n\n**URL:** https://example.com\n');
    writeFileSync(join(trackerReportsDir, '104-umbrella-2026-01-04.md'), '# Evaluation: Umbrella — Analyst\n\n**URL:** https://example.com\n');

    const trackerPath = join(tmpDir, 'applications.md');
    writeFileSync(trackerPath, [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-01-01 | Acme | Analyst | 4.0/5 | Rejected | ✅ | [101](reports/101-acme-2026-01-01.md) | |',
      '| 2 | 2026-01-02 | Globex | Analyst | 4.0/5 | Applied | ✅ | [102](reports/102-globex-2026-01-02.md) | |',
      '| 3 | 2026-01-04 | Umbrella | Analyst A | 4.0/5 | Applied | ✅ | [104](reports/104-umbrella-2026-01-04.md) | |',
      '| 4 | 2026-01-04 | Umbrella | Analyst B | 3.5/5 | Interview | ✅ | [104](reports/104-umbrella-2026-01-04.md) | |',
    ].join('\n'));

    const trackerResult = checkJdArchive(trackerReportsDir, jdsDir, { trackerPath });
    const findingTypeByFile = new Map(trackerResult.findings.map((f) => [f.file, f.type]));

    check(!findingTypeByFile.has('101-acme-2026-01-01.md'),
      'terminal-state (Rejected) tracker row -> report missing its archive gets NO finding at all, not even a warning');
    check(findingTypeByFile.get('102-globex-2026-01-02.md') === 'jd-archive-review-due',
      'live-state (Applied) tracker row -> report missing its archive gets a soft jd-archive-review-due finding, not a hard blocker');
    check(findingTypeByFile.get('103-initech-2026-01-03.md') === 'jd-archive-review-due',
      'report number with NO linking tracker row -> unresolved join fails soft to the same review-due warning, not an error');
    check(findingTypeByFile.get('104-umbrella-2026-01-04.md') === 'jd-archive-review-due',
      'report number linked by 2+ tracker rows (ambiguous) -> fails soft to review-due rather than guessing which row is authoritative');
    check(!hasMissingArchive(trackerResult.findings),
      'a tracker-joined run touching only terminal/live/unresolved rows never trips the hard-blocking hasMissingArchive/exit-1 path');

    const linkReportsDir = join(tmpDir, 'reports-capturelink');
    const linkJdsDir = join(tmpDir, 'jds-capturelink');
    mkdirSync(linkReportsDir, { recursive: true });
    mkdirSync(linkJdsDir, { recursive: true });
    writeFileSync(join(linkReportsDir, '201-cyberdyne-2026-02-01.md'), '# Evaluation: Cyberdyne — Analyst\n\n**URL:** https://example.com\n');
    writeFileSync(join(linkJdsDir, 'freely-named-agency-posting-2026-02-01.md'), 'Posted: 2026-02-01\n\n' + 'A'.repeat(200));
    writeFileSync(join(linkReportsDir, '202-tyrell-2026-02-02.md'), '# Evaluation: Tyrell — Analyst\n\n**URL:** https://example.com\n');

    const linkTracker = join(tmpDir, 'applications-capturelink.md');
    writeFileSync(linkTracker, [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 201 | 2026-02-01 | Cyberdyne | Analyst | 4.0/5 | Applied | ✅ | [201](reports/201-cyberdyne-2026-02-01.md) | see jds/freely-named-agency-posting-2026-02-01.md |',
      '| 202 | 2026-02-02 | Tyrell | Analyst | 4.0/5 | Applied | ✅ | [202](reports/202-tyrell-2026-02-02.md) | see jds/does-not-exist.md |',
      '| 203 | 2026-02-03 | Wonka | Analyst | N/A | Interview | ❌ | [203](jds/freely-named-agency-posting-2026-02-01.md) | |',
      '| 204 | 2026-02-04 | Soylent | Analyst | N/A | Applied | ❌ | — | |',
      '| 205 | 2026-02-05 | Initrode | Analyst | 2.0/5 | SKIP | ❌ | — | |',
    ].join('\n'));

    const linkMap = mapTrackerCaptureLinks(linkTracker, linkJdsDir);
    check(linkMap.has(201), 'mapTrackerCaptureLinks resolves a freely-named capture via the tracker row that links it');
    check(!linkMap.has(202), 'mapTrackerCaptureLinks refuses a dangling jds/ link — a missing file is not an archive');
    check(linkMap.has(203), "mapTrackerCaptureLinks keys by the row's own id when the Report cell links a capture instead of a report");

    const linkResult = checkJdArchive(linkReportsDir, linkJdsDir, { trackerPath: linkTracker });
    const linkTypes = new Map(linkResult.findings.map((f) => [f.file, f.type]));
    check(!linkTypes.has('201-cyberdyne-2026-02-01.md'),
      'a report whose tracker row names an existing jds/ capture is NOT flagged, even though the filename cannot resolve it');
    check(linkTypes.get('202-tyrell-2026-02-02.md') === 'jd-archive-review-due',
      'a report whose tracker row names a MISSING capture is still flagged — the link is not taken on faith');

    const unarchived = findUnarchivedApplications(linkTracker, linkReportsDir, linkJdsDir);
    const unarchivedRows = new Set(unarchived.map((r) => String(r.row)));
    check(unarchivedRows.has('204'), 'findUnarchivedApplications reports an applied-to row with no report and no capture');
    check(!unarchivedRows.has('203'), 'findUnarchivedApplications does not report a row whose Report cell links an existing capture');
    check(!unarchivedRows.has('201'), 'findUnarchivedApplications does not report a row that has a report file');
    check(!unarchivedRows.has('205'), 'findUnarchivedApplications ignores never-applied states (SKIP) — only sent applications count');
    check(unarchived.every((r) => r.type === 'application-no-archive'), 'every un-archived-application row carries the application-no-archive type');
    check(findUnarchivedApplications(null, linkReportsDir, linkJdsDir).length === 0,
      'findUnarchivedApplications fails soft to an empty list when no tracker is available');

    const noTrackerResult = checkJdArchive(trackerReportsDir, jdsDir);
    check(noTrackerResult.findings.filter((f) => f.type === 'missing-jd-archive').length === 4,
      'without a tracker to join against, all 4 fixtures stay the legacy hard missing-jd-archive finding (going-forward/fresh-install enforcement unaffected)');
    check(hasMissingArchive(noTrackerResult.findings) === true,
      'no-tracker run still trips hasMissingArchive (exit 1) — retroactive softening never applies without a resolvable tracker');

    const explicitNoTrackerResult = checkJdArchive(trackerReportsDir, jdsDir, { trackerPath: null });
    check(hasMissingArchive(explicitNoTrackerResult.findings) === true,
      'passing trackerPath: null explicitly reproduces the --no-tracker CLI path (hard enforcement)');

    check(classifyReportsByTrackerState(join(tmpDir, 'does-not-exist.md'), STATES_FILE) === null,
      'classifyReportsByTrackerState returns null (the fall-back-to-hard signal) when the tracker file does not exist');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n  check-jd-archive self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  if (selfTestMode) {
    runSelfTest();
  }

  const reportsDir = reportsDirArg || DEFAULT_REPORTS_DIR;
  const jdsDir = jdsDirArg || DEFAULT_JDS_DIR;
  const trackerPath = noTrackerMode ? null : (trackerArg || DEFAULT_TRACKER_PATH);

  const result = checkJdArchive(reportsDir, jdsDir, { trackerPath });
  const unarchivedApplications = findUnarchivedApplications(trackerPath, reportsDir, jdsDir);

  if (summaryMode) {
    printSummary(result);
    printUnarchivedApplications(unarchivedApplications);
  } else {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      reportsScanned: result.reportsScanned,
      findings: result.findings,
      warnings: result.warnings,
      unarchivedApplications,
    }, null, 2));
  }

  process.exit(hasMissingArchive(result.findings) ? 1 : 0);
}
