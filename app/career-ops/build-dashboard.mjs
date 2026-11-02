#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = process.platform === 'win32' ? 'career-dashboard.exe' : 'career-dashboard';

const result = spawnSync('go', ['build', '-o', out, '.'], {
  cwd: join(root, 'dashboard'),
  stdio: 'inherit',
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('Go toolchain not found. Install Go 1.24+ from https://go.dev/dl/ and retry.');
  } else {
    console.error(`Build failed to start: ${result.error.message}`);
  }
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built dashboard/${out} — run it with: npm run serve:dashboard (or dashboard/${out} --path .)`);
