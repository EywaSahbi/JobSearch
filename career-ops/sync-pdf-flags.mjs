#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { extractTrackerReportNumbers, resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { rebuildRow, resolveTrackerPath, resolvePdfIndexPath, openTrackerTransaction, writeFileAtomic, resolveWorkspaceRoot, pathIsInsideCanonical } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = 'Usage: node sync-pdf-flags.mjs [--dry-run] [--json]\n       node sync-pdf-flags.mjs --prune [--write] [--json]';

export async function syncTrackerPdfFlags(options = {}) {
  const { appsFile, pdfManifest, logger = globalThis.console } = options;
  if (!appsFile || !pdfManifest) throw new TypeError('syncTrackerPdfFlags: options.appsFile and options.pdfManifest are required');
  const console = logger;
  const APPS_FILE = appsFile;
  const PDF_MANIFEST = pdfManifest;
  const flags = { dryRun: false, json: false, prune: false, write: false, ...options.flags };
  const transactionOptions = Object.fromEntries(
    Object.entries({ lockDir: options.lockDir, ...options.lock }).filter(([, v]) => v !== undefined),
  );

  if (!existsSync(APPS_FILE)) {
    if (flags.json) console.log(JSON.stringify({ error: `No tracker found at ${APPS_FILE}`, code: 'no-tracker' }));
    else console.error(`❌ No tracker found at ${APPS_FILE}`);
    return 2;
  }

  if (flags.prune) {
    if (!existsSync(PDF_MANIFEST)) {
      const result = { pruned: 0, kept: 0, dryRun: !flags.write };
      if (flags.json) console.log(JSON.stringify(result));
      else console.log('\n📊 Summary: manifest does not exist — nothing to prune');
      return 0;
    }

    let rawContent;
    try {
      rawContent = readFileSync(PDF_MANIFEST, 'utf-8');
    } catch (err) {
      if (flags.json) {
        console.log(JSON.stringify({ error: `Cannot read PDF manifest: ${err.message}`, code: 'manifest-read-error' }));
      } else {
        console.error(`❌ Cannot read PDF manifest: ${err.message}`);
      }
      return 2;
    }

    const workspaceRoot = resolveWorkspaceRoot(APPS_FILE);
    const outputDir = resolve(workspaceRoot, 'output');

    const inputLines = rawContent.split('\n');
    const keptLines = [];
    const prunedRows = [];

    for (const line of inputLines) {
      if (!line.trim() || line.startsWith('#')) {
        keptLines.push(line);
        continue;
      }

      const parts = line.split('\t');
      const relPdf = parts[1]?.trim();

      if (!relPdf) {
        keptLines.push(line);
        continue;
      }

      const absPath = resolve(workspaceRoot, relPdf);
      if (!pathIsInsideCanonical(absPath, outputDir)) {
        prunedRows.push({ line, relPdf, report: parts[0]?.trim() || '' });
        if (!flags.json) {
          const marker = flags.write ? '🗑️ ' : '🔎';
          const action = flags.write ? 'pruned' : 'would prune';
          console.log(`${marker} ${action}: ${relPdf} (report ${parts[0]?.trim() || '?'}) — outside output directory`);
        }
        continue;
      }

      if (existsSync(absPath)) {
        keptLines.push(line);
      } else {
        prunedRows.push({ line, relPdf, report: parts[0]?.trim() || '' });
        if (!flags.json) {
          const marker = flags.write ? '🗑️ ' : '🔎';
          const action = flags.write ? 'pruned' : 'would prune';
          console.log(`${marker} ${action}: ${relPdf} (report ${parts[0]?.trim() || '?'}) — file not found`);
        }
      }
    }

    const pruned = prunedRows.length;
    const kept = inputLines.filter(l => l.trim() && !l.startsWith('#')).length - pruned;

    if (pruned > 0 && flags.write) {
      const content = keptLines.join('\n').replace(/\n+$/, '') + '\n';
      try {
        writeFileAtomic(PDF_MANIFEST, content);
      } catch (err) {
        if (flags.json) {
          console.log(JSON.stringify({ error: `Cannot write manifest: ${err.message}`, code: 'write-failure' }));
        } else {
          console.error(`❌ Cannot write manifest: ${err.message}`);
        }
        return 1;
      }
    }

    const result = { pruned, kept, dryRun: !flags.write };
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const verb = flags.write ? 'pruned' : 'would prune (dry run — pass --write to commit)';
      console.log(`\n📊 Summary: ${pruned} row(s) ${verb}, ${kept} kept`);
      if (pruned > 0 && !flags.write) {
        console.log('ℹ️  Re-run with --write to remove stale rows, then run sync-pdf-flags.mjs to reconcile tracker flags.');
      }
    }
    return 0;
  }

  const manifestReports = new Set();
  if (existsSync(PDF_MANIFEST)) {
    let content;
    try {
      content = readFileSync(PDF_MANIFEST, 'utf-8');
    } catch (err) {
      if (flags.json) {
        console.log(JSON.stringify({ error: `Cannot read PDF manifest: ${err.message}`, code: 'manifest-read-error' }));
      } else {
        console.error(`❌ Cannot read PDF manifest: ${err.message}`);
      }
      return 2;
    }
    for (const line of content.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.split('\t');
      const reportVal = parts[0]?.trim();
      if (reportVal && /^\d+$/.test(reportVal)) {
        const norm = parseInt(reportVal, 10);
        if (norm > 0) manifestReports.add(norm);
      }
    }
  }

  let transaction;
  try {
    transaction = await openTrackerTransaction(APPS_FILE, transactionOptions);
  } catch (err) {
    if (err?.code === 'LOCK_TIMEOUT') {
      if (flags.json) console.log(JSON.stringify({ error: err.message, code: 'lock-timeout' }));
      else console.error(`❌ ${err.message}`);
      return 4;
    }
    if (flags.json) console.log(JSON.stringify({ error: `Cannot acquire tracker lock: ${err.message}`, code: 'lock-error' }));
    else console.error(`❌ Cannot acquire tracker lock: ${err.message}`);
    return 1;
  }

  let content;
  try {
    content = transaction.read();
  } catch (err) {
    transaction.close();
    if (flags.json) console.log(JSON.stringify({ error: `Cannot read tracker: ${err.message}`, code: 'read-failure' }));
    else console.error(`❌ Cannot read tracker: ${err.message}`);
    return 2;
  }

  let updated = 0;
  let unchanged = 0;
  try {
    const lines = content.split('\n');
    const colmap = resolveColumns(lines);

    for (let i = 0; i < lines.length; i++) {
      const row = parseTrackerRow(lines[i], colmap);
      if (!row) continue;

      const reportNums = extractTrackerReportNumbers(row.report);
      const hasPdf = reportNums.some(num => manifestReports.has(num));

      if (hasPdf) {
        if (row.pdf !== '✅') {
          const parts = lines[i].split('|').map(s => s.trim());
          while (parts.length <= colmap.pdf) parts.push('');
          parts[colmap.pdf] = '✅';
          lines[i] = rebuildRow(parts);
          updated++;
          if (!flags.json && !flags.dryRun) {
            console.log(`✅ #${row.num} ${row.company} — ${row.role}: PDF flag updated to ✅`);
          } else if (!flags.json && flags.dryRun) {
            console.log(`🔎 #${row.num} ${row.company} — ${row.role}: would update PDF flag to ✅`);
          }
        } else {
          unchanged++;
        }
      }
    }

    if (updated > 0 && !flags.dryRun) {
      try {
        transaction.replace(lines.join('\n'));
      } catch (err) {
        transaction.close();
        if (flags.json) console.log(JSON.stringify({ error: `Cannot write tracker: ${err.message}`, code: 'write-failure' }));
        else console.error(`❌ Cannot write tracker: ${err.message}`);
        return 1;
      }
    }
  } finally {
    transaction.close();
  }

  const result = { updated, unchanged, dryRun: flags.dryRun };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n📊 Summary: ${updated} PDF flags synced, ${unchanged} unchanged`);
    if (flags.dryRun) console.log('(dry-run — no changes written)');
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  const flags = { dryRun: false, json: false, prune: false, write: false };
  const unknownOptions = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--prune') flags.prune = true;
    else if (arg === '--write') flags.write = true;
    else unknownOptions.push(arg);
  }

  if (!flags.prune && flags.write) {
    unknownOptions.push('--write');
  }

  if (flags.dryRun) flags.write = false;

  if (unknownOptions.length > 0) {
    const error = `unknown option(s): ${unknownOptions.join(', ')}`;
    if (flags.json) console.error(JSON.stringify({ error, code: 'unknown-option' }));
    else console.error(`Error: ${error}\n${USAGE}`);
    process.exitCode = 1;
  } else {
    const DATA_ROOT = getCareerOpsRoot();
    const appsFile = resolveTrackerPath(DATA_ROOT);
    process.exitCode = await syncTrackerPdfFlags({
      appsFile,
      pdfManifest: resolvePdfIndexPath(appsFile),
      flags,
    });
  }
}
