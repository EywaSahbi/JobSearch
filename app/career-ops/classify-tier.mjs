#!/usr/bin/env node

import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export function classifyTier(title) {
  if (typeof title !== 'string') {
    return 'mid';
  }

  let cleanTitle = title
    .replace(/\bA\.I\./ig, 'AI')
    .replace(/\bA\.I\b/ig, 'AI')
    .replace(/\bA\.\s+I\b/ig, 'AI')
    .replace(/\bI\.T\./ig, 'IT')
    .replace(/\bI\.T\b/ig, 'IT')
    .replace(/\bI\.\s+T\b/ig, 'IT')
    .replace(/\bi\/o\b/ig, 'IO');

  const matchers = [
    { pattern: /\bchief\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bvp\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bvice\s+president\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bdirector\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bprincipal\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bstaff\b/i, tier: 'senior', weight: 4 },
    { pattern: /\blead\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsenior\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsr\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsr\./i, tier: 'senior', weight: 4 },
    { pattern: /\bhead\s+of\b/i, tier: 'senior', weight: 4 },
    { pattern: /\b[a-z]{2,}[\s-](iii|iv|v)\b/i, tier: 'senior', weight: 4 },

    { pattern: /\bmid-level\b/i, tier: 'mid', weight: 3 },
    { pattern: /\bmid\b/i, tier: 'mid', weight: 3 },
    { pattern: /\b[a-z]{2,}[\s-](ii)\b/i, tier: 'mid', weight: 3 },
    { pattern: /\b(l4|l5)\b/i, tier: 'mid', weight: 3 },

    { pattern: /\bentry-level\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bentry\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bassociate\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bjunior\b/i, tier: 'entry', weight: 2 },
    { pattern: /\b[a-z]{2,}[\s-](i)\b/i, tier: 'entry', weight: 2 },
    { pattern: /\b(l1|l2)\b/i, tier: 'entry', weight: 2 },

    { pattern: /\binternship\b/i, tier: 'intern', weight: 1 },
    { pattern: /\bintern\b/i, tier: 'intern', weight: 1 },
    { pattern: /\btrainee\b/i, tier: 'intern', weight: 1 },
    { pattern: /\bco-op\b/i, tier: 'intern', weight: 1 },
    {
      pattern: {
        test: (t) => /\bgraduate\b/i.test(t) && /\b(program|scheme)\b/i.test(t),
        levelWordIndex: (t) => t.search(/\bgraduate\b/i)
      },
      tier: 'intern',
      weight: 1
    }
  ];

  const associateAt = cleanTitle.search(/\bassociate\b/i);
  if (associateAt >= 0) {
    const juniorAt = cleanTitle.search(/\b(?:intern(?:ship)?|trainee|co-op|graduate|junior|entry(?:-level)?)\b/i);
    if (juniorAt < 0 || juniorAt > associateAt) {
      const afterAssociate = cleanTitle.slice(associateAt + 'associate'.length);
      if (/^\s+(?:[a-z]+\s+){0,2}(director|vice\s+president|vp|principal|partner|chief|head\s+of|professor|dean|provost|chancellor|superintendent|general\s+counsel)\b/i.test(afterAssociate)) {
        return 'senior';
      }
    }
  }

  const programBridge = /\b(?:intern(?:ship)?|trainee|co-op|graduate|junior|entry(?:-level)?)\s+(?:program|scheme|talent|cohort)\b/i;
  if (programBridge.test(cleanTitle)) {
    const afterBridge = cleanTitle.replace(programBridge, ' ').trim();
    if (/\b(chief|vp|vice\s+president|director|principal|staff|lead|senior|sr\.?|head\s+of|partner)\b/i.test(afterBridge)) {
      return 'senior';
    }
  }

  let bestMatch = null;
  let bestIndex = Infinity;

  for (const matcher of matchers) {
    if (!matcher.pattern.test(cleanTitle)) continue;
    const index = typeof matcher.pattern.levelWordIndex === 'function'
      ? matcher.pattern.levelWordIndex(cleanTitle)
      : cleanTitle.search(matcher.pattern);
    if (index < 0) continue;
    if (index < bestIndex || (index === bestIndex && matcher.weight > bestMatch.weight)) {
      bestMatch = matcher;
      bestIndex = index;
    }
  }

  return bestMatch ? bestMatch.tier : 'mid';
}

export default classifyTier;

const isDirect = isMainModule(import.meta.url);

const KNOWN_FLAGS = ['--test', '--help', '-h'];

const USAGE = `Usage:
  node classify-tier.mjs "<job-title>"   # print the seniority tier
  node classify-tier.mjs --test          # run the inline test cases
  node classify-tier.mjs --help          # show this message

Tiers: intern, entry, mid, senior. Defaults to mid when no keyword matches.`;

if (isDirect) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE);
  if (args.includes('--test')) {
    runTests();
  } else if (args.length > 0) {
    console.log(classifyTier(args[0]));
  } else {
    console.log(USAGE);
  }
}

function runTests() {
  const testCases = [
    { title: "Software Engineer Intern", expected: "intern" },
    { title: "Junior Software Engineer", expected: "entry" },
    { title: "Software Engineer I", expected: "entry" },
    { title: "Software Engineer II", expected: "mid" },
    { title: "Senior Software Engineer", expected: "senior" },
    { title: "Staff Engineer", expected: "senior" },
    { title: "Principal Engineer", expected: "senior" },
    { title: "VP of Engineering", expected: "senior" },
    { title: "Engineering Intern Program", expected: "intern" },
    { title: "Software Engineer", expected: "mid" },
    { title: "Senior Intern Coordinator", expected: "senior" },
    { title: "Graduate Engineer", expected: "mid" },
    { title: "Graduate Engineer Program", expected: "intern" },
    { title: "A.I. Researcher", expected: "mid" },
    { title: "I.T. Specialist II", expected: "mid" }
  ];

  let failed = 0;
  console.log("Running classify-tier.mjs tests...");
  for (const { title, expected } of testCases) {
    const result = classifyTier(title);
    if (result === expected) {
      console.log(`✅ [PASS] "${title}" -> ${result}`);
    } else {
      console.error(`❌ [FAIL] "${title}": expected ${expected}, got ${result}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\nTest run failed: ${failed} failure(s)`);
    process.exit(1);
  } else {
    console.log("\nAll tests passed successfully!");
    process.exit(0);
  }
}
