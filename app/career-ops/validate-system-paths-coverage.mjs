#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { extractArrayFromSource, localUserPaths, LOCAL_PATHS_FILE } from './update-system.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(ROOT, 'update-system.mjs');

if (!existsSync(sourcePath)) {
  console.error('FAIL: update-system.mjs not found');
  process.exit(1);
}

const source = readFileSync(sourcePath, 'utf-8');

const SYSTEM_PATHS = extractArrayFromSource(source, 'SYSTEM_PATHS');
const USER_PATHS = extractArrayFromSource(source, 'USER_PATHS');

if (SYSTEM_PATHS.length === 0 || USER_PATHS.length === 0) {
  console.error('FAIL: SYSTEM_PATHS or USER_PATHS not found in update-system.mjs');
  process.exit(1);
}
let LOCAL_PATHS;
try {
  LOCAL_PATHS = localUserPaths(ROOT);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

const ALL_PATHS = [...SYSTEM_PATHS, ...USER_PATHS, ...LOCAL_PATHS];

const EXCLUDES = [
  '.coderabbit.yaml',
  '.editorconfig',
  '.envrc',
  '.npmignore',
  '.release-please-manifest.json',
  'release-please-config.json',
  'renovate.json',
  'flake.lock',
  'flake.nix',
  'batch/logs/.gitkeep',
  'batch/tracker-additions/.gitkeep',
  'interview-prep/.gitkeep',
  LOCAL_PATHS_FILE,
];

const RECONCILED_NOT_CHECKED_OUT = ['.gitignore'];

const REPO_ONLY = ['SIGNATURES.md'];

const EXCLUDE_PREFIXES = ['web/'];

function covered(file) {
  if (EXCLUDES.includes(file)) return true;
  if (RECONCILED_NOT_CHECKED_OUT.includes(file)) return true;
  if (REPO_ONLY.includes(file)) return true;
  if (EXCLUDE_PREFIXES.some((p) => file.startsWith(p))) return true;

  return ALL_PATHS.some((path) =>
    path.endsWith('/') ? file.startsWith(path) : file === path,
  );
}

function isUserLayerPlaceholder(file) {
  return file.endsWith('/.gitkeep') && USER_PATHS.some((path) =>
    path.endsWith('/') ? file.startsWith(path) : file === path,
  );
}

function hasExplicitPlaceholderPolicy(file) {
  return SYSTEM_PATHS.includes(file) || EXCLUDES.includes(file);
}

if (process.argv.includes('--self-test')) {
  console.log('Running validate-system-paths-coverage.mjs self-tests...');
  
  const assert = (condition, message) => {
    if (!condition) {
      console.error(`FAIL: ${message}`);
      process.exit(1);
    }
  };

  assert(covered('.gitignore') === true, '.gitignore must be covered (excluded)');
  assert(covered('.coderabbit.yaml') === true, '.coderabbit.yaml must be covered (excluded)');
  assert(covered('.editorconfig') === true, '.editorconfig must be covered (excluded, #1438/#1613)');
  assert(covered(LOCAL_PATHS_FILE) === true, 'the local-paths declaration file must be covered when a fork commits it (excluded, #2991)');
  assert(!EXCLUDES.includes('config/local-paths.example.txt'), 'the shipped example must NOT ride the exclude: it has to keep reaching installs');
  assert(SYSTEM_PATHS.includes('config/local-paths.example.txt'), 'the shipped example must stay in SYSTEM_PATHS (#2991)');
  assert(covered('config/local-paths.example.txt') === true, 'the shipped example must stay covered by SYSTEM_PATHS, not by the exclude');

  assert(covered('CLAUDE.md') === true, 'CLAUDE.md must be covered (exact match)');
  assert(covered('.claude/settings.json') === true, '.claude/settings.json must be covered (USER_PATHS exact match, #1408)');
  assert(covered('.claude/hooks/pre-push-backup.sh') === true, '.claude/hooks/ scripts must be covered (USER_PATHS dir prefix match, same class as #1408)');

  assert(covered('providers/justjoin.mjs') === true, 'providers/justjoin.mjs must be covered (dir prefix match)');

  assert(covered('providers-sibling/justjoin.mjs') === false, 'providers-sibling/justjoin.mjs must NOT be covered');
  assert(covered('web/package.json') === true, 'web/ tree must be covered (isolation-contract prefix exclude)');
  assert(covered('web-dashboard/index.html') === false, 'web-dashboard/ must NOT ride the web/ prefix exclude');
  assert(covered('.npmignore') === true, '.npmignore must be covered (excluded)');
  assert(covered('SIGNATURES.md') === true, 'SIGNATURES.md must be covered (repo-only exclude, #4062)');
  assert(!SYSTEM_PATHS.includes('SIGNATURES.md'), 'SIGNATURES.md must NOT re-enter SYSTEM_PATHS: its churn reads as system-files-changed drift on every install (#4062)');

  assert(covered('data/new-subdir/.gitkeep') === true, 'a nested placeholder is covered by USER_PATHS');
  assert(isUserLayerPlaceholder('data/new-subdir/.gitkeep'), 'a nested placeholder is a user-layer placeholder');
  assert(!hasExplicitPlaceholderPolicy('data/new-subdir/.gitkeep'), 'a USER_PATHS prefix alone must not count as an explicit placeholder policy');
  assert(hasExplicitPlaceholderPolicy('data/.gitkeep'), 'data/.gitkeep must have an explicit ship-or-exclude policy');
  assert(hasExplicitPlaceholderPolicy('interview-prep/.gitkeep'), 'interview-prep/.gitkeep must have an explicit ship-or-exclude policy');

  assert(covered('untracked-orphan-file-xyz.js') === false, 'untracked-orphan-file-xyz.js must NOT be covered');

  console.log('ALL SELF-TESTS PASSED');
  process.exit(0);
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error('FAIL: git ls-files failed:', err.message);
  process.exit(1);
}

if (tracked.length === 0) {
  console.error('FAIL: git ls-files returned no paths — this run could not inspect anything.');
  console.error('');
  console.error('Run this from the repository root. An empty listing usually means the');
  console.error('script was invoked from an untracked directory (a temp copy, a fixture');
  console.error('dir), where git reports nothing and the coverage check is meaningless.');
  process.exit(1);
}

const orphans = tracked.filter((f) => !covered(f));
const placeholderGaps = tracked.filter((f) => isUserLayerPlaceholder(f) && !hasExplicitPlaceholderPolicy(f));

if (placeholderGaps.length > 0) {
  console.error('Coverage gap — tracked .gitkeep placeholders under USER_PATHS need an exact SYSTEM_PATHS entry (ship) or EXCLUDES entry (repo-only):');
  for (const path of placeholderGaps) console.error(`  ${path}`);
  process.exit(1);
}

if (orphans.length > 0) {
  console.error('Coverage gap — tracked files not in SYSTEM_PATHS or USER_PATHS:');
  for (const orphan of orphans) console.error(`  ${orphan}`);
  console.error('');
  console.error('Add each path to update-system.mjs SYSTEM_PATHS (if system layer)');
  console.error('or USER_PATHS (if user-owned), then re-run this check.');
  process.exit(1);
}

console.log(`OK: ${tracked.length} tracked files covered by SYSTEM_PATHS or USER_PATHS`);
process.exit(0);
