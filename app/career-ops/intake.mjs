#!/usr/bin/env node

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { isNestedCheckout } from './lib/mjs-files.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DOCS_DIR = process.env.CAREER_OPS_DOCUMENTS_DIR || join(DATA_ROOT, 'documents');
const STATE_FILE = process.env.CAREER_OPS_INTAKE_STATE || join(DATA_ROOT, 'data', 'intake-state.json');

export const INTAKE_FOLDERS = ['cv', 'linkedin', 'diplomas', 'references'];

const PDF_EXTRACTORS = [
  {
    name: 'pdftotext',
    probeArgs: ['-v'],
    extract: (path) => execFileSync(
      'pdftotext', ['-layout', path, '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    ).toString('utf-8'),
  },
];

const PDF_INSTALL_HINT =
  'No PDF text extractor found. Optional: install poppler for PDF intake '
  + '(brew install poppler / apt install poppler-utils) — .md/.txt/.tex '
  + 'sources work without it.';

export function classifySource(relPath) {
  const ext = extname(relPath).toLowerCase();
  if (['.md', '.txt', '.tex'].includes(ext)) return { kind: 'direct' };
  if (ext === '.pdf') return { kind: 'pdf' };
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff'].includes(ext)) {
    return { kind: 'unsupported', reason: 'image — convert to a text-layer PDF or .md/.txt first' };
  }
  if (['.docx', '.doc', '.odt', '.rtf'].includes(ext)) {
    return { kind: 'unsupported', reason: `${ext} — export to PDF or .md/.txt first` };
  }
  return { kind: 'unsupported', reason: `unrecognized extension ${ext || '(none)'}` };
}

export function detectPdfExtractor(probe = defaultProbe) {
  for (const candidate of PDF_EXTRACTORS) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

function defaultProbe(candidate) {
  try {
    execFileSync(candidate.name, candidate.probeArgs, { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch (err) {
    return probeRan(err);
  }
}

export function probeRan(err) {
  return typeof err?.status === 'number';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function computeDelta(state, sources) {
  const recorded = new Map(Object.entries(state.ingested || {}));
  return sources.map((s) => {
    if (!s.hash) return { ...s, status: s.status || 'error' };
    const prev = recorded.get(s.path);
    if (!prev) return { ...s, status: 'new' };
    if (prev.hash !== s.hash) return { ...s, status: 'changed' };
    return { ...s, status: 'ingested' };
  });
}

class StateError extends Error {
  constructor(message) { super(message); this.name = 'StateError'; }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { ingested: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    throw new StateError(
      `${STATE_FILE} is not valid JSON (${String(err.message).split('\n')[0]}) — `
      + 'fix or delete it; deleting means already-ingested documents are proposed again.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateError(`${STATE_FILE} does not contain a JSON object — fix or delete it.`);
  }
  if (parsed.ingested === undefined || parsed.ingested === null) parsed.ingested = {};
  else if (typeof parsed.ingested !== 'object' || Array.isArray(parsed.ingested)) {
    throw new StateError(`${STATE_FILE} has an "ingested" that is not an object — fix or delete it.`);
  }
  return parsed;
}

function listSourceFiles() {
  if (!existsSync(DOCS_DIR)) return { files: [], unreadable: [] };
  const out = [];
  const unreadable = new Set();
  const readDir = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.add(dir);
      return [];
    }
  };
  const walked = new Set();

  const realDirs = new Set();
  const claimRealDirs = (dir) => {
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (realDirs.has(real)) return;
    realDirs.add(real);
    for (const entry of readDir(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && !isNestedCheckout(join(dir, entry.name))) claimRealDirs(join(dir, entry.name));
    }
  };
  claimRealDirs(DOCS_DIR);

  const walk = (dir) => {
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (walked.has(real)) return;
    walked.add(real);
    const entries = readDir(dir)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'README.md' && dir === DOCS_DIR) continue;
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir) {
        if (entry.isSymbolicLink()) {
          let target;
          try { target = realpathSync(abs); } catch { continue; }
          if (realDirs.has(target)) continue;
        }
        if (isNestedCheckout(abs)) continue;
        walk(abs);
      } else if (isFile) out.push(abs);
    }
  };
  walk(DOCS_DIR);
  return { files: out.sort(), unreadable: [...unreadable].sort() };
}

function toRelPath(abs) {
  return relative(DOCS_DIR, abs).split(sep).join('/');
}

function extractAll() {
  const extractor = detectPdfExtractor();
  const { files, unreadable } = listSourceFiles();
  const sources = files.map((abs) => {
    const path = toRelPath(abs);
    const cls = classifySource(path);
    const base = { path, folder: path.includes('/') ? path.split('/')[0] : '(root)' };
    if (cls.kind === 'unsupported') {
      return { ...base, status: 'skipped', reason: cls.reason };
    }
    try {
      let text;
      if (cls.kind === 'direct') {
        text = readFileSync(abs, 'utf-8');
        base.extractor = 'direct';
      } else {
        if (!extractor) return { ...base, status: 'skipped', reason: PDF_INSTALL_HINT };
        text = extractor.extract(abs);
        base.extractor = extractor.name;
      }
      if (!text.trim()) {
        return {
          ...base,
          status: 'skipped',
          reason: 'no text extracted — likely a scanned/image-only PDF; convert or re-export with a text layer',
        };
      }
      return { ...base, chars: text.length, hash: sha256(text), preview: text.slice(0, 400) };
    } catch (err) {
      return { ...base, status: 'error', reason: String(err.message || err).split('\n')[0] };
    }
  });
  for (const dir of unreadable) {
    const path = dir === DOCS_DIR ? '(root)' : `${toRelPath(dir)}/`;
    sources.push({
      path,
      folder: path.includes('/') ? path.split('/')[0] : '(root)',
      status: 'skipped',
      reason: 'directory could not be listed (permissions?) — nothing under it was scanned',
    });
  }
  return {
    documentsDir: DOCS_DIR,
    pdfExtractor: extractor ? extractor.name : null,
    ...(extractor ? {} : { pdfHint: PDF_INSTALL_HINT }),
    sources: computeDelta(loadState(), sources),
  };
}

function ensureScaffold() {
  for (const folder of INTAKE_FOLDERS) mkdirSync(join(DOCS_DIR, folder), { recursive: true });
}

const COMMIT_ALL = Symbol('commit-all');

function commitState(result, only = []) {
  const all = only === COMMIT_ALL;
  const state = loadState();
  state.ingested = state.ingested || {};
  const now = new Date().toISOString();
  let count = 0;
  for (const s of result.sources) {
    if (!s.hash || s.status === 'ingested') continue;
    if (!all && !only.includes(s.path)) continue;
    state.ingested[s.path] = { hash: s.hash, ingestedAt: now };
    count += 1;
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  return count;
}

function printSummary(result) {
  console.log(`documents/: ${result.documentsDir}`);
  console.log(`PDF extractor: ${result.pdfExtractor || 'none — ' + PDF_INSTALL_HINT}`);
  if (!result.sources.length) {
    console.log('No sources found. Drop files into documents/cv, linkedin/, diplomas/, references/.');
    return;
  }
  const w = Math.max(...result.sources.map((s) => s.path.length), 6);
  console.log(`\n${'source'.padEnd(w)}  status    detail`);
  for (const s of result.sources) {
    const detail = s.status === 'skipped' || s.status === 'error'
      ? s.reason
      : `${s.chars} chars via ${s.extractor}`;
    console.log(`${s.path.padEnd(w)}  ${s.status.padEnd(8)}  ${detail}`);
  }
  const actionable = result.sources.filter((s) => s.status === 'new' || s.status === 'changed').length;
  console.log(`\n${actionable} source(s) with new material.`);
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const eq = (label, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
    failed += 1;
    console.log(`  FAIL: ${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
  };

  eq('md is direct', classifySource('cv/master.md'), { kind: 'direct' });
  eq('tex is direct', classifySource('cv/master.tex'), { kind: 'direct' });
  eq('pdf is pdf', classifySource('linkedin/Profile.PDF'), { kind: 'pdf' });
  eq('docx unsupported', classifySource('cv/old.docx').kind, 'unsupported');
  eq('image unsupported', classifySource('diplomas/scan.jpg').kind, 'unsupported');

  eq('ladder picks first probing rung',
    detectPdfExtractor(() => true)?.name, 'pdftotext');
  eq('ladder degrades to null', detectPdfExtractor(() => false), null);

  eq('exit 99 (Xpdf -v) counts as present', probeRan({ status: 99 }), true);
  eq('exit 1 counts as present', probeRan({ status: 1 }), true);
  eq('exit 0 counts as present', probeRan({ status: 0 }), true);
  eq('ENOENT counts as absent', probeRan({ code: 'ENOENT', status: null }), false);
  eq('EACCES counts as absent', probeRan({ code: 'EACCES', status: null }), false);
  eq('timeout counts as absent',
    probeRan({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }), false);
  eq('missing error object counts as absent', probeRan(undefined), false);

  const state = { ingested: { 'cv/master.md': { hash: sha256('old') } } };
  const delta = computeDelta(state, [
    { path: 'cv/master.md', hash: sha256('old') },
    { path: 'cv/master2.md', hash: sha256('x') },
    { path: 'linkedin/p.pdf', hash: sha256('new') },
    { path: 'diplomas/scan.jpg', status: 'skipped' },
  ]);
  eq('unchanged source is ingested', delta[0].status, 'ingested');
  eq('never-seen source is new', delta[1].status, 'new');
  eq('never-seen pdf is new', delta[2].status, 'new');
  eq('skipped source keeps its status', delta[3].status, 'skipped');
  const delta2 = computeDelta(state, [{ path: 'cv/master.md', hash: sha256('edited') }]);
  eq('re-extracted source with different text is changed', delta2[0].status, 'changed');

  console.log(`\nself-test: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = isMainModule(import.meta.url);

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) runSelfTest();

  ensureScaffold();
  const textIdx = args.indexOf('--text');
  if (textIdx !== -1) {
    const target = args[textIdx + 1];
    if (!target) { console.error('Usage: node intake.mjs --text <path relative to documents/>'); process.exit(1); }
    const abs = resolve(DOCS_DIR, target);
    if (!abs.startsWith(resolve(DOCS_DIR) + sep)) {
      console.error(`Path escapes documents/: ${target}`);
      process.exit(1);
    }
    if (!existsSync(abs)) { console.error(`Not found: ${target}`); process.exit(1); }
    const cls = classifySource(target);
    let text;
    try {
      if (cls.kind === 'direct') text = readFileSync(abs, 'utf-8');
      else if (cls.kind === 'pdf') {
        const extractor = detectPdfExtractor();
        if (!extractor) { console.error(PDF_INSTALL_HINT); process.exit(1); }
        text = extractor.extract(abs);
      } else { console.error(`Unsupported source: ${cls.reason}`); process.exit(1); }
    } catch (err) {
      console.error(`Could not read ${target}: ${String(err.message || err).split('\n')[0]}`);
      process.exit(1);
    }
    if (!text.trim()) {
      console.error('No text extracted — likely a scanned/image-only PDF; convert or re-export with a text layer.');
      process.exit(1);
    }
    process.stdout.write(text);
    return;
  }

  const result = extractAll();
  const commitIdx = args.indexOf('--commit');
  if (commitIdx !== -1) {
    const only = args.slice(commitIdx + 1).filter((a) => !a.startsWith('--'));
    const all = args.includes('--all');
    if (!all && only.length === 0) {
      console.error(
        'Nothing to commit. Pass the confirmed sources — node intake.mjs --commit <path> [<path> …] — '
        + 'or node intake.mjs --commit --all when every source with new material was merged. '
        + 'Nothing was recorded.',
      );
      process.exit(1);
    }
    const count = commitState(result, all ? COMMIT_ALL : only);
    console.log(`Recorded ${count} source(s) as ingested → ${STATE_FILE}`);
    return;
  }
  if (args.includes('--summary')) printSummary(result);
  else console.log(JSON.stringify(result, null, 2));
}

if (isMain) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof StateError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
