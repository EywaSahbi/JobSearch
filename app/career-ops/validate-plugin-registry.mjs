#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, loadRegistryFiles, validateRegistryEntry } from './plugins/_registry.mjs';
import { HOOK_KINDS, RESERVED_ENV } from './plugins/_engine.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateRegistry(root) {
  const reg = loadRegistry(root);
  const problems = [];
  if (reg.registryVersion !== 1) problems.push(`unsupported registryVersion ${JSON.stringify(reg.registryVersion)}`);
  for (const { file, entry } of loadRegistryFiles(root)) {
    if (!entry || typeof entry !== 'object') { problems.push(`${file}: not a JSON object`); continue; }
    if (entry.id && `${entry.id}.json` !== file) problems.push(`${file}: filename must equal "<id>.json" (id is "${entry.id}")`);
  }
  const names = new Set(), ids = new Set();
  for (const e of reg.plugins) {
    for (const er of validateRegistryEntry(e, { idRe: ID_RE, hookKinds: HOOK_KINDS, reservedEnv: RESERVED_ENV })) {
      problems.push(`${e.name || e.id || '?'}: ${er}`);
    }
    if (e.name && names.has(e.name)) problems.push(`duplicate name: ${e.name}`);
    if (e.id && ids.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    if (e.supersedesBundled === true && e.id && !existsSync(path.join(root, 'plugins', e.id, 'manifest.json'))) {
      problems.push(`${e.name || e.id}: supersedesBundled names "${e.id}" but no bundled plugin (plugins/${e.id}/) exists to supersede`);
    }
    names.add(e.name); ids.add(e.id);
  }
  return problems;
}

const GITHUB_API = 'https://api.github.com';

function repoSlug(repoUrl) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(String(repoUrl || ''));
  if (!m) throw new Error(`unparseable repo URL: ${JSON.stringify(repoUrl)}`);
  return m[1];
}

async function ghJson(url, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'career-ops-registry-freshness' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function fetchLatestRelease(repoUrl, { fetchImpl = fetch } = {}) {
  const slug = repoSlug(repoUrl);
  const rel = await ghJson(`${GITHUB_API}/repos/${slug}/releases/latest`, fetchImpl);
  if (rel === null) {
    if (!(await ghJson(`${GITHUB_API}/repos/${slug}`, fetchImpl))) {
      throw new Error(`repo not reachable (404): ${slug} — deleted or private`);
    }
    return null;
  }
  if (!rel.tag_name) throw new Error(`malformed release response for ${slug}: no tag_name`);
  const commit = await ghJson(`${GITHUB_API}/repos/${slug}/commits/${encodeURIComponent(rel.tag_name)}`, fetchImpl);
  if (!commit || !commit.sha) throw new Error(`release ${rel.tag_name} resolves to no commit`);
  return { tag: rel.tag_name, sha: commit.sha };
}

export async function checkRegistryFreshness(root, { fetchRelease = fetchLatestRelease } = {}) {
  const out = [];
  for (const e of loadRegistry(root).plugins) {
    const row = {
      id: e.id, name: e.name, repo: e.repo,
      pinnedSha: e.sha, pinnedVersion: e.version,
      status: 'error', releaseTag: null, releaseSha: null, detail: '',
    };
    try {
      const rel = await fetchRelease(e.repo);
      if (!rel) { row.status = 'no-release'; row.detail = 'no published release to compare against'; }
      else {
        row.releaseTag = rel.tag; row.releaseSha = rel.sha;
        const same = String(rel.sha).toLowerCase() === String(e.sha).toLowerCase();
        row.status = same ? 'fresh' : 'stale';
        row.detail = same ? `pinned at ${rel.tag}` : `pin trails ${rel.tag}`;
      }
    } catch (err) {
      row.status = 'error';
      row.detail = err && err.message ? err.message : String(err);
    }
    out.push(row);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  const root = process.cwd();
  const deep = process.argv.includes('--deep');
  const problems = validateRegistry(root);
  if (deep && problems.length === 0) {
    const { auditRegistryEntry } = await import('./plugin-install.mjs');
    const { loadRegistry } = await import('./plugins/_registry.mjs');
    for (const e of loadRegistry(root).plugins) {
      for (const p of auditRegistryEntry(e.repo, e.sha, e.id)) problems.push(`${e.name}: ${p}`);
    }
  }
  if (process.argv.includes('--check-stale') && problems.length === 0) {
    const rows = await checkRegistryFreshness(root);
    const mark = { fresh: '✓', stale: '✗', 'no-release': '–', error: '!' };
    for (const r of rows) {
      console.log(`${mark[r.status] || '?'} ${(r.id || '?').padEnd(20)} ${r.status.padEnd(11)} pin=${String(r.pinnedSha).slice(0, 10)} ${r.detail}`);
    }
    const stale = rows.filter(r => r.status === 'stale');
    const errored = rows.filter(r => r.status === 'error');
    for (const r of stale) problems.push(`${r.name || r.id}: pin ${String(r.pinnedSha).slice(0, 10)} trails release ${r.releaseTag} (${String(r.releaseSha).slice(0, 10)}) — bump plugins-registry/${r.id}.json`);
    for (const r of errored) problems.push(`${r.name || r.id}: could not resolve latest release — ${r.detail}`);
  }
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
  console.log(`✓ plugin registry is valid${deep ? ' (deep: all entries cloned + audited)' : ''}`); process.exit(0);
}
