#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const batchStateFile = process.env.CAREER_OPS_BATCH_STATE
  ? resolve(process.env.CAREER_OPS_BATCH_STATE)
  : join(__dirname, 'batch', 'batch-state.tsv');
const reportsDir = join(getCareerOpsRoot(), 'reports');

const USAGE = `career-ops batch tailor — bulk generate tailored CVs for high-scoring batch jobs

Usage:
  node batch-tailor.mjs [--min-score N]

Options:
  --min-score N   Minimum score to tailor (default: 4.0). The --min-score=N form works too.
  --help, -h      Show this help
`;

const args = process.argv.slice(2);

validateFlags(args, ['--min-score', '--help', '-h'], USAGE, { valueFlags: ['--min-score'], requireOperand: true });

let minScore = 4.0;
if (hasFlag(args, '--min-score')) {
  const raw = flagValue(args, '--min-score');
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  minScore = trimmed === '' ? NaN : Number(trimmed);
  if (!Number.isFinite(minScore)) {
    console.error(`ERROR: --min-score expects a number, got ${raw === undefined ? '(no value)' : `"${raw}"`}`);
    process.exit(1);
  }
}

if (!existsSync(batchStateFile)) {
  console.error(`ERROR: Batch state file not found at ${batchStateFile}`);
  process.exit(1);
}

let stateContent;
try {
  stateContent = readFileSync(batchStateFile, 'utf-8');
} catch (err) {
  console.error(`ERROR: cannot read batch state file at ${batchStateFile}: ${err.message}`);
  process.exit(1);
}

const lines = stateContent.split('\n');
const toProcess = [];

for (const line of lines) {
  if (!line || line.startsWith('id\t')) continue;
  const parts = line.split('\t');
  if (parts.length < 7) continue;
  
  const id = parts[0];
  const url = parts[1];
  const status = parts[2];
  const reportNum = parts[5];
  const scoreStr = parts[6];
  
  if (status === 'completed') {
    const score = parseFloat(scoreStr);
    if (!isNaN(score) && score >= minScore) {
      toProcess.push({ id, url, reportNum, score });
    }
  }
}

if (toProcess.length === 0) {
  console.log(`No completed roles found with score >= ${minScore}.`);
  process.exit(0);
}

console.log(`Found ${toProcess.length} roles scoring >= ${minScore}. Beginning bulk tailoring...`);

const reports = existsSync(reportsDir) ? readdirSync(reportsDir) : [];

for (let i = 0; i < toProcess.length; i++) {
  const job = toProcess[i];
  console.log(`\n[${i + 1}/${toProcess.length}] Tailoring CV for Report ${job.reportNum} (Score: ${job.score}) — ${job.url}`);
  
  const matchingReport = reports.find(f => f.startsWith(`${job.reportNum}-`) && f.endsWith('.md'));
  const reportPath = matchingReport ? join(reportsDir, matchingReport) : null;
  if (reportPath) console.log(`  Report: ${reportPath}`);
  const reportContext = reportPath ? `\nThe evaluation report is available at: ${reportPath}` : '';
  
  const prompt = `Tailor the CV for this role and generate the HTML and PDF CVs. \nURL: ${job.url}\nReport number: ${job.reportNum}${reportContext}`;
  
  const claudeArgs = [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    join(__dirname, 'modes', 'pdf.md'),
    prompt
  ];
  
  const res = spawnSync('claude', claudeArgs, { stdio: 'inherit' });
  if (res.error) {
    console.error(`Error running claude: ${res.error.message}`);
  } else if (res.status !== 0) {
    console.error(`Worker exited with status ${res.status}`);
  } else {
    console.log(`✅ Finished tailoring for Report ${job.reportNum}`);
  }
}

console.log('\nBulk tailoring complete.');
