import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'url';

const CODEBASE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function registryDirPath(root) {
  return path.join(root, 'plugins-registry');
}

export function registryPath(root) {
  return path.join(root, 'plugins-registry.json');
}

export function loadRegistryFiles(root) {
  const dir = registryDirPath(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    let entry = null;
    try { entry = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch { }
    out.push({ file, entry });
  }
  return out;
}

export function loadRegistry(root) {
  const base = existsSync(registryDirPath(root)) || existsSync(registryPath(root)) ? root : CODEBASE_ROOT;
  if (existsSync(registryDirPath(base))) {
    const plugins = loadRegistryFiles(base)
      .map(({ entry }) => entry)
      .filter(e => e && typeof e === 'object');
    return { registryVersion: 1, plugins };
  }
  const f = registryPath(base);
  if (!existsSync(f)) return { registryVersion: 1, plugins: [] };
  try {
    const p = JSON.parse(readFileSync(f, 'utf8'));
    return p && Array.isArray(p.plugins) ? p : { registryVersion: 1, plugins: [] };
  } catch {
    return { registryVersion: 1, plugins: [] };
  }
}

export function findInRegistry(root, nameOrId) {
  const reg = loadRegistry(root);
  const found = reg.plugins.find(p =>
    p.id === nameOrId || p.name === nameOrId || p.name === `career-ops-plugin-${nameOrId}`) || null;
  if (found) return found;

  const baseReg = loadRegistry(CODEBASE_ROOT);
  return baseReg.plugins.find(p =>
    p.id === nameOrId || p.name === nameOrId || p.name === `career-ops-plugin-${nameOrId}`) || null;
}

export function classifySource(manifest, root, lockEntry) {
  if (manifest.dir.startsWith(path.join(root, 'plugins') + path.sep) ||
      manifest.dir.startsWith(path.join(CODEBASE_ROOT, 'plugins') + path.sep)) return 'bundled';
  const reg = findInRegistry(root, manifest.id);
  if (!reg) return 'unverified';
  if (lockEntry && lockEntry.sha && reg.sha && lockEntry.sha !== reg.sha) return 'off-registry';
  return 'approved';
}

export function sourceBadge(source) {
  return {
    bundled: '📦 bundled',
    approved: '✓ approved',
    'off-registry': '⚠️ off-registry',
    unverified: '❓ community-unverified',
  }[source] || source;
}

export function validateRegistryEntry(e, { idRe, hookKinds, reservedEnv }) {
  const errs = [];
  if (typeof e.name !== 'string' || !e.name.startsWith('career-ops-plugin-')) errs.push('name must start with "career-ops-plugin-"');
  if (typeof e.id !== 'string' || !idRe.test(e.id)) errs.push('invalid id');
  if (e.name && e.id && e.name !== `career-ops-plugin-${e.id}`) errs.push('name must equal career-ops-plugin-<id>');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(e.repo || '')) errs.push('repo must be a https://github.com/<owner>/<repo> URL');
  if (!/^[0-9a-f]{40}$/.test(e.sha || '')) errs.push('sha must be a 40-hex commit');
  if (!Array.isArray(e.hooks) || e.hooks.length === 0 || e.hooks.some(h => !hookKinds.includes(h))) errs.push('hooks must be a non-empty subset of the hook kinds');
  if (!Array.isArray(e.requiredEnv)) errs.push('requiredEnv must be an array');
  else if (e.requiredEnv.some(n => reservedEnv.has(n) || /^AWS_/.test(n))) errs.push('requiredEnv declares a reserved/core-owned var');
  if (!Array.isArray(e.allowedHosts)) errs.push('allowedHosts must be an array');
  else if (Array.isArray(e.requiredEnv) && e.requiredEnv.length > 0 && e.allowedHosts.length === 0) errs.push('a keyed plugin must declare allowedHosts');
  if (typeof e.license !== 'string' || !e.license) errs.push('license is required');
  if (typeof e.version !== 'string') errs.push('version is required');
  if (e.supersedesBundled !== undefined && e.supersedesBundled !== true) errs.push('supersedesBundled, if present, must be the boolean true');
  return errs;
}

export function successorFor(root, bundledId) {
  return loadRegistry(root).plugins.find(p => p.supersedesBundled === true && p.id === bundledId) || null;
}
