#!/usr/bin/env node
if (process.platform === 'win32') {
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
  } catch {
  }
}

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { TokenAccumulator, formatBreakdown } from './utils/token-tracker.mjs';
import {
  isPostingUrl, normalizedTrackerScore, slugifyCompany, tsvSafe,
} from './lib/tracker-addition.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');
import { execFileSync } from 'child_process';
import { outputLanguageInstruction, parseOutputLanguage } from './profile-language.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from './reserve-report-num.mjs';
import { buildBudgetedPrompt } from './lib/context-budget.mjs';
import * as yaml from 'js-yaml';

try {
  const { config } = await import('dotenv');
  config();
} catch {
}

import { GoogleGenerativeAI } from '@google/generative-ai';

import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { TSV_ADDITION_HEADER } from './tracker-parse.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

const PATHS = {
  shared:      join(CODE_ROOT, 'modes', '_shared.md'),
  oferta:      join(CODE_ROOT, 'modes', 'oferta.md'),
  evaluate:    join(CODE_ROOT, '.claude', 'skills', 'career-ops', 'SKILL.md'),
  cv:          join(DATA_ROOT, 'cv.md'),
  profile:     join(DATA_ROOT, 'modes', '_profile.md'),
  profileYml:  join(DATA_ROOT, 'config', 'profile.yml'),
  reports:     join(DATA_ROOT, 'reports'),
  tracker:     resolveTrackerPath(DATA_ROOT),
  trackerAdditions: join(DATA_ROOT, 'batch', 'tracker-additions'),
};

let modesDirs = ['modes'];
let evalFilename = 'oferta.md';

function stripBom(str) {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

function resolveModesDirCandidate(customModesDir) {
  if (typeof customModesDir !== 'string' || !customModesDir.trim()) return null;
  const dirPath = resolve(CODE_ROOT, customModesDir);
  const rel = relative(CODE_ROOT, dirPath);
  if (rel.startsWith('..') || isAbsolute(customModesDir)) {
    console.warn(`⚠️   modes_dir "${customModesDir}" escapes project root; skipping`);
    return null;
  }
  if (!existsSync(dirPath)) {
    console.warn(`⚠️   modes_dir "${customModesDir}" not found; skipping`);
    return null;
  }
  return customModesDir;
}

if (existsSync(PATHS.profileYml)) {
  try {
    const yamlContent = stripBom(readFileSync(PATHS.profileYml, 'utf-8'));
    const profile = yaml.load(yamlContent);
    const rawModesDir = profile && profile.language && profile.language.modes_dir;
    if (rawModesDir) {
      const candidates = Array.isArray(rawModesDir) ? rawModesDir : [rawModesDir];
      const primaryRaw = candidates[0];
      const primaryDir = resolveModesDirCandidate(primaryRaw);
      const candidateFiles = ['oferta.md', 'angebot.md', 'offre.md', 'fursah.md', 'kyujin.md', 'is-ilani.md', 'naukri.md'];
      const primaryEvalFile = primaryDir && candidateFiles.find((file) => existsSync(join(CODE_ROOT, primaryDir, file)));
      const extras = candidates.slice(1).map(resolveModesDirCandidate).filter(Boolean);
      if (primaryDir && primaryEvalFile) {
        modesDirs = [primaryDir, ...extras];
        evalFilename = primaryEvalFile;
      } else {
        if (primaryDir) {
          console.warn(`⚠️   No matching evaluation file found in ${primaryDir}; using default modes/oferta.md`);
        }
        modesDirs = ['modes', ...(primaryDir && primaryDir !== 'modes' ? [primaryDir] : []), ...extras.filter((dir) => dir !== 'modes' && dir !== primaryDir)];
      }
    }
  } catch (err) {
    console.warn(`⚠️   Could not parse config/profile.yml: ${err.message}`);
  }
}

const modesDir = modesDirs[0];
PATHS.shared = join(CODE_ROOT, modesDir, '_shared.md');
PATHS.oferta = join(CODE_ROOT, modesDir, evalFilename);
const extraModesDirs = modesDirs.slice(1);

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini Evaluator (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Google Gemini instead of Claude.

  USAGE
    node gemini-eval.mjs "<JD text>"
    node gemini-eval.mjs --file ./jds/my-job.txt
    node gemini-eval.mjs --model gemini-3.6-flash "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Gemini model to use (default: gemini-3.6-flash)
    --posting-url <url>  Posting URL, recorded in the report header and
                     used as the tracker's dedup key
    --no-save        Do not save report to reports/ directory
    --no-compress    Skip token budget compression (full context injection)
    --context-only   Print the resolved context/token budget and exit — never calls Gemini. Deterministic; used by automated tests to verify modes_dir resolution without live API calls.
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
    node gemini-eval.mjs --file ./jds/openai-swe.txt
    node gemini-eval.mjs --posting-url https://acme.com/jobs/42 --file ./jds/openai-swe.txt
    node gemini-eval.mjs --context-only --file ./jds/openai-swe.txt  # print context budget without calling Gemini
`);
  process.exit(0);
}

let jdText = '';
let postingUrl = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
let saveReport = true;
let noCompress = false;
let contextOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdText = stripBom(readFileSync(filePath, 'utf-8')).trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--posting-url' && args[i + 1]) {
    postingUrl = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--no-compress') {
    noCompress = true;
  } else if (args[i] === '--context-only') {
    contextOnly = true;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

if (postingUrl && !isPostingUrl(postingUrl)) {
  console.error(`❌  --posting-url must be a complete http(s) URL: "${postingUrl}"`);
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return stripBom(readFileSync(path, 'utf-8')).trim();
}

function validateEvaluationShape(text) {
  const issues = [];
  const requiredBlocks = [
    ['A', /(?:^|\n)#{1,3}\s*(?:A[).:-]?|Block A\b)/im],
    ['B', /(?:^|\n)#{1,3}\s*(?:B[).:-]?|Block B\b)/im],
    ['C', /(?:^|\n)#{1,3}\s*(?:C[).:-]?|Block C\b)/im],
    ['D', /(?:^|\n)#{1,3}\s*(?:D[).:-]?|Block D\b)/im],
    ['E', /(?:^|\n)#{1,3}\s*(?:E[).:-]?|Block E\b)/im],
    ['F', /(?:^|\n)#{1,3}\s*(?:F[).:-]?|Block F\b)/im],
    ['G', /(?:^|\n)#{1,3}\s*(?:G[).:-]?|Block G\b)/im],
  ];

  for (const [label, pattern] of requiredBlocks) {
    if (!pattern.test(text)) issues.push(`missing Block ${label}`);
  }

  const summary = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (!summary) {
    issues.push('missing SCORE_SUMMARY block');
  } else {
    const summaryBlock = summary[1];
    for (const key of ['COMPANY', 'ROLE', 'ARCHETYPE', 'LEGITIMACY']) {
      const field = summaryBlock.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'));
      const value = field?.[1]?.trim() ?? '';
      if (!value || (key !== 'COMPANY' && value.toLowerCase() === 'unknown')) {
        issues.push(`SCORE_SUMMARY ${key} is required`);
      }
    }

    const score = summaryBlock.match(/^\s*SCORE:\s*([0-9]+(?:\.[0-9]+)?)/mi);
    const scoreValue = score ? Number(score[1]) : NaN;
    if (!Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 5) {
      issues.push('SCORE_SUMMARY score must be a number between 0 and 5');
    }
  }

  if (issues.length > 0) {
    throw new Error(`Gemini returned an invalid career-ops report: ${issues.join('; ')}`);
  }
}

let readdirSync;
try {
  ({ readdirSync } = await import('fs'));
} catch { }
if (!readdirSync) {
  readdirSync = (await import('fs')).readdirSync;
}

console.log('\n📂  Loading context files...');

const sharedLabel = join(modesDir, '_shared.md').replace(/\\/g, '/');
const ofertaLabel = join(modesDir, evalFilename).replace(/\\/g, '/');
let sharedContext    = readFile(PATHS.shared,      sharedLabel);
const ofertaLogic    = readFile(PATHS.oferta,      ofertaLabel);

for (const extraDir of extraModesDirs) {
  const extraLabel = join(extraDir, '_shared.md').replace(/\\/g, '/');
  const extraContent = readFile(join(CODE_ROOT, extraDir, '_shared.md'), extraLabel);
  sharedContext += `\n\n--- Additional declared market: ${extraDir} (${extraLabel}) ---\n${extraContent}`;
}
const cvContent      = readFile(PATHS.cv,          'cv.md');
const profileContent = readFile(PATHS.profile,     'modes/_profile.md');
const profileYml     = readFile(PATHS.profileYml,  'config/profile.yml');
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

const { contextBody, budgetReport } = buildBudgetedPrompt({
  sharedContent: sharedContext,
  ofertaContent: ofertaLogic,
  cvContent,
  profileYml,
  profileContent,
  jdText,
  noCompress,
  maxTokens: 1_048_576,
});

if (contextOnly) {
  const resolvedEvalMode = relative(CODE_ROOT, PATHS.oferta).replaceAll('\\', '/');
  console.log(`🧭  Evaluation mode: ${resolvedEvalMode}`);
}

if (budgetReport.compressed) {
  console.log(`📊  Token budget: ${budgetReport.beforeTokens} → ${budgetReport.afterTokens} tokens (saved ${budgetReport.beforeTokens - budgetReport.afterTokens})`);
  console.log(`    Trimmed sections: ${budgetReport.removed.join(', ')}`);
  if (budgetReport.overBudget) {
    console.log(`    ⚠️  Still ${budgetReport.afterTokens - budgetReport.budget} tokens over budget after compression`);
  }
} else if (budgetReport.overBudget) {
  console.log(`⚠️  Token budget: ${budgetReport.totalTokens} tokens exceeds ${budgetReport.budget} limit by ${budgetReport.totalTokens - budgetReport.budget}`);
} else {
  console.log(`📊  Token budget: ${budgetReport.totalTokens} tokens (within ${budgetReport.budget} limit)`);
}

const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

${contextBody}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. ${languageInstruction}
3. Generate Blocks A through G in full.
4. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

if (!contextOnly) {

console.log(`🤖  Calling Gemini (${modelName})... this may take 30-60 seconds.\n`);

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  systemInstruction: systemPrompt,
  generationConfig: {
    temperature: 0.4,
    maxOutputTokens: 8192,
  },
});

let evaluationText;
try {
  const result = await model.generateContent(`JOB DESCRIPTION TO EVALUATE:\n\n${jdText}`);
  evaluationText = result.response.text();
  const usage = {
    prompt_tokens: result.response.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: result.response.usageMetadata?.totalTokenCount ?? 0,
    cached_tokens: result.response.usageMetadata?.cachedContentTokenCount ?? 0
  };
  tracker.record('evaluation', usage);
} catch (err) {
  const sanitizedMsg = (err.message || '').split(apiKey).join('[REDACTED]');
  console.error('❌  Gemini API error:', sanitizedMsg);
  if (sanitizedMsg.includes('API_KEY')) {
    console.error('    Check your GEMINI_API_KEY in .env');
  } else if (sanitizedMsg.includes('quota') || sanitizedMsg.includes('rate')) {
    console.error('    You may have hit the free-tier rate limit. Wait 60s and retry.');
  }
  process.exit(1);
}

try {
  validateEvaluationShape(evaluationText);
} catch (err) {
  console.error('❌  Gemini output failed validation:', err.message);
  console.error('    No report was saved. Retry, lower temperature, or use the Claude pipeline for this JD.');
  process.exit(1);
}

console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by Google Gemini');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const prefix = `${key}:`;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

if (saveReport) {
  let reportSaved = false;
  let reservedNumbers = [];
  try {
    try {
      if (!existsSync(PATHS.reports)) {
        mkdirSync(PATHS.reports, { recursive: true });
      }

      reservedNumbers   = await reserveReportNumbers(1, { rootDir: DATA_ROOT, reportsDir: PATHS.reports });
      const num         = formatReportNumber(reservedNumbers[0]);
      const today       = localToday();
      const companySlug = slugifyCompany(company);
      const filename    = `${num}-${companySlug}-${today}.md`;
      const reportPath  = join(PATHS.reports, filename);
      const trackerPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);

      const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**URL:** ${postingUrl || '(pasted)'}
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

      writeFileSync(reportPath, reportContent, 'utf-8');
      mkdirSync(PATHS.trackerAdditions, { recursive: true });
      const trackerFields = [
        String(parseInt(num, 10)),
        today,
        tsvSafe(company),
        tsvSafe(role),
        'Evaluated',
        normalizedTrackerScore(score),
        '❌',
        `[${num}](reports/${filename})`,
        'Gemini evaluation',
      ];
      const trackerHeader = postingUrl ? `${TSV_ADDITION_HEADER}\turl` : TSV_ADDITION_HEADER;
      if (postingUrl) trackerFields.push(tsvSafe(postingUrl));
      writeFileSync(trackerPath, `${trackerHeader}\n${trackerFields.join('\t')}\n`, 'utf-8');
      console.log(`\n✅  Report saved: reports/${filename}`);
      console.log(`📊  Tracker addition saved: batch/tracker-additions/${num}-${companySlug}.tsv`);
      reportSaved = true;
    } catch (err) {
      console.warn(`⚠️   Could not save report: ${err.message}`);
      process.exitCode = 1;
    }

    if (reportSaved) {
      try {
        const mergeOutput = execFileSync(process.execPath, [join(CODE_ROOT, 'merge-tracker.mjs')], {
          cwd: CODE_ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        });
        if (mergeOutput.trim()) console.log(mergeOutput.trim());
        console.log('📊  Tracker merged into data/applications.md.');
      } catch (err) {
        console.warn(`⚠️   Report saved, but could not merge tracker addition into data/applications.md: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    if (reservedNumbers.length > 0) {
      try {
        await releaseReportNumbers(reservedNumbers, { rootDir: DATA_ROOT, reportsDir: PATHS.reports });
      } catch (err) {
        console.warn(`⚠️   Could not release report reservation: ${err.message}`);
      }
    }
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'gemini'));
}
