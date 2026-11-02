#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { collectMjsFiles } from '../lib/mjs-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = collectMjsFiles(root);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${file.slice(root.length + 1)}`);
    console.error(String(err.stderr || err.message).trim());
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check.`);
  process.exit(1);
}

console.log(`✓ ${files.length} .mjs files passed syntax check.`);
