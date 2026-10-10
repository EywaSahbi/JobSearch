#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { verifyPortalsFile } from './verify-portals.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');

const KNOWN_FLAGS = ['--apply', '--dry-run', '--file', '--fix', '--help', '-h'];
const VALUE_FLAGS = ['--file'];

const USAGE = `Usage:
  node fix-slugs.mjs               # dry run (default, safe) — prints the diff, writes nothing
  node fix-slugs.mjs --dry-run     # same as above, explicit
  node fix-slugs.mjs --fix         # write the resolved slugs back to portals.yml
  node fix-slugs.mjs --apply       # alias for --fix
  node fix-slugs.mjs --file <path> # use a specific portals file
  node fix-slugs.mjs --help        # show this message (-h is an alias)`;

const NAME_LINE_RE = /^([ \t]*)-\s*name:\s*(.+?)\s*$/;

export function splitCompanyBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(NAME_LINE_RE);
    if (m) {
      if (current) {
        current.endLine = i;
        blocks.push(current);
      }
      current = { name: m[2].trim(), indent: m[1], startLine: i, endLine: null };
    }
  }
  if (current) {
    current.endLine = lines.length;
    blocks.push(current);
  }
  return { lines, blocks };
}

function resolvedUrls({ ats, slug, eu }) {
  if (ats === 'greenhouse') {
    return {
      careersUrl: `https://job-boards.greenhouse.io/${slug}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    };
  }
  if (ats === 'ashby') {
    return { careersUrl: `https://jobs.ashbyhq.com/${slug}`, api: null };
  }
  return {
    careersUrl: `https://jobs.${eu ? 'eu.' : ''}lever.co/${slug}`,
    api: null,
  };
}

function findFieldLine(lines, startLine, endLine, fieldIndent, field) {
  const re = new RegExp(`^${fieldIndent}${field}:\\s*(.*)$`);
  for (let i = startLine; i < endLine; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function escapeForDoubleQuoted(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appendNote(lines, block, notesLine, fieldIndent, note) {
  const keyIdx = lines[notesLine].indexOf('notes:');
  const afterKey = lines[notesLine].slice(keyIdx + 'notes:'.length).trim();

  const blockScalarMatch = afterKey.match(/^([|>])[-+]?\d*\s*(#.*)?$/);
  if (blockScalarMatch) {
    let contentIndent = null;
    let insertAt = notesLine + 1;
    for (let i = notesLine + 1; i < block.endLine; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        insertAt = i + 1;
        continue;
      }
      const lineIndent = line.match(/^[ \t]*/)[0];
      if (lineIndent.length <= fieldIndent.length) break;
      contentIndent = lineIndent;
      insertAt = i + 1;
    }
    const noteIndent = contentIndent || `${fieldIndent}  `;
    lines.splice(insertAt, 0, `${noteIndent}${note}`);
    block.endLine += 1;
    return;
  }

  const doubleQuotedRe = /^"((?:[^"\\]|\\.)*)"[ \t]*(#.*)?$/;
  const singleQuotedRe = /^'((?:[^']|'')*)'[ \t]*(#.*)?$/;

  let inner;
  let comment = '';
  const dq = afterKey.match(doubleQuotedRe);
  const sq = !dq && afterKey.match(singleQuotedRe);
  if (dq) {
    inner = dq[1];
    comment = dq[2] || '';
  } else if (sq) {
    inner = escapeForDoubleQuoted(sq[1].replace(/''/g, "'"));
    comment = sq[2] || '';
  } else {
    let hashIdx = -1;
    for (let i = 0; i < afterKey.length; i++) {
      if (afterKey[i] === '#' && (i === 0 || /\s/.test(afterKey[i - 1]))) {
        hashIdx = i;
        break;
      }
    }
    const value = hashIdx === -1 ? afterKey : afterKey.slice(0, hashIdx).trimEnd();
    comment = hashIdx === -1 ? '' : afterKey.slice(hashIdx);
    inner = escapeForDoubleQuoted(value);
  }
  lines[notesLine] = `${fieldIndent}notes: "${inner} ${note}"${comment ? ` ${comment}` : ''}`;
}

function applyFix(lines, block, suggested, oldAts, dateStr) {
  const fieldIndent = `${block.indent}  `;
  const { careersUrl, api } = resolvedUrls(suggested);

  const careersLine = findFieldLine(lines, block.startLine, block.endLine, fieldIndent, 'careers_url');
  const careersUrlOld = careersLine !== -1 ? lines[careersLine].split(':').slice(1).join(':').trim() : '';
  let insertAfter = careersLine;
  if (careersLine !== -1) {
    lines[careersLine] = `${fieldIndent}careers_url: ${careersUrl}`;
  } else {
    lines.splice(block.startLine + 1, 0, `${fieldIndent}careers_url: ${careersUrl}`);
    insertAfter = block.startLine + 1;
    block.endLine += 1;
  }

  const apiLine = findFieldLine(lines, block.startLine, block.endLine, fieldIndent, 'api');
  if (api) {
    if (apiLine !== -1) {
      lines[apiLine] = `${fieldIndent}api: ${api}`;
      insertAfter = Math.max(insertAfter, apiLine);
    } else {
      lines.splice(insertAfter + 1, 0, `${fieldIndent}api: ${api}`);
      block.endLine += 1;
      insertAfter += 1;
    }
  } else if (apiLine !== -1) {
    lines.splice(apiLine, 1);
    block.endLine -= 1;
  }

  const note = `(slug migrated ${oldAts}->${suggested.ats} ${dateStr}, verify-portals)`;
  const notesLine = findFieldLine(lines, block.startLine, block.endLine, fieldIndent, 'notes');
  if (notesLine !== -1) {
    appendNote(lines, block, notesLine, fieldIndent, note);
  } else {
    lines.splice(insertAfter + 1, 0, `${fieldIndent}notes: "${note}"`);
    block.endLine += 1;
  }

  return { careersUrlOld, careersUrlNew: careersUrl };
}

export function computeFixes(rawText, results, { dateStr = new Date().toISOString().slice(0, 10) } = {}) {
  const { lines, blocks } = splitCompanyBlocks(rawText);
  const blocksByName = new Map(blocks.map((b) => [b.name, b]));

  const pending = [];
  for (const r of results) {
    if (r.status !== 'missing' || !r.suggested) continue;
    if (!r.suggested.ats || !r.suggested.slug) continue;
    const block = blocksByName.get(r.name);
    if (!block) continue;
    pending.push({ r, block });
  }
  pending.sort((a, b) => b.block.startLine - a.block.startLine);

  const fixesByName = new Map();
  for (const { r, block } of pending) {
    const { careersUrlOld, careersUrlNew } = applyFix(lines, block, r.suggested, r.ats || 'unknown', dateStr);
    fixesByName.set(r.name, {
      name: r.name,
      oldAts: r.ats || 'unknown',
      newAts: r.suggested.ats,
      careersUrlOld,
      careersUrlNew,
    });
  }

  const fixes = results.map((r) => fixesByName.get(r.name)).filter(Boolean);

  return { text: lines.join('\n'), fixes };
}

function printDiff(fixes, { dryRun }) {
  if (fixes.length === 0) {
    console.log('No resolvable slug fixes found — nothing to do.');
    return;
  }
  console.log(`${dryRun ? '[dry run] Would fix' : 'Fixed'} ${fixes.length} entr${fixes.length === 1 ? 'y' : 'ies'}:\n`);
  for (const f of fixes) {
    console.log(`  ${f.name}: ${f.oldAts} -> ${f.newAts}`);
    console.log(`    - ${f.careersUrlOld}`);
    console.log(`    + ${f.careersUrlNew}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (hasFlag(args, '--file')) {
    const rawVal = flagValue(args, '--file');
    if (rawVal === undefined || rawVal === '' || rawVal.startsWith('-')) {
      console.error('Error: --file requires a value');
      process.exit(1);
    }
  }

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  const fix = args.includes('--fix') || args.includes('--apply');
  const dryRun = !fix;

  const fileVal = flagValue(args, '--file');
  const filePath = resolve(fileVal || DEFAULT_PORTALS_PATH);

  if (!existsSync(filePath)) {
    console.log(`fix-slugs: no portals file at ${filePath} — nothing to fix.`);
    return;
  }

  const { results } = await verifyPortalsFile(filePath);
  const rawText = readFileSync(filePath, 'utf-8');
  const { text, fixes } = computeFixes(rawText, results);

  printDiff(fixes, { dryRun });

  if (!dryRun && fixes.length > 0) {
    writeFileSync(filePath, text, 'utf-8');
    console.log(`\nportals.yml updated (${fixes.length} fixed).`);
  } else if (dryRun && fixes.length > 0) {
    console.log('\nRun with --fix to write these changes to portals.yml.');
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fix-slugs failed: ${err.message}`);
    process.exit(1);
  });
}
