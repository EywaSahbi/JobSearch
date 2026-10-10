#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { parseTrackerRow, resolveColumns, extractTrackerReportNumbers } from './tracker-parse.mjs';
import { OUTCOME_MAP } from './lib/outcome-types.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import {
  normalizeCompany,
  pathIsInsideCanonical,
  resolvePdfIndexPath,
  resolveTrackerPath,
  resolveWorkspaceRoot,
} from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { resolveOutcomeDir } from './lib/outcome-dir.mjs';
import { parsePdfIndex } from './find.mjs';
import { findCaptureForReport } from './jd-capture.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const NODE = process.execPath;
const SET_STATUS_SCRIPT = join(CODE_ROOT, 'set-status.mjs');
const ARCHIVE_POSTING_SCRIPT = join(CODE_ROOT, 'archive-posting.mjs');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_AMBIGUOUS = 3;

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function today() {
  return localToday();
}


const USAGE = `Usage: node outcome.mjs <report#|company> <outcome_type> [options]

  <report#|company>  Tracker selector (# or company name)
  <outcome_type>     interview_progress | offer_received | hired | offer_declined | rejected | no_response | interview_only
  --stage "..."      Stage reached (e.g. "Tech Screen", "Final Round")
  --feedback "..."   Verbatim candidate/recruiter feedback
  --note "..."       Custom note to append to tracker
  --role "..."       Disambiguate company match
  --cv "..."         Path to submitted CV (defaults to cv.md)
  --cover "..."      Path to submitted cover letter
  --url "..."        Job posting URL (overrides auto-detection from tracker notes)
  --clean-output     Remove the tailored PDF/HTML from output/ once archived to data/outcomes/
  --dry-run          Preview outcome logging without writing
  --json             Machine-readable JSON output`;

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = {
  stage: null,
  feedback: null,
  note: null,
  role: null,
  cv: null,
  cover: null,
  url: null,
  cleanOutput: false,
  dryRun: false,
  json: rawArgs.includes('--json'),
};

function failExit(msg, code, exitCode) {
  if (flags.json) {
    console.log(JSON.stringify({ error: msg, code }));
  } else {
    console.error(`❌ ${msg}`);
  }
  process.exit(exitCode);
}

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (['--stage', '--feedback', '--note', '--role', '--cv', '--cover', '--url'].includes(a)) {
    const val = rawArgs[i + 1];
    if (val === undefined || val.startsWith('--')) {
      failExit(`Missing value for ${a}`, 'usage', EXIT_USAGE);
    }
    const key = a.slice(2);
    flags[key] = val;
    i++;
  } else if (a === '--clean-output') {
    flags.cleanOutput = true;
  } else if (a === '--dry-run') {
    flags.dryRun = true;
  } else if (a === '--json') {
    flags.json = true;
  } else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(EXIT_OK);
  } else if (a.startsWith('--')) {
    failExit(`Unknown flag: ${a}`, 'usage', EXIT_USAGE);
  } else {
    positional.push(a);
  }
}

if (positional.length < 2) {
  failExit(`Expected 2 positional arguments: <selector> <outcome_type>\n\n${USAGE}`, 'usage', EXIT_USAGE);
}

const [selector, rawOutcomeType] = positional;
const normalizedOutcomeKey = rawOutcomeType.toLowerCase().replace(/-/g, '_');
const outcomeConfig = OUTCOME_MAP[normalizedOutcomeKey];

if (!outcomeConfig) {
  const validTypes = Object.keys(OUTCOME_MAP).join(' · ');
  failExit(`Invalid outcome_type "${rawOutcomeType}". Valid types: ${validTypes}`, 'invalid-outcome', EXIT_USAGE);
}

const appsFile = resolveTrackerPath(DATA_ROOT);
if (!existsSync(appsFile)) {
  failExit(`Tracker not found at ${appsFile}`, 'tracker-not-found', EXIT_NOT_FOUND);
}

const content = readFileSync(appsFile, 'utf-8');
const lines = content.split('\n');
const colmap = resolveColumns(lines);
const rows = [];

for (let i = 0; i < lines.length; i++) {
  const r = parseTrackerRow(lines[i], colmap);
  if (r) rows.push(r);
}

if (rows.length === 0) {
  failExit(`Tracker at ${appsFile} is empty`, 'tracker-empty', EXIT_NOT_FOUND);
}

let matchedRow = null;
let candidates = [];

if (/^\d+$/.test(selector)) {
  const num = parseInt(selector, 10);
  candidates = rows.filter(r => r.num === num);
  if (candidates.length === 0) {
    failExit(`No tracker row with #${num}`, 'row-not-found', EXIT_NOT_FOUND);
  }
} else {
  const key = normalizeCompany(selector);
  candidates = rows.filter(r => normalizeCompany(r.company) === key);
  if (candidates.length === 0) {
    candidates = rows.filter(r => normalizeCompany(r.company).includes(key) || key.includes(normalizeCompany(r.company)));
  }
  if (candidates.length === 0) {
    failExit(`No tracker row for company matching "${selector}"`, 'company-not-found', EXIT_NOT_FOUND);
  }
}

if (candidates.length > 1 && flags.role) {
  const narrowed = candidates.filter(r => roleFuzzyMatch(r.role, flags.role));
  if (narrowed.length === 1) {
    candidates = narrowed;
  }
}

if (candidates.length > 1) {
  const listMsg = candidates.map(c => `#${c.num}: ${c.company} (${c.role})`).join(', ');
  failExit(`Multiple tracker rows matched "${selector}" (${listMsg}) — pass --role or row #`, 'ambiguous-match', EXIT_AMBIGUOUS);
}

matchedRow = candidates[0];

const companySlug = slugify(matchedRow.company);
const roleSlug = slugify(matchedRow.role);
const repoRoot = resolveWorkspaceRoot(appsFile);
const outcomesRoot = join(repoRoot, 'data', 'outcomes');
const { name: outcomeDirName, existing: existingOutcomeDirs } =
  resolveOutcomeDir(outcomesRoot, matchedRow.num, `${matchedRow.num}_${companySlug}_${roleSlug}`);
const outcomeDir = join(outcomesRoot, outcomeDirName);
if (existingOutcomeDirs.length > 1) {
  console.error(
    `⚠ #${matchedRow.num} has ${existingOutcomeDirs.length} outcome directories, so its journal is split: ` +
    `${existingOutcomeDirs.join(', ')}. Appending to ${outcomeDirName} (most recently written). ` +
    'Merge the entries into one directory to get a single history.',
  );
}

const noteToAppend = flags.note || (flags.stage ? `${outcomeConfig.defaultNote}: ${flags.stage}` : outcomeConfig.defaultNote);

let cvResolvedPath = null;
let isPdf = false;

if (flags.cv) {
  cvResolvedPath = flags.cv;
  isPdf = flags.cv.toLowerCase().endsWith('.pdf');
} else {
  if (matchedRow.pdf && matchedRow.pdf !== '—' && matchedRow.pdf !== '-') {
    const rawPdfPath = matchedRow.pdf.replace(/^local:/, '');
    const fullPdfPath = join(repoRoot, rawPdfPath);
    if (existsSync(fullPdfPath)) {
      cvResolvedPath = fullPdfPath;
      isPdf = true;
    }
  }

  if (!cvResolvedPath) {
    const manifestPath = resolvePdfIndexPath(appsFile);
    if (existsSync(manifestPath)) {
      try {
        const manifestText = readFileSync(manifestPath, 'utf-8');
        const pdfMap = parsePdfIndex(manifestText);
        const reportNums = extractTrackerReportNumbers(matchedRow.report);
        for (const num of reportNums) {
          const mappedPdf = pdfMap.get(String(num).padStart(3, '0')) || pdfMap.get(String(num));
          if (mappedPdf) {
            const fullPdfPath = join(repoRoot, mappedPdf.replace(/^local:/, ''));
            if (existsSync(fullPdfPath)) {
              cvResolvedPath = fullPdfPath;
              isPdf = true;
              break;
            }
          }
        }
      } catch (err) {
      }
    }
  }
}

let cvFromOutputDir = false;
let htmlResolvedPath = null;
const outputDir = resolve(repoRoot, 'output');
const resolvedCvAbs = cvResolvedPath ? resolve(cvResolvedPath) : null;
if (isPdf && resolvedCvAbs && pathIsInsideCanonical(resolvedCvAbs, outputDir)) {
  cvFromOutputDir = true;
  const manifestPath = resolvePdfIndexPath(appsFile);
  if (existsSync(manifestPath)) {
    try {
      const manifestText = readFileSync(manifestPath, 'utf-8');
      for (const line of manifestText.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const fields = line.split('\t');
        if (!fields[1]) continue;
        const rowPdfPath = resolve(join(repoRoot, fields[1].replace(/^local:/, '')));
        if (rowPdfPath === resolvedCvAbs && fields[2]) {
          const htmlFull = join(repoRoot, fields[2].replace(/^local:/, ''));
          if (existsSync(htmlFull) && pathIsInsideCanonical(htmlFull, outputDir)) {
            htmlResolvedPath = htmlFull;
          }
          break;
        }
      }
    } catch (err) {
    }
  }
}

if (flags.dryRun) {
  const cleanupCandidates = flags.cleanOutput
    ? [cvFromOutputDir ? cvResolvedPath : null, htmlResolvedPath].filter(Boolean)
    : [];
  const dryRunResult = {
    dryRun: true,
    num: matchedRow.num,
    company: matchedRow.company,
    role: matchedRow.role,
    outcomeType: normalizedOutcomeKey,
    canonicalState: outcomeConfig.state,
    stage: flags.stage,
    feedback: flags.feedback,
    note: noteToAppend,
    outcomeDir,
    cleanOutput: flags.cleanOutput,
    cleanupCandidates,
  };
  if (flags.json) {
    console.log(JSON.stringify(dryRunResult, null, 2));
  } else {
    console.log(`🔍 Dry-run: would record outcome "${normalizedOutcomeKey}" for #${matchedRow.num} ${matchedRow.company} (${outcomeConfig.state}) in ${outcomeDir}`);
    if (flags.cleanOutput) {
      if (cleanupCandidates.length) {
        console.log(`🔍 Dry-run: would archive then remove from output/ (after verifying the archive):`);
        for (const p of cleanupCandidates) console.log(`   - ${p}`);
      } else {
        console.log(`🔍 Dry-run: --clean-output requested but no matching output/ PDF/HTML found for this row`);
      }
    }
  }
  process.exit(EXIT_OK);
}

mkdirSync(outcomeDir, { recursive: true });

let archivedCvPdfPath = null;
let archivedCvHtmlPath = null;
if (cvResolvedPath && existsSync(cvResolvedPath)) {
  const destName = isPdf ? 'submitted_cv.pdf' : 'submitted_cv.md';
  const cvDestPath = join(outcomeDir, destName);
  if (!existsSync(cvDestPath)) {
    copyFileSync(cvResolvedPath, cvDestPath);
  }
  if (isPdf) archivedCvPdfPath = cvDestPath;
} else {
  const masterCv = resolve(repoRoot, 'cv.md');
  const cvDestPath = join(outcomeDir, 'submitted_cv.md');
  if (!existsSync(cvDestPath)) {
    if (existsSync(masterCv)) {
      copyFileSync(masterCv, cvDestPath);
    } else {
      writeFileSync(cvDestPath, `# Submitted CV — #${matchedRow.num} ${matchedRow.company}\n\nNo CV source file found at ${masterCv} on ${today()}.\n`);
    }
  }
}

if (flags.cleanOutput && htmlResolvedPath && existsSync(htmlResolvedPath)) {
  const htmlDestPath = join(outcomeDir, 'submitted_cv.html');
  if (!existsSync(htmlDestPath)) {
    copyFileSync(htmlResolvedPath, htmlDestPath);
  }
  archivedCvHtmlPath = htmlDestPath;
}

if (flags.cover && existsSync(flags.cover)) {
  const coverDestPath = join(outcomeDir, 'submitted_cover_letter.md');
  if (!existsSync(coverDestPath)) {
    copyFileSync(flags.cover, coverDestPath);
  }
}

let postingArchived = false;
let resolvedPostingPath = null;
const targetUrl = flags.url || (matchedRow.notes && matchedRow.notes.match(/https?:\/\/[^\s|)]+/)?.[0]);

const notesLink = matchedRow.notes && matchedRow.notes.match(/local:(jds\/[^\s|)]+)/)?.[1];
if (notesLink) {
  const fullPath = resolve(repoRoot, notesLink);
  if (existsSync(fullPath)) {
    resolvedPostingPath = fullPath;
    postingArchived = true;
  }
}

if (!resolvedPostingPath) {
  const found = findCaptureForReport(resolve(repoRoot, 'jds'), matchedRow.num, {
    companySlug: slugify(matchedRow.company),
  });
  if (found) {
    resolvedPostingPath = found.path;
    postingArchived = true;
  }
}

if (!resolvedPostingPath && targetUrl) {
  try {
    execFileSync(NODE, [ARCHIVE_POSTING_SCRIPT, targetUrl, `--company=${matchedRow.company}`, `--role=${matchedRow.role}`, `--report=${matchedRow.num}`], {
      cwd: CODE_ROOT,
      env: process.env,
      stdio: 'ignore',
      timeout: 45000,
    });
    const found = findCaptureForReport(resolve(repoRoot, 'jds'), matchedRow.num, {
      companySlug: slugify(matchedRow.company),
    });
    if (found) {
      resolvedPostingPath = found.path;
      postingArchived = true;
    }
  } catch {
    postingArchived = false;
  }
}

if (postingArchived && resolvedPostingPath) {
  const postingDest = join(outcomeDir, `posting${extname(resolvedPostingPath) || '.pdf'}`);
  if (!existsSync(postingDest)) {
    copyFileSync(resolvedPostingPath, postingDest);
  }
} else {
  const stubContent = `# Job Posting Snapshot — Unavailable

- **Date**: ${today()}
- **Company**: ${matchedRow.company}
- **Role**: ${matchedRow.role}
- **Tracker #**: #${matchedRow.num}
- **URL**: ${targetUrl || 'None provided'}
- **Reason**: Live posting URL could not be reached or archived.
`;
  const stubDest = join(outcomeDir, 'posting_missing.md');
  if (!existsSync(stubDest)) {
    writeFileSync(stubDest, stubContent);
  }
}

const outcomeLogPath = join(outcomeDir, 'outcome.md');
const entryHeader = `## Entry: ${today()}`;
const newEntry = `${entryHeader}
- **Outcome Type**: ${normalizedOutcomeKey}
- **Canonical State**: ${outcomeConfig.state}
- **Stage Reached**: ${flags.stage || 'N/A'}
- **Verbatim Feedback**:
> ${flags.feedback ? flags.feedback.replace(/\r?\n/g, '\n> ') : 'None recorded'}
- **Notes**: ${noteToAppend}
`;

if (existsSync(outcomeLogPath)) {
  const existingLog = readFileSync(outcomeLogPath, 'utf-8');
  if (!existingLog.includes(newEntry.trim())) {
    writeFileSync(outcomeLogPath, existingLog.endsWith('\n') ? existingLog + '\n' + newEntry : existingLog + '\n\n' + newEntry);
  }
} else {
  const initialLog = `# Application Outcome Log — ${matchedRow.company} — ${matchedRow.role} (#${matchedRow.num})

${newEntry}`;
  writeFileSync(outcomeLogPath, initialLog);
}

const setStatusArgs = [
  SET_STATUS_SCRIPT,
  String(matchedRow.num),
  outcomeConfig.state,
  '--note', noteToAppend,
  '--force',
  '--json',
];

if (matchedRow.role) {
  setStatusArgs.push('--role', matchedRow.role);
}

let setStatusResult = null;
try {
  const statusOutput = execFileSync(NODE, setStatusArgs, { cwd: CODE_ROOT, env: process.env, encoding: 'utf-8' });
  setStatusResult = JSON.parse(statusOutput);
} catch (err) {
  failExit(`Tracker update via set-status.mjs failed: ${err.message}`, 'tracker-update-failed', 1);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function archivedCopyVerified(srcPath, destPath) {
  if (!srcPath || !destPath || !existsSync(srcPath) || !existsSync(destPath)) return false;
  return sha256(srcPath) === sha256(destPath);
}

const cleanup = { requested: flags.cleanOutput, removed: [], refused: [] };
if (flags.cleanOutput) {
  const cleanupTargets = [
    [cvFromOutputDir ? cvResolvedPath : null, archivedCvPdfPath],
    [htmlResolvedPath, archivedCvHtmlPath],
  ];
  for (const [srcPath, destPath] of cleanupTargets) {
    if (!srcPath) continue;
    if (!archivedCopyVerified(srcPath, destPath)) {
      cleanup.refused.push({ path: srcPath, reason: 'archived copy in data/outcomes/ missing or does not match (sha256)' });
      continue;
    }
    try {
      rmSync(srcPath);
      cleanup.removed.push(srcPath);
    } catch (err) {
      cleanup.refused.push({ path: srcPath, reason: err.message });
    }
  }
}

const result = {
  success: true,
  num: matchedRow.num,
  company: matchedRow.company,
  role: matchedRow.role,
  outcomeType: normalizedOutcomeKey,
  canonicalState: outcomeConfig.state,
  stage: flags.stage,
  feedback: flags.feedback,
  note: noteToAppend,
  outcomeDir,
  postingArchived,
  setStatusResult,
  cleanup,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`✅ Recorded outcome "${normalizedOutcomeKey}" for #${matchedRow.num} ${matchedRow.company} (${outcomeConfig.state}) in ${outcomeDir}`);
  if (flags.cleanOutput) {
    for (const p of cleanup.removed) console.log(`🗑️  Removed from output/ (archived copy verified): ${p}`);
    for (const r of cleanup.refused) console.log(`⚠️  Left in output/ (${r.reason}): ${r.path}`);
    if (!cleanup.removed.length && !cleanup.refused.length) {
      console.log(`ℹ️  --clean-output requested but no matching output/ PDF/HTML found for this row`);
    }
  }
}

process.exit(EXIT_OK);
