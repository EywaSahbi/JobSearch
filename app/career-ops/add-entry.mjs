#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeTextKey } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

const CV_FILE = process.env.CAREER_OPS_CV || join(CAREER_OPS, 'cv.md');
const ARTICLE_DIGEST_FILE = process.env.CAREER_OPS_ARTICLE_DIGEST || join(CAREER_OPS, 'article-digest.md');

const KNOWN_FLAGS = ['--dry-run', '--stdin', '--help', '-h'];

const USAGE = `Usage:
  node add-entry.mjs <payload.json> [--dry-run]
  node add-entry.mjs --stdin [--dry-run]
  node add-entry.mjs --help                    # print this usage block and exit (-h is an alias)`;

export function normalizeKey(s) {
  return typeof s === 'string' ? normalizeTextKey(s) : '';
}

export function locateSection(md, section) {
  const target = normalizeKey(section);
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*\S)\s*$/);
    if (m && normalizeKey(m[1]) === target) {
      let end = i + 1;
      while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
      return {
        before: lines.slice(0, i).join('\n'),
        heading: lines[i],
        body: lines.slice(i + 1, end).join('\n'),
        after: lines.slice(end).join('\n'),
      };
    }
  }
  return null;
}

export function extractIdentifiers(body) {
  const ids = [];
  for (const m of body.matchAll(/\*\*([^*]+)\*\*/g)) ids.push(m[1]);
  for (const m of body.matchAll(/^#{3,}\s+(.*\S)\s*$/gm)) ids.push(m[1]);
  return ids;
}

export function cvHasEntry(md, section, dedupKey) {
  const key = normalizeKey(dedupKey);
  if (!key) return false;
  const loc = locateSection(md, section);
  if (!loc) return false;
  return extractIdentifiers(loc.body).some(id => normalizeKey(id) === key);
}

export function insertIntoCvSection(md, section, entry) {
  const block = entry.replace(/\s+$/, '');
  const loc = locateSection(md, section);
  if (!loc) {
    const base = md.replace(/\s+$/, '');
    return `${base}\n\n## ${section}\n\n${block}\n`;
  }
  const body = loc.body.replace(/\s+$/, '');
  const newBody = body ? `${body}\n${block}` : block;
  const parts = [loc.before, loc.heading, '', newBody, ''];
  const after = loc.after.replace(/^\n+/, '');
  const rebuilt = parts.join('\n') + (after ? `\n${after}` : '');
  return rebuilt.replace(/\n{3,}/g, '\n\n');
}

export function articleDigestHasEntry(md, dedupKey) {
  const key = normalizeKey(dedupKey);
  if (!key) return false;
  for (const m of md.matchAll(/^##\s+(.*\S)\s*$/gm)) {
    const name = m[1].split(/\s+[—–-]{1,2}\s+/)[0];
    const n = normalizeKey(name);
    if (n === key) return true;
  }
  return false;
}

export function appendArticleDigest(md, entry) {
  const block = entry.replace(/\s+$/, '');
  const base = md.replace(/\s+$/, '');
  return `${base}\n\n---\n\n${block}\n`;
}

export function applyAdd(payload, { cvText = null, articleText = null } = {}) {
  if (!payload || typeof payload !== 'object' || (!payload.cv && !payload.articleDigest)) {
    throw new Error('payload must include at least one of: cv, articleDigest');
  }

  const result = {};
  let cv = cvText;
  let articleDigest = articleText;

  if (payload.cv) {
    const { section, dedupKey, entry } = payload.cv;
    if (!section || !entry) throw new Error('payload.cv requires { section, entry }');
    if (!normalizeKey(dedupKey)) throw new Error('payload.cv requires a non-empty dedupKey (used for dedup/idempotency)');
    if (cvText === null) throw new Error(`cv.md not found — cannot add to a CV that does not exist`);
    if (cvHasEntry(cvText, section, dedupKey)) {
      result.cv = { status: 'duplicate', section };
    } else {
      cv = insertIntoCvSection(cvText, section, entry);
      result.cv = { status: 'added', section };
    }
  }

  if (payload.articleDigest) {
    const { dedupKey, entry } = payload.articleDigest;
    if (!entry) throw new Error('payload.articleDigest requires { entry }');
    if (!normalizeKey(dedupKey)) throw new Error('payload.articleDigest requires a non-empty dedupKey (used for dedup/idempotency)');
    const current = articleText === null
      ? '# Article Digest -- Proof Points\n\nCompact proof points from portfolio projects. Read by career-ops at evaluation time.\n'
      : articleText;
    if (articleDigestHasEntry(current, dedupKey)) {
      result.articleDigest = { status: 'duplicate' };
      articleDigest = articleText;
    } else {
      articleDigest = appendArticleDigest(current, entry);
      result.articleDigest = { status: articleText === null ? 'created' : 'added' };
    }
  }

  return { cv, articleDigest, result };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const args = process.argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE);

  const dryRun = args.includes('--dry-run');
  const useStdin = args.includes('--stdin');
  const fileArg = args.find(a => !a.startsWith('-'));

  if (!useStdin && !fileArg) {
    console.error(USAGE);
    process.exit(1);
  }

  let payload;
  try {
    const raw = useStdin ? await readStdin() : readFileSync(fileArg, 'utf-8');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(`add-entry: could not read/parse payload: ${e.message}`);
    process.exit(1);
  }

  const cvText = existsSync(CV_FILE) ? readFileSync(CV_FILE, 'utf-8') : null;
  const articleText = existsSync(ARTICLE_DIGEST_FILE) ? readFileSync(ARTICLE_DIGEST_FILE, 'utf-8') : null;

  let out;
  try {
    out = applyAdd(payload, { cvText, articleText });
  } catch (e) {
    console.error(`add-entry: ${e.message}`);
    process.exit(1);
  }

  if (!dryRun) {
    const written = [];
    try {
      if (payload.cv && out.result.cv?.status === 'added') {
        writeFileSync(CV_FILE, out.cv);
        written.push('cv.md');
      }
      if (payload.articleDigest && (out.result.articleDigest?.status === 'added' || out.result.articleDigest?.status === 'created')) {
        writeFileSync(ARTICLE_DIGEST_FILE, out.articleDigest);
        written.push('article-digest.md');
      }
    } catch (e) {
      console.error(`add-entry: write failed after writing [${written.join(', ') || 'nothing'}]: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ dryRun, ...out.result }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
