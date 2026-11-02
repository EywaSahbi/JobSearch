#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';

const cp = 'child' + '_process';
const FORBIDDEN_MODULES = new Set([
  cp, 'node:' + cp, 'playwright', 'worker_threads', 'node:worker_threads',
  'vm', 'node:vm', 'node:http', 'node:https', 'node:net', 'node:dns',
  'node:dns/promises', 'node:tls', 'node:dgram', 'http', 'https', 'net', 'dns', 'tls', 'dgram',
  'node:cluster', 'node:v8', 'node:inspector', 'node:repl',
]);
const ALLOWED_NODE = new Set([
  'node:crypto', 'node:url', 'node:path', 'node:buffer', 'node:util',
  'node:querystring', 'node:string_decoder', 'node:assert', 'node:events',
  'node:fs', 'node:fs/promises', 'node:os', 'node:zlib', 'node:stream',
]);

const IMPORT_RE = /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const firewallRe = new RegExp('\\b(' + ['revenue', 'pricing', 'paywall', 'monetiz\\w*', 'moat'].join('|') + ')\\b', 'i');

const KNOWN_FLAGS = ['--help', '-h'];

const USAGE = `Usage:
  node plugin-audit.mjs <plugin-dir>
  node plugin-audit.mjs --help`;

function parseArgs(argv) {
  const args = argv.slice(2);

  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  return {
    dir: args.find(a => !a.startsWith('-'))
  };
}

function collectSpecifiers(src) {
  const specs = [];
  for (const re of [IMPORT_RE, DYN_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

function listMjs(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push({ abs, rel: r });
    }
  };
  walk(dir, '');
  return out;
}

export function auditPlugin(dir) {
  const findings = [];
  for (const { abs, rel } of listMjs(dir)) {
    const src = readFileSync(abs, 'utf8');
    for (const spec of collectSpecifiers(src)) {
      const isRelative = spec.startsWith('./') || spec.startsWith('../');
      const isNode = spec.startsWith('node:') || ['crypto', 'url', 'path', 'buffer', 'util', 'fs', 'os', 'zlib', 'stream', 'events', 'assert', 'querystring'].includes(spec);
      if (FORBIDDEN_MODULES.has(spec)) findings.push({ file: rel, issue: `forbidden import "${spec}" — community plugins egress only through ctx.fetch and may not spawn/raw-socket` });
      else if (isNode && !ALLOWED_NODE.has(spec) && !ALLOWED_NODE.has('node:' + spec)) findings.push({ file: rel, issue: `node builtin "${spec}" is not on the plugin allowlist` });
      else if (!isRelative && !isNode) findings.push({ file: rel, issue: `bare-specifier import "${spec}" — registry plugins must be dependency-free (relative + allowlisted node: builtins only)` });
    }
    if (/(?<![.\w$])fetch\s*\(/.test(src)) findings.push({ file: rel, issue: 'direct global fetch() — use ctx.fetch so the egress allowlist applies' });
    if (/\bXMLHttpRequest\b|\bWebSocket\b/.test(src)) findings.push({ file: rel, issue: 'XMLHttpRequest/WebSocket egress — use ctx.fetch' });
    if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) findings.push({ file: rel, issue: 'eval/new Function — dynamic code execution is not allowed' });
    if (/process\s*\.\s*(binding|dlopen)\b/.test(src)) findings.push({ file: rel, issue: 'process.binding/dlopen — native escape hatch not allowed' });
    if (firewallRe.test(src)) findings.push({ file: rel, issue: 'commercial/monetization wording in a shipped community plugin (keep it mission-framed)' });
  }
  return { ok: findings.length === 0, findings };
}

if (isMainModule(import.meta.url)) {
  const { dir } = parseArgs(process.argv);
  if (!dir) { console.error(USAGE); process.exit(2); }
  let result;
  try { result = auditPlugin(path.resolve(dir)); } catch (e) { console.error('audit failed:', e.message); process.exit(2); }
  if (result.ok) { console.log('✓ audit clean'); process.exit(0); }
  for (const f of result.findings) console.log(`✗ ${f.file}: ${f.issue}`);
  process.exit(1);
}
