#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

export const APPLICATION_ANSWERS_HEADING = '## Application Answers';

const VALID_STATES = new Set(['filled', 'submitted']);

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function valueText(value) {
  if (Array.isArray(value)) return value.map(inline).filter(Boolean).join(', ');
  return String(value ?? '').trim();
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(state) {
  const normalized = inline(state || 'filled').toLowerCase();
  if (!VALID_STATES.has(normalized)) {
    throw new Error(`Application answer state must be one of: ${[...VALID_STATES].join(', ')}`);
  }
  return normalized;
}

function normalizeDate(date) {
  return inline(date || localToday());
}

function quoteBlock(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '> Not recorded.';
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function qaLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.flatMap((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const answer = pick(entry, valueKeys);
    return [
      `${index + 1}. **${label}**`,
      '',
      quoteBlock(answer),
      '',
    ];
  }).slice(0, -1);
}

function compactLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.map((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const value = valueText(pick(entry, valueKeys)) || 'Not recorded';
    return `${index + 1}. **${label}:** ${value}`;
  });
}

function fileLines(entries) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.map((entry, index) => {
    const label = inline(pick(entry, ['field', 'name', 'label', 'type'])) || `File ${index + 1}`;
    const file = inline(pick(entry, ['path', 'file', 'filename', 'url'])) || 'Not recorded';
    const version = inline(pick(entry, ['version', 'variant']));
    return `${index + 1}. **${label}:** ${version ? `${file} (${version})` : file}`;
  });
}

export function normalizeApplicationAnswersSnapshot(snapshot = {}) {
  return {
    date: normalizeDate(snapshot.date),
    state: normalizeState(snapshot.state),
    freeText: list(snapshot.freeText ?? snapshot.freeTextAnswers ?? snapshot.answers),
    selections: list(snapshot.selections ?? snapshot.selectedOptions),
    fieldValues: list(snapshot.fieldValues ?? snapshot.otherFields ?? snapshot.fields),
    files: list(snapshot.files ?? snapshot.uploads ?? snapshot.filesUsed),
  };
}

export function formatApplicationAnswersSection(snapshot = {}) {
  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const lines = [
    APPLICATION_ANSWERS_HEADING,
    '',
    `**Date:** ${normalized.date}`,
    `**State:** ${normalized.state}`,
    '',
    '### Free-text answers',
    '',
    ...qaLines(normalized.freeText, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Answer',
    }),
    '',
    '### Selections made',
    '',
    ...compactLines(normalized.selections, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['selection', 'selected', 'answer', 'value', 'options'],
      fallback: 'Selection',
    }),
    '',
    '### Other field values',
    '',
    ...compactLines(normalized.fieldValues, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Field',
    }),
    '',
    '### Files used',
    '',
    ...fileLines(normalized.files),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const FREE_TEXT_HEADING = '### Free-text answers';
const SELECTIONS_HEADING = '### Selections made';
const FIELD_VALUES_HEADING = '### Other field values';
const FILES_HEADING = '### Files used';

const NONE_CAPTURED = '- None captured.';
const NOT_RECORDED_BLOCK = 'Not recorded.';
const NOT_RECORDED_INLINE = 'Not recorded';

function sliceGroups(body) {
  const order = [
    ['freeText', FREE_TEXT_HEADING],
    ['selections', SELECTIONS_HEADING],
    ['fieldValues', FIELD_VALUES_HEADING],
    ['files', FILES_HEADING],
  ];
  const groups = { freeText: '', selections: '', fieldValues: '', files: '' };

  const marks = order
    .map(([key, heading]) => {
      const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      const hit = re.exec(body);
      return hit ? { key, start: hit.index, end: hit.index + hit[0].length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  marks.forEach((mark, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].start : body.length;
    groups[mark.key] = body.slice(mark.end, stop).trim();
  });

  return groups;
}

function parseQaEntries(block, labelKey, valueKey, onSkip) {
  if (!block || block === NONE_CAPTURED) return [];
  const lines = block.split('\n');
  const entries = [];
  let current = null;
  let quoted = [];

  const flush = () => {
    if (!current) return;
    const text = quoted.join('\n').trim();
    entries.push({
      [labelKey]: current,
      [valueKey]: text === NOT_RECORDED_BLOCK ? '' : text,
    });
    current = null;
    quoted = [];
  };

  for (const line of lines) {
    const head = /^\d+\.\s+\*\*(.*)\*\*\s*$/.exec(line);
    if (head) {
      flush();
      current = head[1].trim();
      continue;
    }
    if (current !== null && /^>/.test(line)) {
      quoted.push(line.replace(/^>\s?/, ''));
      continue;
    }
    if (line.trim()) onSkip?.(line);
  }
  flush();
  return entries;
}

function parseCompactEntries(block, labelKey, valueKey, onSkip) {
  if (!block || block === NONE_CAPTURED) return [];
  const entries = [];
  for (const line of block.split('\n')) {
    const hit = /^\d+\.\s+\*\*(.+):\*\*\s*(.*)$/.exec(line);
    if (!hit) { if (line.trim()) onSkip?.(line); continue; }
    const value = hit[2].trim();
    entries.push({
      [labelKey]: hit[1].trim(),
      [valueKey]: value === NOT_RECORDED_INLINE ? '' : value,
    });
  }
  return entries;
}

function parseFileEntries(block, onSkip) {
  if (!block || block === NONE_CAPTURED) return [];
  const entries = [];
  for (const line of block.split('\n')) {
    const hit = /^\d+\.\s+\*\*(.+):\*\*\s*(.*)$/.exec(line);
    if (!hit) { if (line.trim()) onSkip?.(line); continue; }
    const raw = hit[2].trim();
    const versioned = /^(.*\S)\s+\(([^()]*)\)$/.exec(raw);
    const file = versioned ? versioned[1].trim() : raw;
    const entry = {
      field: hit[1].trim(),
      path: file === NOT_RECORDED_INLINE ? '' : file,
    };
    if (versioned && versioned[2].trim()) entry.version = versioned[2].trim();
    entries.push(entry);
  }
  return entries;
}

export function parseApplicationAnswersSection(reportText, { strict = false } = {}) {
  const skipped = [];
  const onSkip = strict ? (line) => skipped.push(line.trim()) : undefined;
  const report = String(reportText ?? '').replace(/\r\n/g, '\n');
  const heading = /^## Application Answers\s*$/m.exec(report);
  if (!heading) return null;

  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^## .+$/m.exec(report.slice(afterHeading));
  const body = report.slice(
    afterHeading,
    nextHeading ? afterHeading + nextHeading.index : report.length,
  );

  const dateHit = /^\*\*Date:\*\*\s*(.*)$/m.exec(body);
  const stateHit = /^\*\*State:\*\*\s*(.*)$/m.exec(body);
  const groups = sliceGroups(body);

  const snapshot = {
    date: dateHit ? dateHit[1].trim() : '',
    state: stateHit ? stateHit[1].trim().toLowerCase() : '',
    freeText: parseQaEntries(groups.freeText, 'question', 'answer', onSkip),
    selections: parseCompactEntries(groups.selections, 'question', 'selection', onSkip),
    fieldValues: parseCompactEntries(groups.fieldValues, 'question', 'answer', onSkip),
    files: parseFileEntries(groups.files, onSkip),
  };

  if (strict && skipped.length) {
    throw new Error(
      `Application Answers section has ${skipped.length} unreadable ` +
      `${skipped.length === 1 ? 'entry' : 'entries'}: ${skipped.join(' | ')}`,
    );
  }
  return snapshot;
}

const DRAFT_ANSWERS_MARKER_RE = /\(draft\)\s*$/i;
const DRAFT_ANSWERS_NAME_RE = /^draft application answers$/i;
const HEADING_PREFIX_RE = /^\s*(?:Block\s+([A-Z])(?:[).:]\s*|\s+(?:[—–-]+\s*)?)|([A-Z])[).:]\s*)/i;
const DRAFT_ANSWERS_LETTER_RE = /^H\)\s*(.*)$/i;

function findDraftAnswersHeading(report) {
  const headings = [...report.matchAll(/^##[ \t]+(.+?)\s*$/gm)];
  const marked = headings.find(h => DRAFT_ANSWERS_MARKER_RE.test(h[1]));
  if (marked) return marked;
  const named = headings.find(h => DRAFT_ANSWERS_NAME_RE.test(
    h[1].replace(DRAFT_ANSWERS_MARKER_RE, '').replace(HEADING_PREFIX_RE, '').trim(),
  ));
  if (named) return named;
  return headings.find(h => Boolean(DRAFT_ANSWERS_LETTER_RE.exec(h[1])?.[1]?.trim())) ?? null;
}

export function parseDraftAnswersBlockH(reportText) {
  const report = String(reportText ?? '').replace(/\r\n/g, '\n');
  const heading = findDraftAnswersHeading(report);
  if (!heading) return null;

  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^##[ \t]+.+$/m.exec(report.slice(afterHeading));
  const body = report.slice(
    afterHeading,
    nextHeading ? afterHeading + nextHeading.index : report.length,
  );

  const questionLine = /^\*\*(.+?)\*\*\s*$/gm;
  const marks = [...body.matchAll(questionLine)];
  const freeText = [];
  for (const [index, mark] of marks.entries()) {
    const from = mark.index + mark[0].length;
    const to = index + 1 < marks.length ? marks[index + 1].index : body.length;
    const question = mark[1].trim();
    if (!question) continue;
    const answer = body
      .slice(from, to)
      .replace(/^\s*-{3,}\s*$/gm, '')
      .trim();
    freeText.push({ question, answer });
  }
  return { freeText };
}

export function upsertApplicationAnswersSection(reportText, snapshot = {}) {
  const report = String(reportText ?? '').replace(/\r\n/g, '\n');
  const section = formatApplicationAnswersSection(snapshot).trimEnd();
  const heading = /^## Application Answers\s*$/m.exec(report);

  if (!heading) {
    return `${report.trimEnd()}\n\n${section}\n`;
  }

  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const nextHeading = /^## .+$/m.exec(report.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : report.length;
  const before = report.slice(0, start).trimEnd();
  const after = report.slice(end).trimStart();

  return [before, section, after].filter(Boolean).join('\n\n') + '\n';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--read') args.read = true;
    else if (arg === '--read-draft') args.readDraft = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node application-answers.mjs --report <report.md> --input <answers.json> [--state filled|submitted] [--date YYYY-MM-DD]',
    '       node application-answers.mjs --report <report.md> --read [--strict]',
    '       node application-answers.mjs --report <report.md> --read-draft',
    '',
    'The input JSON may contain: freeText, selections, fieldValues, files, date, state.',
    '--read prints the parsed ## Application Answers snapshot as JSON (null when the section is absent).',
    '--strict makes --read refuse a partially unreadable section, naming every line it could not parse,',
    'instead of skipping it. Recovery callers (modes/apply.md) want the refusal; the default stays total.',
    '--read-draft prints the evaluation mode\'s ## H) Draft Application Answers block instead, as a partial',
    'snapshot ({"freeText": [...]}), or null when the report has no Block H. Best-effort by construction:',
    'modes/oferta.md fixes the heading and not the body, so an empty freeText means "drafted, unreadable",',
    'which is why --strict does not apply to it.',
  ].join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.strict && !args.read) {
    console.error(`--strict only applies to --read.\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (args.read && args.readDraft) {
    console.error(`--read and --read-draft print different sections; pass one.\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (args.readDraft) {
    if (args.input || args.state || args.date) {
      console.error(`--read-draft is read-only and takes no --input, --state or --date.\n\n${usage()}`);
      process.exitCode = 1;
      return;
    }
    if (!args.report) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }
    const reportText = readFileSync(resolve(args.report), 'utf-8');
    console.log(JSON.stringify(parseDraftAnswersBlockH(reportText), null, 2));
    return;
  }
  if (args.read) {
    if (args.input || args.state || args.date) {
      console.error(`--read is read-only and takes no --input, --state or --date.\n\n${usage()}`);
      process.exitCode = 1;
      return;
    }
    if (!args.report) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }
    const reportText = readFileSync(resolve(args.report), 'utf-8');
    const snapshot = parseApplicationAnswersSection(reportText, { strict: args.strict === true });
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (!args.report || !args.input) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const inputText = args.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(resolve(args.input), 'utf-8');
  const input = JSON.parse(inputText);
  const snapshot = {
    ...input,
    date: args.date || input.date,
    state: args.state || input.state,
  };
  const reportPath = resolve(args.report);
  const updated = upsertApplicationAnswersSection(readFileSync(reportPath, 'utf-8'), snapshot);
  writeFileSync(reportPath, updated, 'utf-8');

  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  console.log(JSON.stringify({ report: reportPath, date: normalized.date, state: normalized.state }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
