import { execFileSync } from 'child_process';
import { existsSync, lstatSync, readdirSync } from 'fs';
import { join } from 'path';
import { isScratchDir } from './scratch-dirs.mjs';

const UNSTATTABLE_SKIP_CODES = new Set(['ENOTDIR', 'EACCES']);

export function trackedFiles(root, filter = () => true) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const listed = [...new Set(out.split('\0').filter(Boolean))];

  if (listed.length === 0) {
    throw new Error(
      `git ls-files listed no tracked files under ${root} — this scan could not inspect anything. ` +
        'An empty listing usually means the caller is running from an untracked directory ' +
        '(a temp copy, a fixture dir), where git reports nothing and the guard is meaningless.',
    );
  }

  const files = [];
  const skipped = [];
  for (const rel of listed) {
    if (!filter(rel)) continue;
    let stat;
    try {
      stat = lstatSync(join(root, rel), { throwIfNoEntry: false });
    } catch (err) {
      if (!UNSTATTABLE_SKIP_CODES.has(err.code)) throw err;
      skipped.push(`${rel} (${err.code})`);
      continue;
    }
    if (stat?.isFile()) {
      files.push(join(root, rel));
      continue;
    }
    const why = stat === undefined ? 'not in the working tree'
      : stat.isSymbolicLink() ? 'a symlink'
        : 'not a regular file';
    skipped.push(`${rel} (${why})`);
  }

  if (skipped.length > 0) {
    console.warn(
      `warning: skipped ${skipped.length} tracked path(s) that are not readable regular files ` +
        `(unresolved merge, sparse checkout, submodule, symlink): ${skipped.join(', ')}`,
    );
  }

  return files.sort();
}

export const SKIP_DIRS = new Set(['.git', 'node_modules', 'output', 'data', 'coverage', 'test-results']);

export function isNestedCheckout(dir) {
  return existsSync(join(dir, '.git'));
}

export function isUnderNestedCheckout(root, relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    if (isNestedCheckout(dir)) return true;
  }
  return false;
}

export function collectMjsFiles(root) {
  const files = [];

  const walk = (dir, isRoot) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' && !isRoot) return;
      throw err;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory() && isScratchDir(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isNestedCheckout(full)) continue;
        walk(full, false);
      } else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(root, true);
  return files.sort();
}
