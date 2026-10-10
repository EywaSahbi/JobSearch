#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { parseStories, splitStoryBlocks, isValidStory } from './lib/story-bank.mjs';

const STORY_BANK_PATH = join(getCareerOpsRoot(), 'interview-prep', 'story-bank.md');

const args       = process.argv.slice(2);
const LIST_MODE  = args.includes('--list');
const jdFlag     = args.indexOf('--jd');
const jdPath     = jdFlag !== -1 ? args[jdFlag + 1] : null;
const topFlag    = args.indexOf('--top');
const topRaw     = topFlag !== -1 ? parseInt(args[topFlag + 1], 10) : NaN;
const TOP_N      = Number.isInteger(topRaw) && topRaw > 0 ? topRaw : 1;
const excludeIdx = new Set([
  ...(jdFlag  !== -1 ? [jdFlag + 1]  : []),
  ...(topFlag !== -1 ? [topFlag + 1] : []),
]);
const question = args
  .filter((a, i) => !a.startsWith('--') && !excludeIdx.has(i))
  .join(' ').trim();

function tokenize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'you','me','my','your','i','we','they','it','is','was','were','are',
  'be','been','have','had','has','do','did','does','tell','about','time',
  'when','how','give','example','describe','situation','where','what',
]);

function score(story, queryTokens, jdTokens) {
  const signal = queryTokens.filter(t => !STOPWORDS.has(t));
  let s = 0;

  const tagTokens = new Set(story.tags.flatMap(tokenize));
  for (const token of signal) {
    if (tagTokens.has(token)) s += 3;
  }

  const titleTokens = tokenize(story.title + ' ' + story.theme);
  for (const token of signal) {
    if (titleTokens.includes(token)) s += 2;
  }

  const bodyTokens = tokenize(story.action + ' ' + story.result);
  for (const token of signal) {
    if (bodyTokens.includes(token)) s += 1;
  }

  if (jdTokens.length > 0) {
    const jdSignal = new Set(jdTokens.filter(t => !STOPWORDS.has(t)));
    for (const tag of story.tags) {
      const tagTokens = tokenize(tag);
      if (tagTokens.some(t => jdSignal.has(t))) s += 2;
    }
  }

  return s;
}

function formatAts(story, question) {
  const parts = [];

  if (story.situation) parts.push(story.situation);
  if (story.task)      parts.push(story.task);
  if (story.action)    parts.push(story.action);
  if (story.result)    parts.push(story.result);
  if (story.reflection) parts.push(story.reflection);

  const wordArr = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  const prose   = wordArr.slice(0, 500).join(' ');
  const words   = Math.min(wordArr.length, 500);
  const notice  = wordArr.length < 250
    ? '\n   ⚠️  Under 250 words — consider expanding this story in story-bank.md.'
    : '';

  return [
    `— ${story.title}${story.theme ? ` [${story.theme}]` : ''}`,
    story.source ? `   Source: ${story.source}` : '',
    story.tags.length ? `   Tags: ${story.tags.join(', ')}` : '',
    '',
    prose,
    '',
    `   (~${words} words)${notice}`,
  ].filter(s => s !== null).join('\n');
}

export { parseStories, tokenize, score, STOPWORDS };

if (isMainModule(import.meta.url)) {
if (!existsSync(STORY_BANK_PATH)) {
  console.error(`Error: ${STORY_BANK_PATH} not found.`);
  console.error('Run /career-ops interview-prep on a role first to populate your story bank.');
  process.exit(1);
}

const content = readFileSync(STORY_BANK_PATH, 'utf-8');
const stories = parseStories(content);

const { blocks, tableRows } = splitStoryBlocks(content);
const invalid = blocks.filter(b => !isValidStory(b));
if (tableRows.length || invalid.length) {
  console.error('⚠️  story-bank.md has entries this matcher cannot read:');
  if (tableRows.length) console.error(`   - ${tableRows.length} table row(s) (lines ${tableRows.map(r => r.line).join(', ')})`);
  for (const b of invalid) console.error(`   - "${b.title || '(untitled)'}" (line ${b.line}): no **A (Action):** line`);
  console.error('   Ask your agent to convert them to the format in templates/story-bank.template.md.\n');
}

if (stories.length === 0) {
  console.error('No stories found in story-bank.md yet.');
  console.error('Run /career-ops interview-prep on a role to add your first stories.');
  process.exit(1);
}

if (LIST_MODE) {
  console.log(`\nStory Bank — ${stories.length} stories\n${'─'.repeat(40)}`);
  stories.forEach((s, i) => {
    console.log(`${i + 1}. ${s.title}${s.theme ? ` [${s.theme}]` : ''}`);
    if (s.tags.length) console.log(`   Tags: ${s.tags.join(', ')}`);
    if (s.source)      console.log(`   ${s.source}`);
    console.log('');
  });
  process.exit(0);
}

if (!question) {
  console.error('Usage: node match-star.mjs "<behavioural question>" [--jd <file>] [--top <n>]');
  console.error('       node match-star.mjs --list');
  process.exit(1);
}

const queryTokens = tokenize(question);
let jdTokens = [];
if (jdPath) {
  if (!existsSync(jdPath)) {
    console.error(`Error: JD file not found at ${jdPath}`);
    process.exit(1);
  }
  jdTokens = tokenize(readFileSync(jdPath, 'utf-8'));
}

const ranked = stories
  .map(s => ({ story: s, score: score(s, queryTokens, jdTokens) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, TOP_N);

console.log(`\nATS Behavioural Question Matcher`);
console.log('─'.repeat(40));
console.log(`Question: "${question}"`);
if (jdPath) console.log(`JD:       ${jdPath}`);
console.log(`Stories:  ${stories.length} in bank\n`);

for (let i = 0; i < ranked.length; i++) {
  const { story, score: s } = ranked[i];
  console.log(`${'─'.repeat(40)}`);
  console.log(`Match ${i + 1} of ${ranked.length} (score: ${s})\n`);
  console.log(formatAts(story, question));
  console.log('');
}

if (ranked.length > 0 && ranked[0].score === 0) {
  console.log('⚠️  No strong match found. Consider adding a story to story-bank.md that covers this competency.');
}
}
