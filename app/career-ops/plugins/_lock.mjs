import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

const LOCK_VERSION = 1;

export function lockPath(root) {
  return path.join(root, 'plugins.lock');
}

function sha256(buf) {
  return 'sha256-' + createHash('sha256').update(buf).digest('hex');
}

export function hashPluginTree(dir) {
  const files = {};
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); }
    catch (err) { throw new Error(`cannot read ${rel || '.'}: ${err.message}`); }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) throw new Error(`refusing to hash symlink: ${childRel}`);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files[childRel] = sha256(readFileSync(childAbs));
      else throw new Error(`refusing to hash non-regular file: ${childRel}`);
    }
  };
  walk(dir, '');
  const aggregate = Object.keys(files).sort().map(k => `${k}:${files[k]}`).join('\n');
  return { files, integrity: sha256(Buffer.from(aggregate)) };
}

export function readLock(root) {
  const file = lockPath(root);
  if (!existsSync(file)) return { lockfileVersion: LOCK_VERSION, plugins: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.plugins !== 'object') return { lockfileVersion: LOCK_VERSION, plugins: {} };
    return parsed;
  } catch {
    return { lockfileVersion: LOCK_VERSION, plugins: {} };
  }
}

export function writeLockEntry(root, id, entry) {
  const lock = readLock(root);
  lock.lockfileVersion = LOCK_VERSION;
  lock.plugins[id] = entry;
  writeFileSync(lockPath(root), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

export function removeLockEntry(root, id) {
  const lock = readLock(root);
  if (lock.plugins[id]) { delete lock.plugins[id]; writeFileSync(lockPath(root), JSON.stringify(lock, null, 2) + '\n', 'utf8'); }
}

export function diffPlugin(manifest, lockEntry) {
  if (!lockEntry) return { status: 'unpinned', changedFiles: [], addedHosts: [], addedEnv: [] };
  const tree = hashPluginTree(manifest.dir);
  const addedHosts = (manifest.allowedHosts || []).filter(h => !(lockEntry.consent?.allowedHosts || []).includes(h));
  const addedEnv = (manifest.requiredEnv || []).filter(e => !(lockEntry.consent?.requiredEnv || []).includes(e));
  const surfaceWidened = addedHosts.length > 0 || addedEnv.length > 0 ||
    (manifest.allowsLocalhost === true && lockEntry.consent?.allowsLocalhost !== true);

  if (tree.integrity === lockEntry.integrity) {
    return surfaceWidened
      ? { status: 'surface-widened', changedFiles: [], addedHosts, addedEnv }
      : { status: 'match', changedFiles: [], addedHosts, addedEnv };
  }
  const prev = lockEntry.files || {};
  const changedFiles = [...new Set([...Object.keys(tree.files), ...Object.keys(prev)])]
    .filter(f => tree.files[f] !== prev[f]);
  if (surfaceWidened) return { status: 'surface-widened', changedFiles, addedHosts, addedEnv };
  const bumped = compareVersions(manifest.version, lockEntry.version) > 0;
  return { status: bumped ? 'legit-update' : 'drift-nobump', changedFiles, addedHosts, addedEnv };
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

export function consentSurface(manifest) {
  return {
    hooks: [...manifest.hooks],
    requiredEnv: [...manifest.requiredEnv],
    allowedHosts: [...manifest.allowedHosts],
    skill: Boolean(manifest.skill),
    allowsLocalhost: manifest.allowsLocalhost === true,
  };
}
