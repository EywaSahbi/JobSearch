#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { DEFAULT_SMALL_THRESHOLD, isSmallBoard, smallBoardDetail } from './lib/small-board.mjs';

const ROOT = getCareerOpsRoot();
const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
export const PROVIDERS_DIR = join(CODE_ROOT, 'providers');

export { DEFAULT_SMALL_THRESHOLD };

export const DEFAULT_DRIFT_FRACTION = 0.5;

const SAMPLE_SIZE = 3;

const AUDIT_MAX_PAGES = 1;

export const VERDICTS = ['no-provider', 'error', 'empty', 'small', 'ok'];

export function classifyBoard(result, { smallThreshold = DEFAULT_SMALL_THRESHOLD } = {}) {
  if (!result || typeof result !== 'object') {
    return { verdict: 'error', count: null, detail: 'no result' };
  }
  if (!result.provider) {
    return {
      verdict: 'no-provider',
      count: null,
      detail: result.scanMethod
        ? `no provider claims this entry — scan.mjs hands it to the agent (scan_method: ${result.scanMethod})`
        : 'no provider claims this entry and it declares no scan_method — scan.mjs drops it into an unnamed skip count',
    };
  }
  if (result.error) {
    return { verdict: 'error', count: null, detail: String(result.error).slice(0, 120) };
  }
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  if (jobs.length === 0) return { verdict: 'empty', count: 0, detail: 'board answers with zero postings' };
  if (isSmallBoard(jobs.length, smallThreshold)) {
    return { verdict: 'small', count: jobs.length, detail: smallBoardDetail(jobs.length) };
  }
  return { verdict: 'ok', count: jobs.length, detail: `${jobs.length} postings` };
}

export function sampleJobs(jobs, n = SAMPLE_SIZE) {
  if (!Array.isArray(jobs)) return [];
  return jobs.slice(0, n).map((j) => {
    const title = String(j?.title || '(sin título)').replace(/\s+/g, ' ').trim().slice(0, 60);
    const loc = String(j?.location || '').replace(/\s+/g, ' ').trim().slice(0, 34);
    return loc ? `${title} · ${loc}` : title;
  });
}

export function diffAgainstBaseline(current, baseline, { fraction = DEFAULT_DRIFT_FRACTION } = {}) {
  const before = new Map();
  for (const row of Array.isArray(baseline) ? baseline : []) {
    if (row && typeof row.name === 'string' && Number.isFinite(row.count)) before.set(row.name, row.count);
  }
  const drops = [];
  for (const row of Array.isArray(current) ? current : []) {
    if (!row || typeof row.name !== 'string' || !Number.isFinite(row.count)) continue;
    const was = before.get(row.name);
    if (!Number.isFinite(was) || was <= 0) continue;
    const lost = was - row.count;
    if (lost > 0 && lost / was >= fraction) {
      drops.push({ name: row.name, before: was, after: row.count, lost });
    }
  }
  return drops.sort((a, b) => b.lost - a.lost);
}

export async function auditCompanies(companies, {
  providers = null,
  httpCtx = null,
  smallThreshold = DEFAULT_SMALL_THRESHOLD,
  concurrency = 6,
} = {}) {
  const list = (Array.isArray(companies) ? companies : []).filter(
    (c) => c && typeof c === 'object' && c.enabled !== false,
  );
  const rows = [];
  const queue = [...list];

  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      const name = typeof entry.name === 'string' ? entry.name : '(unnamed)';
      let resolved = null;
      if (providers && providers.size > 0) {
        resolved = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
      }
      const providerId = resolved?.provider?.id || null;

      let result = { provider: providerId, scanMethod: entry.scan_method || null };
      if (providerId) {
        try {
          const ctx = httpCtx || { ...makeHttpCtx(), maxPages: AUDIT_MAX_PAGES };
          result.jobs = (await resolved.provider.fetch(entry, ctx)) || [];
        } catch (err) {
          result.error = err?.message || String(err);
        }
      }

      const { verdict, count, detail } = classifyBoard(result, { smallThreshold });
      rows.push({
        name,
        provider: providerId || '—',
        careers_url: typeof entry.careers_url === 'string' ? entry.careers_url : '',
        verdict,
        count,
        detail,
        samples: sampleJobs(result.jobs || []),
      });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  rows.sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.name.localeCompare(b.name));
  return rows;
}

export function findUnclaimedEntries(entries, providers) {
  const silent = [];
  const handoff = [];
  const unknownProvider = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const resolved = providers && providers.size > 0 ? resolveProvider(entry, providers) : null;
    if (resolved?.provider) continue;
    const row = {
      name: entry.name,
      scanMethod: entry.scan_method || null,
      careers_url: typeof entry.careers_url === 'string' ? entry.careers_url : '',
      error: resolved?.error || null,
    };
    if (row.error) unknownProvider.push(row);
    else if (row.scanMethod) handoff.push(row);
    else silent.push(row);
  }
  return { silent, handoff, unknownProvider };
}

export function loadCompanies(filePath = DEFAULT_PORTALS_PATH) {
  if (!existsSync(filePath)) throw new Error(`portals file not found: ${filePath}`);
  const cfg = yaml.load(readFileSync(filePath, 'utf-8')) || {};
  return Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : [];
}

function queryWords(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}+#]*/gu) || [];
}

export function findStaleScanQueries(companies, positiveKeywords) {
  const keywords = Array.isArray(positiveKeywords)
    ? positiveKeywords.filter((v) => typeof v === 'string' && v.trim()) : [];
  const targets = new Set(keywords.flatMap(queryWords));
  if (!targets.size) return [];
  const findings = [];
  for (const company of Array.isArray(companies) ? companies : []) {
    if (!company || company.enabled === false || company.scan_method !== 'websearch') continue;
    const query = company.scan_query || company.search_query;
    if (typeof query !== 'string' || !query.trim()) continue;
    const terms = query
      .replace(/\bNOT\s+(?:"[^"]*"|\([^)]*\)|\S+)/g, ' ')
      .replace(/(?:^|[\s(])-(?:"[^"]*"|\([^)]*\)|[^\s)]+)/g, ' ')
      .replace(/\b(?:site|inurl|filetype):(?:"[^"]*"|\S+)/gi, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b(?:OR|AND|NOT)\b/g, ' ');
    const words = queryWords(terms);
    if (!words.length || words.some((word) => targets.has(word))) continue;
    findings.push({
      name: typeof company.name === 'string' ? company.name : '(unnamed)',
      query,
      detail: 'possibly stale — no positive-keyword overlap with current targeting',
    });
  }
  return findings;
}

const ICON = { ok: '✅', small: '🟡', empty: '⚪', 'no-provider': '🚨', error: '❌' };

const KNOWN_FLAGS = [
  '--summary', '--json', '--strict', '--queries', '--company', '--file',
  '--baseline', '--small-threshold', '--help', '-h',
];
const VALUE_FLAGS = ['--company', '--file', '--baseline', '--small-threshold'];

const USAGE = `Usage:
  node audit-portals.mjs                       # audit every enabled company
  node audit-portals.mjs --summary             # one line per company
  node audit-portals.mjs --json                # machine-readable, for --baseline
  node audit-portals.mjs --company Adyen       # audit a single company
  node audit-portals.mjs --file <path>         # use a specific portals file
  node audit-portals.mjs --baseline prev.json  # flag boards that lost postings
  node audit-portals.mjs --small-threshold 10  # what counts as a small board
  node audit-portals.mjs --strict              # exit 1 on any non-ok verdict
  node audit-portals.mjs --queries             # offline advisory; never rewrites queries
  node audit-portals.mjs --help                # print this usage block and exit`;

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const filePath = flagValue(args, '--file') || DEFAULT_PORTALS_PATH;
  const only = flagValue(args, '--company');
  const asJson = hasFlag(args, '--json');
  const summary = hasFlag(args, '--summary');
  const strict = hasFlag(args, '--strict');

  const rawThreshold = flagValue(args, '--small-threshold');
  const smallThreshold = rawThreshold === undefined ? DEFAULT_SMALL_THRESHOLD : Number(rawThreshold);
  if (!Number.isFinite(smallThreshold) || smallThreshold < 0) {
    console.error(`Error: --small-threshold expects a non-negative number, got "${rawThreshold}"`);
    process.exit(1);
  }

  let companies = loadCompanies(filePath);
  if (only) {
    const needle = only.toLowerCase();
    companies = companies.filter((c) => String(c?.name || '').toLowerCase().includes(needle));
    if (companies.length === 0) {
      console.error(`Error: no tracked company matches "${only}" in ${filePath}`);
      process.exit(1);
    }
  }

  if (hasFlag(args, '--queries')) {
    const cfg = yaml.load(readFileSync(filePath, 'utf-8')) || {};
    const warnings = findStaleScanQueries(companies, cfg.title_filter?.positive);
    if (asJson) console.log(JSON.stringify({ warnings }, null, 2));
    else {
      console.log('Search-query drift advice (lexical overlap only; synonyms may differ):');
      for (const warning of warnings) {
        console.log(`  ${warning.name}: ${warning.detail}\n    ${warning.query}`);
      }
      console.log(`${warnings.length} query warning(s). Review manually; no files changed.`);
    }
    return;
  }

  const providers = await loadProviders(PROVIDERS_DIR);
  const rows = await auditCompanies(companies, { providers, smallThreshold });

  let drops = [];
  const baselinePath = flagValue(args, '--baseline');
  if (baselinePath) {
    if (!existsSync(baselinePath)) {
      console.error(`Error: baseline file not found: ${baselinePath}`);
      process.exit(1);
    }
    try {
      const prev = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      drops = diffAgainstBaseline(rows, Array.isArray(prev) ? prev : prev.rows, {});
    } catch (err) {
      console.error(`Error: could not read baseline ${baselinePath}: ${err.message}`);
      process.exit(1);
    }
  }

  if (asJson) {
    console.log(JSON.stringify(drops.length ? { rows, drops } : rows, null, 2));
  } else {
    console.log(`audit-portals: ${filePath}\n`);
    for (const r of rows) {
      if (summary) {
        console.log(`  ${ICON[r.verdict] || '·'} ${r.name} — ${r.provider} (${r.detail})`);
        continue;
      }
      if (r.verdict === 'ok') continue;
      console.log(`  ${ICON[r.verdict] || '·'} ${r.name} — ${r.provider} (${r.detail})`);
      for (const s of r.samples) console.log(`       ${s}`);
      if (r.careers_url) console.log(`       ${r.careers_url}`);
    }

    const tally = {};
    for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    const parts = VERDICTS.filter((v) => tally[v]).map((v) => `${tally[v]} ${v}`);
    console.log(`\n${rows.length} audited: ${parts.join(', ')}`);
    if (!summary && tally.ok) console.log(`(${tally.ok} healthy boards not listed — use --summary to see them)`);

    if (drops.length > 0) {
      console.log(`\n🚨 ${drops.length} board(s) lost postings since the baseline:`);
      for (const d of drops) console.log(`  ${d.name}: ${d.before} → ${d.after} (-${d.lost})`);
    }
  }

  if (strict) {
    const bad = rows.filter((r) => r.verdict !== 'ok').length;
    if (bad > 0 || drops.length > 0) {
      if (!asJson) {
        const reasons = [];
        if (bad > 0) reasons.push(`${bad} board(s) with a non-ok verdict`);
        if (drops.length > 0) reasons.push(`${drops.length} board(s) below baseline`);
        console.log(`\n🔴 ${reasons.join(' and ')} (--strict).`);
      }
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`audit-portals failed: ${err.message}`);
    process.exit(1);
  });
}
