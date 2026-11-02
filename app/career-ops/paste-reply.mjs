#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
export const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(DATA_ROOT, 'data', 'reply-candidates.json');


export function parseFileInput(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let subject = '';
  let from = '';
  let i = 0;
  while (i < lines.length) {
    const subjMatch = /^Subject:\s*(.*)$/i.exec(lines[i]);
    const fromMatch = /^From:\s*(.*)$/i.exec(lines[i]);
    if (subjMatch) {
      subject = subjMatch[1].trim();
      i++;
      continue;
    }
    if (fromMatch) {
      from = fromMatch[1].trim();
      i++;
      continue;
    }
    break;
  }
  if (lines[i] === '') i++;
  const body = lines.slice(i).join('\n').trim();
  return { subject, from, body };
}

function nextMessageId() {
  return `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeCandidate({ subject, from, body }) {
  return {
    message_id: nextMessageId(),
    from: from || '',
    subject: subject || '',
    body_snippet: body || '',
    signal: null,
  };
}

export function appendCandidate(candidate, candidatesPath = CANDIDATES_PATH) {
  let candidates = [];
  if (fs.existsSync(candidatesPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    } catch (e) {
      throw new Error(`Could not parse existing candidates file at ${candidatesPath}: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Existing candidates file at ${candidatesPath} is not a JSON array`);
    }
    candidates = parsed;
  } else {
    fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  }
  candidates.push(candidate);
  const tmpPath = `${candidatesPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(candidates, null, 2), 'utf-8');
  renameSyncWithRetry(tmpPath, candidatesPath);
  return candidates.length;
}

export function collectInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stage = 'subject';
  let subject = '';
  let from = '';
  const bodyLines = [];

  rl.setPrompt('Subject: ');
  rl.prompt();

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (stage === 'subject') {
        subject = line.trim();
        stage = 'from';
        rl.setPrompt('From (optional, press Enter to skip): ');
        rl.prompt();
      } else if (stage === 'from') {
        from = line.trim();
        stage = 'body';
        console.log('Paste the email body. Finish with EOF (Ctrl+D, or Ctrl+Z then Enter on Windows):');
        rl.setPrompt('');
      } else {
        bodyLines.push(line);
      }
    });
    rl.on('close', () => resolve({ subject, from, body: bodyLines.join('\n').trim() }));
  });
}

function printHelp() {
  console.log(`paste-reply.mjs — manual/no-Gmail input into the reply-watch.mjs pipeline (#1802)

Usage:
  node paste-reply.mjs                  interactive: prompts for subject, from, body
  node paste-reply.mjs --file <path>    read subject/from/body from a file
  node paste-reply.mjs --help

--file format:
  Subject: <subject line>
  From: <sender>            (optional)

  <body text...>

If no Subject:/From: header lines are found, the whole file is treated as the body.

Appends one normalized candidate to data/reply-candidates.json (creates it if
missing; never overwrites or removes existing entries). Run
\`node reply-watch.mjs\` afterward to classify it and review tracker updates —
this script never runs reply-watch.mjs or touches data/applications.md itself.`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const fileIdx = args.indexOf('--file');
  let input;
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      console.error('Error: --file requires a path argument.');
      process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    input = parseFileInput(raw);
  } else {
    input = await collectInteractive();
  }

  if (!input.subject && !input.body) {
    console.error('Error: no subject or body text found — nothing to add.');
    process.exit(1);
  }

  const candidate = normalizeCandidate(input);
  const total = appendCandidate(candidate);

  const preview = candidate.body_snippet.length > 80
    ? `${candidate.body_snippet.slice(0, 80)}…`
    : candidate.body_snippet;

  console.log('\nAppended a new reply candidate:');
  console.log(`  message_id:   ${candidate.message_id}`);
  console.log(`  from:         ${candidate.from || '(none)'}`);
  console.log(`  subject:      ${candidate.subject || '(none)'}`);
  console.log(`  body_snippet: ${preview || '(none)'}`);
  console.log(`\ndata/reply-candidates.json now has ${total} candidate(s).`);
  console.log('Next: run `node reply-watch.mjs` to classify and review this reply.');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
