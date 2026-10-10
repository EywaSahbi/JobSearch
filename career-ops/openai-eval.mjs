#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { TSV_ADDITION_HEADER } from './tracker-parse.mjs';
import { outputLanguageInstruction, parseOutputLanguage } from './profile-language.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from './reserve-report-num.mjs';
import { TokenAccumulator, formatBreakdown, normalizeOpenAIUsage } from './utils/token-tracker.mjs';
import { buildBudgetedPrompt } from './lib/context-budget.mjs';
import {
  isPostingUrl, normalizedTrackerScore, slugifyCompany, tsvSafe,
} from './lib/tracker-addition.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');

try {
  const { config } = await import('dotenv');
  config();
} catch { }

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  oferta:  join(ROOT, 'modes', 'oferta.md'),
  cv:        join(DATA_ROOT, 'cv.md'),
  profileYml: join(DATA_ROOT, 'config', 'profile.yml'),
  reports:    join(DATA_ROOT, 'reports'),
  trackerAdditions: process.env.CAREER_OPS_ADDITIONS
    ? process.env.CAREER_OPS_ADDITIONS
    : join(DATA_ROOT, 'batch', 'tracker-additions'),
};

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║       career-ops — OpenAI-compatible Evaluator (any endpoint)     ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer with any OpenAI-compatible chat API instead of Claude.

  USAGE
    node openai-eval.mjs "<JD text>"
    node openai-eval.mjs --file ./jds/my-job.txt
    node openai-eval.mjs --url <base> --model <id> --file ./jds/job.txt

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <id>     Model id            (env OPENAI_MODEL, default gpt-4o-mini)
    --url <base>     OpenAI-compatible base URL, including any /v1
                     (env OPENAI_BASE_URL, default https://api.openai.com/v1)
    --key <key>      API key             (env OPENAI_API_KEY)
    --posting-url <url>  Posting URL, recorded in the report header and
                     used as the tracker's dedup key
    --no-save        Do not save report to reports/ directory
    --no-compress    Skip token budget compression (full context injection)
    --help           Show this help

  ENV
    OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_TIMEOUT_MS

  PROVIDER EXAMPLES (cheap / free-tier friendly — addresses token cost)
    OpenRouter:  --url https://openrouter.ai/api/v1   --model deepseek/deepseek-chat
    Requesty:    --url https://router.requesty.ai/v1  --model deepseek/deepseek-chat
    Cheaper Inference: --url https://api.cheaperinference.com/v1  --model gpt-5.4-mini
    API Route:   --url https://global.api-route.com/v1  --model gpt-5.5
    Together:    --url https://api.together.xyz/v1     --model meta-llama/Llama-3.3-70B-Instruct-Turbo
    Groq:        --url https://api.groq.com/openai/v1  --model llama-3.3-70b-versatile
    DeepSeek:    --url https://api.deepseek.com/v1     --model deepseek-chat
    Zhipu GLM:   --url https://open.bigmodel.cn/api/paas/v4  --model glm-4-flash
    LM Studio:   --url http://localhost:1234/v1        --model <loaded-model>   (no key)

  EXAMPLES
    OPENAI_API_KEY=sk-... node openai-eval.mjs --file ./jds/job.txt
    node openai-eval.mjs --url http://localhost:1234/v1 --model local "<JD text>"
`);
  process.exit(0);
}

let jdText     = '';
let postingUrl = '';
let modelName  = process.env.OPENAI_MODEL || 'gpt-4o-mini';
let baseUrl    = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
let apiKey     = process.env.OPENAI_API_KEY || '';
let saveReport = true;
let noCompress = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    try {
      jdText = readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
      console.error(`❌  Could not read file: ${filePath}`);
      console.error(`    ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--url' && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, '');
  } else if (args[i] === '--key' && args[i + 1]) {
    apiKey = args[++i];
  } else if (args[i] === '--posting-url' && args[i + 1]) {
    postingUrl = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--no-compress') {
    noCompress = true;
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

let endpointHost;
{
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`❌  Invalid OPENAI_BASE_URL: "${baseUrl}"`);
    process.exit(1);
  }
  endpointHost = parsed.hostname;
  const isLoopback = endpointHost === 'localhost' || endpointHost === '127.0.0.1' || endpointHost === '::1';

  if (!isLoopback && parsed.protocol !== 'https:') {
    console.error(`
❌  Refusing to use a non-HTTPS remote endpoint: ${baseUrl}

   Your CV, the job description, and your API key would be sent in cleartext.
   Use an https:// endpoint, or http://localhost:... for a local server.
`);
    process.exit(1);
  }

  if (!isLoopback && !apiKey) {
    console.error(`
❌  No API key for ${endpointHost}.

   Set one and re-run:
     OPENAI_API_KEY=your_key node openai-eval.mjs ...
   or pass --key <key>. (Local servers at localhost may not need one.)
`);
    process.exit(1);
  }
}

const endpoint = `${baseUrl}/chat/completions`;

function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

console.log('\n📂  Loading context files...');

const sharedContext = readFile(PATHS.shared,     'modes/_shared.md');
const ofertaLogic   = readFile(PATHS.oferta,     'modes/oferta.md');
const cvContent     = readFile(PATHS.cv,         'cv.md');
const profileYml    = readFile(PATHS.profileYml, 'config/profile.yml');
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

const { contextBody, budgetReport } = buildBudgetedPrompt({
  sharedContent: sharedContext,
  ofertaContent: ofertaLogic,
  cvContent,
  profileYml,
  jdText,
  noCompress,
  modelName,
});

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
IMPORTANT OPERATING RULES FOR THIS SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - Block D (Comp research): use training-data salary estimates; note them as estimates.
   - Block G (Legitimacy): analyze JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. ${languageInstruction}
3. Generate Blocks A through G in full.
4. At the very end, output this exact machine-readable block:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

export function buildSystemMessage(prompt, host) {
  if (host === 'api.openai.com') return { role: 'system', content: prompt };
  return {
    role: 'system',
    content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
  };
}

const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '300000', 10);
if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
  console.error(`❌  Invalid OPENAI_TIMEOUT_MS: "${process.env.OPENAI_TIMEOUT_MS}" — must be a positive integer (milliseconds).`);
  process.exit(1);
}

console.log(`\n🔒  Privacy: your cv.md + JD will be sent to ${endpointHost}.`);
console.log(`🤖  Calling ${modelName} via ${endpointHost}... this may take a minute.\n`);

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

let evaluationText;
try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model:    modelName,
      messages: [
        buildSystemMessage(systemPrompt, endpointHost),
        { role: 'user', content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ],
      stream:      true,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌  API error: HTTP ${res.status}`);
    console.error(`    ${body.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) {
      console.error(`    → Check your API key for ${endpointHost}.`);
    } else if (res.status === 404) {
      console.error(`    → Check --url (it should include any /v1 segment) and --model id.`);
    }
    process.exit(1);
  }

  const parts = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  let thinkOpen = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = sseBuf.indexOf('\n')) >= 0) {
      const line = sseBuf.slice(0, nl).trim();
      sseBuf = sseBuf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let delta;
      try { delta = JSON.parse(payload); } catch { continue; }
      const d = delta.choices?.[0]?.delta ?? {};
      if (d.reasoning_content) {
        if (!thinkOpen) { parts.push('\n<think>\n'); thinkOpen = true; }
        parts.push(d.reasoning_content);
      } else {
        if (thinkOpen) { parts.push('\n</think>\n\n'); thinkOpen = false; }
        if (d.content) parts.push(d.content);
      }
    }
  }
  if (thinkOpen) parts.push('\n</think>\n');
  evaluationText = parts.join('').trim();
  if (!evaluationText) {
    console.error('❌  The endpoint returned an empty response.');
    process.exit(1);
  }
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    console.error(`    Try a smaller/faster model, or increase OPENAI_TIMEOUT_MS.`);
  } else {
    console.error(`❌  API call failed: ${err.message}`);
  }
  process.exit(1);
}

console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by ' + modelName + ' (' + endpointHost + ')');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const extract = (key) => {
    const m = summaryMatch[1].match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

if (saveReport) {
  let reservedNumbers = [];
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    reservedNumbers   = await reserveReportNumbers(1, { rootDir: ROOT, reportsDir: PATHS.reports });
    const num         = formatReportNumber(reservedNumbers[0]);
    const today       = localToday();
    const companySlug = slugifyCompany(company);
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**URL:** ${postingUrl || '(pasted)'}
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** OpenAI-compatible (${modelName} @ ${endpointHost})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);

    const additionName = `${num}-${companySlug}.tsv`;
    const trackerFields = [
      String(parseInt(num, 10)),
      today,
      tsvSafe(company),
      tsvSafe(role),
      'Evaluated',
      normalizedTrackerScore(score),
      '❌',
      `[${num}](reports/${filename})`,
      tsvSafe(`OpenAI-compatible evaluation (${modelName})`),
    ];
    if (postingUrl) trackerFields.push(tsvSafe(postingUrl));
    const additionHeader = postingUrl ? `${TSV_ADDITION_HEADER}\turl` : TSV_ADDITION_HEADER;
    mkdirSync(PATHS.trackerAdditions, { recursive: true });
    writeFileSync(
      join(PATHS.trackerAdditions, additionName),
      `${additionHeader}\n${trackerFields.join('\t')}\n`,
      'utf-8',
    );
    console.log(`\n📊  Tracker addition saved: batch/tracker-additions/${additionName}`);
    console.log('    Run `node merge-tracker.mjs` to merge it into the tracker.');
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  } finally {
    if (reservedNumbers.length > 0) {
      try {
        await releaseReportNumbers(reservedNumbers, { reportsDir: PATHS.reports });
      } catch (err) {
        console.warn(`⚠️   Could not release report reservation: ${err.message}`);
      }
    }
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'openai'));
