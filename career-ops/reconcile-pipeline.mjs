#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, copyFileSync, realpathSync, statSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { normalizeReportLink } from './tracker-links.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { withPipelineLock, LockTimeoutError } from './pipeline-lock.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const CAREER_OPS = getCareerOpsRoot();

const KNOWN_FLAGS = ['--dry-run', '--pipeline', '--state', '--help', '-h'];
const VALUE_FLAGS = ['--pipeline', '--state'];
const USAGE = `Usage: node reconcile-pipeline.mjs [--dry-run] [--state <path>] [--pipeline <path>]
  Moves batch-processed offers out of pipeline.md "Pendientes" into "Procesadas".`;

const args = process.argv.slice(2);
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

const DRY_RUN = args.includes('--dry-run');

function resolveInsideRepo(inputPath, fallbackPath, flag) {
  const abs = resolve(inputPath || fallbackPath);
  let repoReal, targetReal;
  try {
    repoReal = realpathSync(CAREER_OPS);
    targetReal = existsSync(abs) ? realpathSync(abs) : realpathSync(dirname(abs));
  } catch {
    console.error(`Invalid ${flag}: cannot resolve path (${abs})`);
    process.exit(1);
  }
  const rel = relative(repoReal, targetReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`Invalid ${flag}: path must stay inside the repository (${abs})`);
    process.exit(1);
  }
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    console.error(`Invalid ${flag}: expected a file, not a directory (${abs})`);
    process.exit(1);
  }
  return abs;
}

const defaultPipeline = existsSync(join(CAREER_OPS, 'data/pipeline.md'))
  ? join(CAREER_OPS, 'data/pipeline.md')
  : join(CAREER_OPS, 'pipeline.md');
const PIPELINE_FILE = resolveInsideRepo(flagValue(args, '--pipeline'), defaultPipeline, '--pipeline');
const STATE_FILE = resolveInsideRepo(flagValue(args, '--state'), join(CAREER_OPS, 'batch/batch-state.tsv'), '--state');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

if (!existsSync(STATE_FILE)) {
  console.log('No batch-state.tsv found — nothing to reconcile.');
  process.exit(0);
}
if (!existsSync(PIPELINE_FILE)) {
  console.log('No pipeline.md found — nothing to reconcile.');
  process.exit(0);
}

const DONE = new Map();
for (const line of readFileSync(STATE_FILE, 'utf-8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('id\t')) continue;
  const c = line.split('\t');
  if (c.length < 7) continue;
  const [, url, status, , , reportNum, score] = c;
  if (status !== 'completed' && status !== 'skipped') continue;
  if (!url || !url.trim()) continue;
  DONE.set(url.trim(), { reportNum: (reportNum || '').trim(), score: (score || '').trim() });
}

if (DONE.size === 0) {
  console.log('No completed batch entries in batch-state.tsv — nothing to reconcile.');
  process.exit(0);
}

let reportFiles = [];
try { reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')); } catch { }

function findReportFile(reportNum) {
  if (!reportNum || reportNum === '-') return null;
  const n = parseInt(reportNum, 10);
  if (Number.isNaN(n)) return null;
  return reportFiles.find(f => {
    const m = f.match(/^(\d+)-/);
    return m && parseInt(m[1], 10) === n;
  }) || null;
}

function readReportField(reportFile, field) {
  if (!reportFile) return null;
  try {
    const txt = readFileSync(join(REPORTS_DIR, reportFile), 'utf-8');
    const m = txt.match(new RegExp(`^\\*\\*${field}:\\*\\*([^\\r\\n]*)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function formatScore(value) {
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 5 ? `${value}/5` : null;
}

function resolveScore(stateScore, reportFile) {
  const state = formatScore(stateScore);
  if (state) return state;
  const rep = readReportField(reportFile, 'Score');
  if (rep) {
    const score = rep.match(/^[*_`]*(\d+(?:\.\d+)?)(?=$|[\s*_`/,(—–-])/);
    if (!score) return 'N/A';
    const denominator = rep.match(/\/[ \t]*(\d+(?:\.\d+)?)/);
    if (denominator) {
      const tail = rep.slice(denominator.index + denominator[0].length);
      if (Number(denominator[1]) !== 5 || (tail && !/^[\s*_`,;:.()\]—–-]/.test(tail))) return 'N/A';
    } else if (/^[*_`]*[ \t]*\//.test(rep.slice(score[0].length))) {
      return 'N/A';
    }
    return formatScore(score[1]) || 'N/A';
  }
  return 'N/A';
}

function resolvePdf(reportFile) {
  const rep = readReportField(reportFile, 'PDF');
  if (!rep) return '❌';
  return /not generated/i.test(rep) ? '❌' : '✅';
}

const PENDING_RE = /^##\s+(Pendientes|Pending)\s*$/i;
const PROCESSED_RE = /^##\s+(Procesadas|Processed)\s*$/i;
const SECTION_RE = /^##\s+/;
const PENDING_ITEM_RE = /^- \[ \]\s+/;

function lineUrl(body) {
  const i = body.indexOf(' |');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

function reconcile() {
  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/);

  let pendStart = -1, procStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (pendStart < 0 && PENDING_RE.test(lines[i])) pendStart = i;
    else if (procStart < 0 && PROCESSED_RE.test(lines[i])) procStart = i;
  }

  if (pendStart < 0) {
    console.log('No "Pendientes" section in pipeline.md — nothing to reconcile.');
    return;
  }

  function sectionEnd(start) {
    for (let i = start + 1; i < lines.length; i++) {
      if (SECTION_RE.test(lines[i])) return i;
    }
    return lines.length;
  }
  const pendEnd = sectionEnd(pendStart);
  const procEnd = procStart >= 0 ? sectionEnd(procStart) : -1;

  const procUrls = new Set();
  if (procStart >= 0) {
    for (let i = procStart + 1; i < procEnd; i++) {
      const m = lines[i].match(/^- \[x\]\s+(.+)$/i);
      if (!m) continue;
      const parts = m[1].split('|').map(s => s.trim());
      if (parts[1]) procUrls.add(parts[1]);
    }
  }

  const removeIdx = new Set();
  const movedProcLines = [];
  const moved = [];
  const skippedNoReport = [];

  for (let i = pendStart + 1; i < pendEnd; i++) {
    if (!PENDING_ITEM_RE.test(lines[i])) continue;
    const body = lines[i].replace(PENDING_ITEM_RE, '');
    const url = lineUrl(body);
    const done = DONE.get(url);
    if (!done) continue;

    if (procUrls.has(url)) {
      removeIdx.add(i);
      moved.push({ url, role: '(already in Procesadas)', dup: true });
      continue;
    }

    const reportFile = findReportFile(done.reportNum);
    if (!reportFile) {
      skippedNoReport.push({ url, reportNum: done.reportNum || '?' });
      continue;
    }

    const parts = body.split('|').map(s => s.trim());
    const company = parts[1] || '';
    const role = parts[2] || '';
    const score = resolveScore(done.score, reportFile);
    const pdf = resolvePdf(reportFile);
    const num = parseInt(done.reportNum, 10);

    const reportLink = normalizeReportLink(`[${num}](reports/${reportFile})`, dirname(PIPELINE_FILE), CAREER_OPS);
    movedProcLines.push(`- [x] ${reportLink} | ${url} | ${company} | ${role} | ${score} | PDF ${pdf}`);
    moved.push({ url, company, role, num, score });
    procUrls.add(url);
    removeIdx.add(i);
  }

  console.log('=== Reconcile pipeline.md ===');
  for (const s of skippedNoReport) {
    console.warn(`⚠️  ${s.url} — batch reports report #${s.reportNum} but no reports/${s.reportNum}-*.md found; left in Pendientes.`);
  }

  if (removeIdx.size === 0) {
    console.log('✅ pipeline.md already in sync — nothing to reconcile.');
    return;
  }

  const out = [];
  let skipBlankAfterProc = false;
  for (let i = 0; i < lines.length; i++) {
    if (removeIdx.has(i)) continue;
    if (skipBlankAfterProc) {
      skipBlankAfterProc = false;
      if (lines[i].trim() === '') continue;
    }
    out.push(lines[i]);
    if (i === procStart && movedProcLines.length > 0) {
      out.push('', ...movedProcLines);
      skipBlankAfterProc = true;
    }
  }
  if (procStart < 0 && movedProcLines.length > 0) {
    const processedHeader = /Pending/i.test(lines[pendStart]) ? '## Processed' : '## Procesadas';
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(processedHeader, '', ...movedProcLines);
  }

  const newContent = out.join('\n');

  const newCount = (() => {
    let n = 0, inPend = false;
    for (const l of out) {
      if (PENDING_RE.test(l)) { inPend = true; continue; }
      if (SECTION_RE.test(l)) { inPend = false; continue; }
      if (inPend && PENDING_ITEM_RE.test(l)) n++;
    }
    return n;
  })();

  const realMoves = moved.filter(m => !m.dup);
  console.log(`🔄 ${realMoves.length} processed entr${realMoves.length === 1 ? 'y' : 'ies'} moved Pendientes → Procesadas:`);
  for (const m of realMoves) console.log(`   + #${m.num} ${m.company} — ${m.role} (${m.score})`);
  const dups = moved.filter(m => m.dup);
  if (dups.length) console.log(`🧹 ${dups.length} stale Pendientes entr${dups.length === 1 ? 'y' : 'ies'} dropped (already in Procesadas).`);
  console.log(`📋 Pendientes now: ${newCount} entr${newCount === 1 ? 'y' : 'ies'}`);

  if (DRY_RUN) {
    console.log('(dry-run — no changes written)');
    return;
  }

  copyFileSync(PIPELINE_FILE, `${PIPELINE_FILE}.pre-reconcile.bak`);
  writeFileAtomic(PIPELINE_FILE, newContent);
  console.log(`✅ pipeline.md updated (backup: ${PIPELINE_FILE}.pre-reconcile.bak)`);
}

if (DRY_RUN) {
  reconcile();
} else {
  try {
    await withPipelineLock(PIPELINE_FILE, reconcile);
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    console.error(`❌ ${err.message} — another process is writing pipeline.md; nothing was changed. Re-run once it finishes.`);
    process.exit(1);
  }
}
