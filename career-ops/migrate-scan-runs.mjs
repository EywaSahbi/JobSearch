#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { SCAN_RUNS_HEADER, atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';

export const CURRENT_COLUMNS = SCAN_RUNS_HEADER.trim().split('\t');

const GEN_14 = ['timestamp', 'status', 'companies', 'boards', 'found', 'filtered_title',
  'filtered_tier', 'filtered_location', 'filtered_salary', 'filtered_content',
  'filtered_cooldown', 'dupes', 'new_added', 'errors'];

export function schemasByWidth() {
  const byWidth = new Map([[GEN_14.length, GEN_14]]);
  for (let n = GEN_14.length + 1; n <= CURRENT_COLUMNS.length; n++) {
    byWidth.set(n, CURRENT_COLUMNS.slice(0, n));
  }
  return byWidth;
}

export function migrateScanRuns(text) {
  const raw = String(text ?? '');
  const unchanged = (refused = null) => ({
    text: raw, changed: false, headerMigrated: false, migratedRows: 0, passedThrough: 0, refused,
  });
  if (!raw.trim()) return unchanged('empty file');

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  if (!lines[0].split('\t').includes('timestamp')) return unchanged('first line is not a header');

  const byWidth = schemasByWidth();
  const currentLine = CURRENT_COLUMNS.join('\t');
  const out = [currentLine];
  let migratedRows = 0;
  let passedThrough = 0;

  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (!line.trim() || cells.length === CURRENT_COLUMNS.length) { out.push(line); continue; }
    const schema = byWidth.get(cells.length);
    if (!schema) { out.push(line); passedThrough++; continue; }
    const byName = new Map(schema.map((name, i) => [name, cells[i]]));
    out.push(CURRENT_COLUMNS.map((name) => byName.get(name) ?? '').join('\t'));
    migratedRows++;
  }

  const migrated = out.join('\n') + (endsWithNewline ? '\n' : '');
  return {
    text: migrated,
    changed: migrated !== raw,
    headerMigrated: lines[0] !== currentLine,
    migratedRows,
    passedThrough,
    refused: null,
  };
}

export async function writeMigrated(target, snapshot, text, lockOptions = {}) {
  return withPipelineLock(target, () => {
    if (readFileSync(target, 'utf-8') !== snapshot) {
      return { written: false, reason: 'file changed since it was read' };
    }
    writeFileSync(`${target}.bak`, snapshot, 'utf-8');
    atomicWriteFile(target, text);
    return { written: true, reason: null };
  }, lockOptions);
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');
  const fileArg = argv.indexOf('--file');
  const target = fileArg !== -1 && argv[fileArg + 1]
    ? path.resolve(argv[fileArg + 1])
    : path.join(getCareerOpsRoot(), 'data/scan-runs.tsv');

  if (!existsSync(target)) {
    console.error(`No scan-runs file at ${target} — nothing to migrate.`);
    process.exit(1);
  }

  const before = readFileSync(target, 'utf-8');
  const result = migrateScanRuns(before);

  if (asJson) {
    console.log(JSON.stringify({ file: target, applied: apply && result.changed, ...result, text: undefined }, null, 2));
  } else if (result.refused) {
    console.log(`Refused: ${result.refused} (${target})`);
  } else if (!result.changed) {
    console.log(`Already on the current schema: ${target}`);
  } else {
    console.log(`${target}`);
    console.log(`  header migrated: ${result.headerMigrated}`);
    console.log(`  rows migrated:   ${result.migratedRows}`);
    console.log(`  rows passed through (unrecognized width): ${result.passedThrough}`);
    console.log(apply ? `  applying — original saved to ${target}.bak` : '  dry run — nothing written. Re-run with --apply to write.');
  }

  if (apply && result.changed) {
    const { written, reason } = await writeMigrated(target, before, result.text);
    if (!written) {
      console.error(`Refused to write ${target}: ${reason}. A scan most likely appended a run `
        + 'while this was migrating. Nothing was changed — re-run the command.');
      process.exit(2);
    }
  }
}
