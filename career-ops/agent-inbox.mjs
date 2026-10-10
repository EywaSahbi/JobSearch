#!/usr/bin/env node

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  openSync, fstatSync, readSync, closeSync, realpathSync, statSync,
} from 'fs';
import { dirname } from 'path';
import { withPipelineLock } from './pipeline-lock.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const PATH = process.env.CAREER_OPS_INBOX || 'data/agent-inbox.md';

const HEADER = [
  '# Agent Inbox',
  '',
  '> **Agent protocol:** at the start of a career-ops session, read this file.',
  '> Run each unchecked item top-to-bottom. After each, mark it `[x]` and append',
  '> `→ result: <one line>`. Items that need live user input (a mock, a paste, a',
  '> decision) → ask the user to start them instead of running them.',
  '>',
  '> Nothing here auto-submits — queued items are *intents* for you to action and',
  '> the user to review. Appended by hand, by a dashboard, or by agent-inbox.mjs.',
  '',
].join('\n');

function stamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

function ensureGitignored() {
  if (process.env.CAREER_OPS_INBOX || PATH !== 'data/agent-inbox.md') return;
  try {
    if (!existsSync('.gitignore')) return;
    const text = readFileSync('.gitignore', 'utf8');
    if (text.split('\n').some((l) => l.trim() === PATH)) return;
    writeFileSync('.gitignore', text.replace(/\s*$/, '') + `\n${PATH}\n`);
  } catch { }
}

function oneLine(s) {
  return String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function ensureFile() {
  if (existsSync(PATH)) return;
  ensureGitignored();
  mkdirSync(dirname(PATH), { recursive: true });
  try {
    writeFileSync(PATH, HEADER, { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

function needsLeadingNewline(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

function parseItems() {
  if (!existsSync(PATH)) return [];
  const items = [];
  readFileSync(PATH, 'utf8').split('\n').forEach((line, i) => {
    const m = /^- \[([ xX])\]\s*(.*)$/.exec(line.trim());
    if (m) items.push({ num: items.length + 1, line: i, done: m[1].toLowerCase() === 'x', text: m[2] });
  });
  return items;
}

function opt(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}

function optAll(name) {
  const values = [];
  process.argv.forEach((arg, i) => {
    if (arg !== '--' + name) return;
    const v = process.argv[i + 1];
    values.push(v && !v.startsWith('--') ? v : '');
  });
  return values;
}

async function add() {
  const text = oneLine(process.argv.slice(3).join(' '));
  if (!text) fail('add needs a request, e.g. node agent-inbox.mjs add "evaluate https://..."');
  await withPipelineLock(PATH, () => {
    ensureFile();
    const separator = needsLeadingNewline(PATH) ? '\n' : '';
    appendFileSync(PATH, `${separator}- [ ] ${stamp()} — ${text}\n`);
  }, { timeoutMs: 30_000 });
  process.stdout.write(`Queued: ${text}\n`);
}

function list() {
  const all = process.argv.includes('--all');
  const parsed = parseItems();
  const items = parsed.filter((it) => all || !it.done);
  if (!items.length) return process.stdout.write(all ? 'Inbox is empty.\n' : 'No pending items.\n');
  items.forEach((it) => {
    process.stdout.write(`${String(it.num).padStart(2)}. [${it.done ? 'x' : ' '}] ${it.text}\n`);
  });
  if (items.length < parsed.length) {
    process.stdout.write(
      `\n(${parsed.length - items.length} resolved item(s) hidden — numbers are stable file positions, so gaps are expected. \`list --all\` shows everything.)\n`,
    );
  }
}

async function resolve() {
  const n = Number(process.argv[3]);
  if (!Number.isInteger(n) || n < 1) fail('resolve needs a 1-based item number (see `list`)');
  const outcome = await withPipelineLock(PATH, () => {
    const items = parseItems();
    const target = items[n - 1];
    if (!target) {
      const pending = items.filter((it) => !it.done).length;
      return { error: `no item #${n} — inbox has ${items.length} item(s), ${pending} pending. Run \`list --all\`.` };
    }
    if (target.done) return { error: `item #${n} is already resolved — refusing to overwrite it:\n  #${n}: ${target.text}` };
    const expects = optAll('expect');
    if (expects.includes('')) return { error: '--expect needs a substring, e.g. --expect "Dana-Farber"' };
    const missing = expects.find((expect) => !target.text.toLowerCase().includes(expect.toLowerCase()));
    if (missing !== undefined) {
      return { error: `item #${n} does not contain --expect ${JSON.stringify(missing)} — refusing to resolve:\n  #${n}: ${target.text}` };
    }
    const result = oneLine(opt('result'));
    const lines = readFileSync(PATH, 'utf8').split('\n');
    let updated = lines[target.line].replace('[ ]', '[x]');
    if (result && !/→ result:/.test(updated)) updated += ` → result: ${result}`;
    lines[target.line] = updated;
    const real = realpathSync(PATH);
    writeFileAtomic(real, lines.join('\n'), { mode: statSync(real).mode & 0o7777 });
    return { target };
  }, { timeoutMs: 30_000 });
  if (outcome.error) fail(outcome.error);
  process.stdout.write(`Resolved #${n}: ${outcome.target.text}\n`);
}

function fail(msg) {
  process.stderr.write(`agent-inbox.mjs: ${msg}\n`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'add') await add();
else if (cmd === 'list') list();
else if (cmd === 'resolve') await resolve();
else {
  process.stdout.write(
    'Usage:\n' +
    '  node agent-inbox.mjs add "evaluate https://acme.com/jobs/42"\n' +
    '  node agent-inbox.mjs list [--all]\n' +
    '  node agent-inbox.mjs resolve <n> [--expect "substring"] [--result "..."]\n' +
    '\n' +
    'Numbers are stable file positions: `list` shows gaps once items are\n' +
    'resolved, and a batch of resolves read off one `list` stays correct.\n' +
    '--expect aborts unless the target item contains that substring.\n',
  );
}
