#!/usr/bin/env node

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'you',
  'your', 'our', 'are', 'not', 'to', 'of', 'in', 'on', 'or', 'a', 'an',
  '负责', '岗位', '工作', '相关', '具备', '以及', '能够', '进行', '通过', '需要',
]);

const LEVELS = [
  ['intern', '实习', '实习生', '应届'],
  ['junior', '初级'],
  ['mid', '中级'],
  ['senior', '高级', '资深'],
  ['staff', 'principal', 'lead', '负责人'],
];

export function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}+#./-]+/gu)
      ?.map(token => token.replace(/^[./-]+|[./-]+$/g, ''))
      .filter(token => token && (token.length > 1 || /\d/.test(token)) && !STOP_WORDS.has(token)) || [],
  );
}

export function jaccardSimilarity(left, right) {
  const a = left instanceof Set ? left : tokenize(left);
  const b = right instanceof Set ? right : tokenize(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const NON_LEVEL_FOLLOWERS = {
  principal: ['responsibilities', 'responsibility', 'duties', 'accountabilities', 'objectives', 'purpose', 'tasks', 'activities'],
  lead: ['to', 'the', 'a', 'an', 'our', 'and', 'or', 'by', 'on', 'in', 'for', 'with', 'from', 'mentoring', 'projects'],
  mid: ['market', 'size', 'sized', 'cap', 'tier', 'funnel', 'term', 'sized-company'],
};

function readsAsLevel(word, normalized, index) {
  const followers = NON_LEVEL_FOLLOWERS[word];
  if (!followers) return true;
  const after = normalized.slice(index + word.length).match(/^[^a-z0-9]*([a-z0-9-]+)/);
  return !after || !followers.includes(after[1]);
}

function levelsIn(text) {
  const normalized = String(text ?? '').toLowerCase();
  const found = new Set();
  LEVELS.forEach((words, level) => {
    for (const word of words) {
      if (/^[\p{Script=Han}]+$/u.test(word)) {
        if (normalized.includes(word)) { found.add(level); break; }
        continue;
      }
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'gi');
      let match;
      while ((match = pattern.exec(normalized)) !== null) {
        if (readsAsLevel(word, normalized, match.index + match[0].length - word.length)) {
          found.add(level);
          break;
        }
      }
      if (found.has(level)) break;
    }
  });
  return found;
}

function levelOf(text) {
  const levels = levelsIn(text);
  return levels.size === 1 ? [...levels][0] : -1;
}

export function hardMismatch(newJd, previousText) {
  const newLevel = levelOf(newJd);
  const previousLevel = levelOf(previousText);
  return newLevel >= 0 && previousLevel >= 0 && newLevel !== previousLevel;
}

export function recommendCvReuse(newJd, previousText, options = {}) {
  const score = jaccardSimilarity(newJd, previousText);
  const high = Number(options.highThreshold ?? 0.72);
  const medium = Number(options.mediumThreshold ?? 0.45);
  if (hardMismatch(newJd, previousText)) {
    return { decision: 'regenerate', score, reason: 'level-mismatch' };
  }
  if (score >= high) return { decision: 'reuse', score, reason: 'high-similarity' };
  if (score >= medium) return { decision: 'reuse-with-edits', score, reason: 'medium-similarity' };
  return { decision: 'regenerate', score, reason: 'low-similarity' };
}

const KNOWN_FLAGS = ['--help', '-h'];

const USAGE = `Usage:
  node jd-similarity.mjs new-jd.txt previous-jd-or-cv.txt
  node jd-similarity.mjs --help                    # print this usage block and exit`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  }
  const [newJdPath, previousPath] = args;
  if (args.length !== 2 || !newJdPath || !previousPath) {
    console.error('Error: expected two file paths.');
    console.error(USAGE);
    process.exit(1);
  }

  return { newJdPath, previousPath };
}

if (isMainModule(import.meta.url)) {
  const { newJdPath, previousPath } = parseArgs(process.argv);
  try {
    const result = recommendCvReuse(readFileSync(newJdPath, 'utf8'), readFileSync(previousPath, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Unable to read input files: ${error.message}`);
    process.exit(1);
  }
}
