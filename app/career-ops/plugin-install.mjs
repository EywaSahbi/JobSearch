#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateManifest } from './plugins/_engine.mjs';
import { hashPluginTree } from './plugins/_lock.mjs';
import { auditPlugin } from './plugin-audit.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?$/;
const NAME_RE = /^career-ops-plugin-([a-z0-9][a-z0-9-]*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MIN_FILES = ['manifest.json', 'index.mjs', 'README.md', 'LICENSE'];

export function parseRepoArg(arg) {
  let url = arg;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(arg)) url = `https://github.com/${arg}`;
  url = url.replace(/\.git$/, '');
  if (!GITHUB_URL_RE.test(url)) throw new Error(`refusing non-GitHub/unsafe repo URL: ${arg} (expected https://github.com/<owner>/<repo>)`);
  const repoName = url.split('/').pop() || '';
  const m = NAME_RE.exec(repoName);
  if (!m) throw new Error(`repo must be named "career-ops-plugin-<name>" (got "${repoName}")`);
  return { url, id: m[1] };
}

export function safeClone(url, sha) {
  if (!SHA_RE.test(sha || '')) throw new Error(`a 40-hex commit --sha is required (got ${JSON.stringify(sha)})`);
  const dir = mkdtempSync(path.join(tmpdir(), 'co-plugin-'));
  const git = (...args) => execFileSync('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  try {
    git('-C', dir, 'init', '-q');
    git('-C', dir, 'remote', 'add', 'origin', '--', url);
    git('-C', dir, 'fetch', '--depth', '1', '--no-tags', '-q', 'origin', sha);
    git('-C', dir, 'checkout', '-q', 'FETCH_HEAD');
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`clone of ${url}@${sha.slice(0, 10)} failed — ${err.stderr ? String(err.stderr).slice(0, 200) : err.message}`);
  }
}

export function validateInstall(dir, expectId) {
  const problems = [];
  for (const f of MIN_FILES) if (!existsSync(path.join(dir, f))) problems.push(`missing required file: ${f}`);
  if (problems.length) return { ok: false, problems, manifest: null };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (e) { return { ok: false, problems: [`manifest.json invalid JSON: ${e.message}`], manifest: null }; }
  const tmpNamed = path.join(path.dirname(dir), expectId);
  if (dir !== tmpNamed) { try { renameSync(dir, tmpNamed); dir = tmpNamed; } catch { } }
  const manifest = validateManifest(parsed, dir, expectId);
  if (!manifest) return { ok: false, problems: ['manifest failed validation (see ⚠️ above)'], manifest: null, dir };
  const audit = auditPlugin(dir);
  if (!audit.ok) return { ok: false, problems: audit.findings.map(f => `${f.file}: ${f.issue}`), manifest, dir };
  return { ok: true, problems: [], manifest, dir };
}

export function installFromRepo(root, { url, sha }) {
  const { url: safeUrl, id } = parseRepoArg(url);
  const dest = path.join(root, 'plugins.local', id);
  if (existsSync(dest)) throw new Error(`plugins.local/${id} already exists — \`node plugins.mjs remove ${id}\` first`);
  let cloned = safeClone(safeUrl, sha);
  let result;
  try { result = validateInstall(cloned, id); }
  catch (e) { rmSync(cloned, { recursive: true, force: true }); throw e; }
  if (!result.ok) {
    rmSync(result.dir || cloned, { recursive: true, force: true });
    throw new Error(`plugin rejected:\n  - ${result.problems.join('\n  - ')}`);
  }
  mkdirSync(path.join(root, 'plugins.local'), { recursive: true });
  cpSync(result.dir, dest, { recursive: true });
  rmSync(result.dir, { recursive: true, force: true });
  const tree = hashPluginTree(dest);
  return { id, manifest: { ...result.manifest, dir: dest }, integrity: tree.integrity, files: tree.files, repo: safeUrl, sha };
}

export function auditRegistryEntry(url, sha, expectId) {
  let parsed;
  try { parsed = parseRepoArg(url); } catch (e) { return [e.message]; }
  if (expectId && parsed.id !== expectId) return [`repo "${url}" → id "${parsed.id}" but registry id is "${expectId}"`];
  let dir;
  try { dir = safeClone(parsed.url, sha); } catch (e) { return [e.message]; }
  let result;
  try { result = validateInstall(dir, parsed.id); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); return [e.message]; }
  try { rmSync(result.dir || dir, { recursive: true, force: true }); } catch { }
  return result.ok ? [] : result.problems;
}

export function scaffoldNew(root, name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`plugin name must match [a-z0-9-] (got "${name}")`);
  const tpl = path.join(root, 'plugins', '_template');
  if (!existsSync(tpl)) throw new Error('plugins/_template/ not found');
  const dest = path.join(root, 'plugins.local', name);
  if (existsSync(dest)) throw new Error(`plugins.local/${name} already exists`);
  mkdirSync(path.join(root, 'plugins.local'), { recursive: true });
  cpSync(tpl, dest, { recursive: true });
  const sub = (p) => { if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('{{NAME}}', name), 'utf8'); };
  for (const f of readdirSync(dest, { withFileTypes: true })) {
    if (f.isFile()) sub(path.join(dest, f.name));
  }
  if (existsSync(path.join(dest, 'test'))) for (const f of readdirSync(path.join(dest, 'test'))) sub(path.join(dest, 'test', f));
  return dest;
}

const KNOWN_FLAGS = ['--help', '-h'];

const USAGE = `Usage:
  node plugin-install.mjs --help|-h   # print this usage block and exit

plugin-install.mjs takes no flags or arguments of its own — it is the
clone/scaffold/validate engine behind plugins.mjs, which owns the CLI:

  node plugins.mjs new <name>
      # scaffold plugins.local/<name> from plugins/_template/

  node plugins.mjs add <name|owner/repo> [--sha <commit>] [--confirm]
      # clone a pinned commit into plugins.local/<id>, validate it, and print
      # its capability card (--confirm also enables it)

Install constraints enforced here: the repo must be named
career-ops-plugin-<name>, live at https://github.com/<owner>/<repo>, and be
pinned to a 40-hex commit SHA — a registry entry supplies the SHA, anything
else requires --sha. See docs/PLUGINS.md.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  validateFlags(args, KNOWN_FLAGS, USAGE);

  if (args.length > 0) {
    console.error(`Error: plugin-install.mjs takes no arguments (got: ${args.join(' ')}). Its commands live on plugins.mjs.`);
    console.error(USAGE);
    process.exit(1);
  }

  console.log(USAGE);
}
