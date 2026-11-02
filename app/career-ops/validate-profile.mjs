#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

export const EXAMPLE_PATH = join(CODE_ROOT, 'config', 'profile.example.yml');
export const DEFAULT_PROFILE_PATH = process.env.CAREER_OPS_PROFILE
  || join(DATA_ROOT, 'config', 'profile.yml');

export const UNDOCUMENTED_KEYS = {
  rejection_latency: 'rejection-latency.mjs (courtesy_days)',
  table_freshness: 'check-table-freshness.mjs (max_age_months)',
};

export function knownKeysFromExample(exampleText) {
  const text = String(exampleText ?? '');
  const doc = yaml.load(text) || {};
  if (typeof doc !== 'object' || Array.isArray(doc)) return [];
  const commented = [...text.matchAll(/^# ([a-z][a-z0-9_]*):(?=\s|$)/gm)].map((m) => m[1]);
  return [...new Set([...Object.keys(doc), ...commented])];
}

export function nearestKey(key, candidates, maxDistance = 3) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxDistance ? best : null;
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function validateProfile(profileText, exampleText) {
  const findings = [];
  const hasContent = String(profileText ?? '').split('\n').some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (!hasContent) return { parsed: null, findings };

  let parsed;
  try {
    parsed = yaml.load(String(profileText ?? ''));
  } catch (err) {
    return {
      parsed: null,
      findings: [{
        level: 'error',
        code: 'unparseable',
        message: `config/profile.yml is not valid YAML: ${String(err.message).split('\n')[0]}`,
      }],
    };
  }
  if (parsed == null) return { parsed: null, findings };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      parsed: null,
      findings: [{ level: 'error', code: 'not-a-mapping', message: 'config/profile.yml does not contain a YAML mapping.' }],
    };
  }

  const documented = knownKeysFromExample(exampleText);
  const known = new Set([...documented, ...Object.keys(UNDOCUMENTED_KEYS)]);

  for (const key of Object.keys(parsed)) {
    if (known.has(key)) continue;
    const suggestion = nearestKey(key, [...known]);
    findings.push({
      level: 'warn',
      code: 'unknown-key',
      key,
      suggestion,
      message: suggestion
        ? `Unknown top-level key "${key}" — did you mean "${suggestion}"? It is being ignored, so whatever you set under it has no effect.`
        : `Unknown top-level key "${key}". It is being ignored, so whatever you set under it has no effect.`,
    });
  }

  for (const [key, reader] of Object.entries(UNDOCUMENTED_KEYS)) {
    if (key in parsed && !documented.includes(key)) {
      findings.push({
        level: 'info',
        code: 'undocumented-key',
        key,
        message: `"${key}" is read by ${reader} but is not in config/profile.example.yml, so it is undiscoverable.`,
      });
    }
  }

  return { parsed, findings };
}

function runSelfTest() {
  let pass = 0; let fail = 0;
  const check = (cond, label) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${label}`); } };
  const EXAMPLE = 'candidate:\n  full_name: x\nlanguage:\n  output: en\nspend_tier: standard\ncv:\n  output_format: html\n';

  const typo = validateProfile('langauge:\n  output: ja\nspend_teir: premium\n', EXAMPLE);
  check(typo.findings.filter(f => f.code === 'unknown-key').length === 2, 'two typo keys are reported');
  check(typo.findings.some(f => f.key === 'langauge' && f.suggestion === 'language'), 'langauge suggests language');
  check(typo.findings.some(f => f.key === 'spend_teir' && f.suggestion === 'spend_tier'), 'spend_teir suggests spend_tier');

  const clean = validateProfile('candidate:\n  full_name: x\nlanguage:\n  output: ja\n', EXAMPLE);
  check(clean.findings.length === 0, 'a correct profile produces no findings');

  const extra = validateProfile('rejection_latency:\n  courtesy_days: 45\n', EXAMPLE);
  check(extra.findings.every(f => f.code !== 'unknown-key'), 'a code-read key is not reported as unknown');
  check(extra.findings.some(f => f.code === 'undocumented-key'), 'and its absence from the example is reported');

  check(validateProfile('', EXAMPLE).findings.length === 0, 'an empty profile is not an error');
  check(validateProfile('# just a comment\n', EXAMPLE).findings.length === 0, 'a comment-only profile is not an error');
  check(validateProfile('\tbroken: tab\n', EXAMPLE).findings[0]?.code === 'unparseable', 'malformed YAML is reported as unparseable');
  check(validateProfile('just a string\n', EXAMPLE).findings[0]?.code === 'not-a-mapping', 'a scalar profile is reported');

  const widened = validateProfile('brand_new_section:\n  x: 1\n', `${EXAMPLE}brand_new_section:\n  x: 0\n`);
  check(widened.findings.length === 0, 'a key added to the example is understood without editing this file');

  const COMMENTED = `${EXAMPLE}# Paper size: "letter" or "a4".\n# page_format: letter\n# style:\n#   accent_color: "#2563eb"\n`;
  check(validateProfile('page_format: a4\nstyle:\n  accent_color: "#000"\n', COMMENTED).findings.length === 0, 'a key the example ships commented out is known');
  check(knownKeysFromExample(COMMENTED).join() === 'candidate,language,spend_tier,cv,page_format,style', 'prose and nested commented keys are not top-level keys');
  check(validateProfile('styel:\n  x: 1\n', COMMENTED).findings[0]?.suggestion === 'style', 'a typo of a commented key gets its suggestion');

  console.log(`\n  validate-profile self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) runSelfTest();
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node validate-profile.mjs [--profile <path>] [--json] [--self-test]');
    process.exit(0);
  }
  const pi = args.indexOf('--profile');
  const profilePath = pi !== -1 && args[pi + 1] ? args[pi + 1] : DEFAULT_PROFILE_PATH;
  if (!existsSync(profilePath)) {
    console.log(`No profile at ${profilePath} — nothing to validate.`);
    process.exit(0);
  }
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, 'utf-8') : '';
  const { findings } = validateProfile(readFileSync(profilePath, 'utf-8'), example);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ profile: profilePath, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`✓ ${profilePath}: no structural problems.`);
  } else {
    for (const f of findings) console.log(`  ${f.level === 'error' ? '✗' : '⚠'} ${f.message}`);
  }
  process.exit(findings.some(f => f.code === 'unparseable' || f.code === 'not-a-mapping') ? 2 : 0);
}
