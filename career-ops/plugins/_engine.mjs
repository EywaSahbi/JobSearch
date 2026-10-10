import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { resolveAndValidate } from './_net.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { readLock, writeLockEntry, diffPlugin, hashPluginTree, consentSurface } from './_lock.mjs';
import { loadRegistry } from './_registry.mjs';

export const HOOK_KINDS = ['provider', 'ingest', 'search', 'notify', 'export'];

export const RESERVED_ENV = new Set([
  'GEMINI_API_KEY', 'GEMINI_MODEL',
  'OPENROUTER_API_KEY', 'CAREER_OPS_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  'ANTHROPIC_API_KEY',
  'CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE',
  'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'NODE_EXTRA_CA_CERTS',
]);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_HOOK_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

function isReservedEnv(name) {
  return RESERVED_ENV.has(name) || /^AWS_/.test(name);
}

function warnSkip(label, reason) {
  console.warn(`⚠️  ${label}: skipping — ${reason}`);
}

function isWithinDirectory(rootAbs, candidateAbs) {
  const rel = path.relative(rootAbs, candidateAbs);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function nearestExistingPath(absPath) {
  let current = path.resolve(absPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function isSafePluginPath(rootAbs, candidateAbs) {
  const rootResolved = path.resolve(rootAbs);
  const candidateResolved = path.resolve(candidateAbs);
  if (!isWithinDirectory(rootResolved, candidateResolved)) return false;

  const nearestExisting = nearestExistingPath(candidateResolved);
  if (!nearestExisting) return false;
  try {
    return isWithinDirectory(realpathSync(rootResolved), realpathSync(nearestExisting));
  } catch {
    return false;
  }
}

function pluginsConfigPath(root) {
  return path.join(root, 'config', 'plugins.yml');
}

export async function loadPluginConfig(root) {
  const file = pluginsConfigPath(root);
  if (!existsSync(file)) return {};
  try {
    const { load } = await import('js-yaml');
    const parsed = load(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    warnSkip('config/plugins.yml', `unreadable, ignoring — ${err.message}`);
    return {};
  }
}

const USER_CONFIG_FILES = [
  { name: 'config/plugins.yml', hint: (left, target) => `move ${left} to ${target}` },
  { name: '.env', hint: (left, target) => `copy the keys your plugins use from ${left} to ${target}` },
];

export function warnConfigLeftInCodeRoot(root, dataRoot) {
  if (path.resolve(root) === path.resolve(dataRoot)) return;
  for (const { name, hint } of USER_CONFIG_FILES) {
    const left = path.join(root, name);
    const target = path.join(dataRoot, name);
    if (existsSync(left) && !existsSync(target)) {
      console.warn(`⚠️  ${name} is in the code folder, not the data folder, so plugins do not read it: ${hint(left, target)}`);
    }
  }
}

export function validateManifest(m, dir, dirName) {
  const label = dirName;
  if (!m || typeof m !== 'object') { warnSkip(label, 'manifest.json is not an object'); return null; }

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) { warnSkip(label, `invalid id ${JSON.stringify(m.id)} (need ^[a-z0-9][a-z0-9-]*$)`); return null; }
  if (m.id !== dirName) { warnSkip(label, `id "${m.id}" must equal directory name "${dirName}"`); return null; }
  if (m.apiVersion !== 1) { warnSkip(label, `unsupported apiVersion ${JSON.stringify(m.apiVersion)} (engine supports 1)`); return null; }
  if (typeof m.description !== 'string' || !m.description.trim() || /[\r\n]/.test(m.description)) { warnSkip(label, 'description must be a non-empty single line'); return null; }
  if (m.humanInTheLoop !== true) { warnSkip(label, 'humanInTheLoop must be true (no auto-submit plugins)'); return null; }

  if (!Array.isArray(m.hooks) || m.hooks.length === 0) { warnSkip(label, 'hooks must be a non-empty array'); return null; }
  for (const h of m.hooks) {
    if (!HOOK_KINDS.includes(h)) { warnSkip(label, `unknown hook "${h}" (allowed: ${HOOK_KINDS.join(', ')})`); return null; }
  }

  const requiredEnv = m.requiredEnv === undefined ? [] : m.requiredEnv;
  const optionalEnv = m.optionalEnv === undefined ? [] : m.optionalEnv;
  if (!Array.isArray(requiredEnv) || requiredEnv.some(x => typeof x !== 'string')) { warnSkip(label, 'requiredEnv must be an array of strings'); return null; }
  if (!Array.isArray(optionalEnv) || optionalEnv.some(x => typeof x !== 'string')) { warnSkip(label, 'optionalEnv must be an array of strings'); return null; }
  for (const name of [...requiredEnv, ...optionalEnv]) {
    if (isReservedEnv(name)) { warnSkip(label, `requiredEnv/optionalEnv may not declare reserved var "${name}" (core-owned or process-shaping)`); return null; }
  }

  const allowedHosts = m.allowedHosts === undefined ? [] : m.allowedHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.some(x => typeof x !== 'string')) { warnSkip(label, 'allowedHosts must be an array of strings'); return null; }
  if (requiredEnv.length > 0 && allowedHosts.length === 0) { warnSkip(label, 'a plugin with requiredEnv must declare a non-empty allowedHosts egress allowlist'); return null; }

  const allowsLocalhost = m.allowsLocalhost === true;
  if (allowsLocalhost && allowedHosts.length === 0) { warnSkip(label, 'allowsLocalhost requires a non-empty allowedHosts'); return null; }
  for (const h of allowedHosts) {
    const isLoopback = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(h);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !(allowsLocalhost && isLoopback)) { warnSkip(label, `allowedHosts must be hostnames, not IP literals: ${h}`); return null; }
    if (/(^169\.254\.)|(^metadata\.google\.internal$)|(\.internal$)/i.test(h)) { warnSkip(label, `allowedHosts may not target metadata/internal hosts: ${h}`); return null; }
    if (isLoopback && !allowsLocalhost) { warnSkip(label, `allowedHosts contains a loopback host without allowsLocalhost: ${h}`); return null; }
  }

  const entry = typeof m.entry === 'string' && m.entry.trim() ? m.entry : 'index.mjs';
  if (!entry.endsWith('.mjs')) { warnSkip(label, `entry "${entry}" must be a .mjs file`); return null; }
  const entryAbs = path.resolve(dir, entry);
  if (!isSafePluginPath(dir, entryAbs)) { warnSkip(label, `entry "${entry}" escapes the plugin directory`); return null; }

  let skill = null;
  if (m.skill !== undefined) {
    if (typeof m.skill !== 'string' || !m.skill.endsWith('.md')) { warnSkip(label, 'skill must be a relative .md path'); return null; }
    const skillAbs = path.resolve(dir, m.skill);
    if (!isSafePluginPath(dir, skillAbs)) { warnSkip(label, `skill "${m.skill}" escapes the plugin directory`); return null; }
    if (!existsSync(skillAbs)) { warnSkip(label, `skill file not found: ${m.skill}`); return null; }
    skill = m.skill;
  }


  return {
    id: m.id,
    apiVersion: 1,
    description: m.description.trim(),
    hooks: [...m.hooks],
    requiredEnv,
    optionalEnv,
    allowedHosts,
    allowsLocalhost,
    entry,
    skill,
    humanInTheLoop: true,
    name: typeof m.name === 'string' ? m.name : undefined,
    version: typeof m.version === 'string' ? m.version : undefined,
    homepage: typeof m.homepage === 'string' ? m.homepage : undefined,
    dir,
  };
}

export function discoverPlugins(roots, overrideIds = new Set()) {
  const found = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      warnSkip(root, `unreadable — ${err.message}`);
      continue;
    }
    const isDirLike = (e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return statSync(path.join(root, e.name)).isDirectory();
      } catch {
        return false;
      }
    };
    const dirs = entries
      .filter(e => isDirLike(e) && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
    for (const name of dirs) {
      const dir = path.join(root, name);
      const manifestFile = path.join(dir, 'manifest.json');
      if (!existsSync(manifestFile)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
      } catch (err) {
        warnSkip(name, `manifest.json is invalid JSON — ${err.message}`);
        continue;
      }
      const manifest = validateManifest(parsed, dir, name);
      if (!manifest) continue;
      if (found.has(manifest.id)) {
        if (overrideIds.has(manifest.id)) found.set(manifest.id, manifest);
        continue;
      }
      found.set(manifest.id, manifest);
    }
  }
  return [...found.values()];
}

export function resolveSuccessorIds(root) {
  const ids = new Set();
  try {
    const reg = loadRegistry(root);
    const lock = readLock(root);
    for (const e of reg.plugins) {
      if (e.supersedesBundled !== true || typeof e.id !== 'string') continue;
      const localManifest = path.join(root, 'plugins.local', e.id, 'manifest.json');
      const installedSha = lock?.plugins?.[e.id]?.sha;
      if (existsSync(localManifest) && installedSha && installedSha === e.sha) ids.add(e.id);
    }
  } catch {
  }
  return ids;
}

export function pluginRoots(root) {
  return [path.join(root, 'plugins'), path.join(root, 'plugins.local')];
}

export function pluginStatus(manifest, cfg) {
  const entry = cfg?.plugins?.[manifest.id];
  const configured = entry?.enabled === true;
  const missingEnv = manifest.requiredEnv.filter(name => !process.env[name]);
  return { enabled: configured && missingEnv.length === 0, configured, missingEnv };
}

export function pluginSettings(id, cfg) {
  const entry = cfg?.plugins?.[id];
  if (!entry || typeof entry !== 'object') return {};
  const { enabled, ...rest } = entry;
  return rest;
}

function makeGuardedFetch(allowedHosts, { allowsLocalhost = false } = {}) {
  const allow = new Set(allowedHosts);
  const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(h);
  const hostOk = (u) => {
    if (u.protocol !== 'https:') {
      if (!(allowsLocalhost && u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
        throw new Error(`plugin egress must use HTTPS: ${u.href}`);
      }
    }
    if (allow.size > 0 && !allow.has(u.hostname)) throw new Error(`plugin egress to "${u.hostname}" is not in allowedHosts [${[...allow].join(', ')}]`);
  };
  return async function guardedFetch(url, opts = {}) {
    const { timeoutMs = 10_000, headers = {}, method = 'GET', body = null } = opts;
    let current = new URL(url);
    hostOk(current);
    await resolveAndValidate(current.hostname, { allowsLocalhost });
    let reqHeaders = { ...headers };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(current.href, {
          method, headers: reqHeaders, body, redirect: 'manual', signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current);
        hostOk(next);
        await resolveAndValidate(next.hostname, { allowsLocalhost });
        if (next.hostname !== current.hostname) {
          reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
        }
        current = next;
        continue;
      }
      if (!res.ok) {
        const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
        const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res;
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS}) for ${url}`);
  };
}

export function buildCtx(manifest, opts = {}) {
  const scoped = {};
  for (const name of [...manifest.requiredEnv, ...manifest.optionalEnv]) {
    if (process.env[name] !== undefined) scoped[name] = process.env[name];
  }
  const env = Object.freeze({ ...scoped });
  const secrets = manifest.requiredEnv
    .map(n => process.env[n])
    .filter(v => typeof v === 'string' && v.length >= 6);
  const guarded = makeGuardedFetch(manifest.allowedHosts, { allowsLocalhost: manifest.allowsLocalhost === true });
  const log = (...args) => {
    const redact = (s) => {
      let out = typeof s === 'string' ? s : String(s);
      for (const sec of secrets) out = out.split(sec).join('«redacted»');
      return out;
    };
    console.log(...args.map(redact));
  };
  return ({
    transport: 'http',
    fetch: guarded,
    fetchText: async (u, o) => (await guarded(u, o)).text(),
    fetchJson: async (u, o) => (await guarded(u, o)).json(),
    env,
    settings: Object.freeze({ ...(opts.settings || {}) }),
    log,
    dryRun: opts.dryRun === true,
    normalizePostingUrl: normalizeUrl,
  });
}

async function importHook(manifest, kind) {
  const entryAbs = path.join(manifest.dir, manifest.entry);
  let mod;
  try {
    mod = await import(pathToFileURL(entryAbs).href);
  } catch (err) {
    warnSkip(manifest.id, `failed to import ${manifest.entry} — ${err.message}`);
    return null;
  }
  const hooks = mod.default;
  if (!hooks || typeof hooks !== 'object') { warnSkip(manifest.id, 'entry default export must be an object of hooks'); return null; }
  const hook = hooks[kind];
  if (kind === 'provider') {
    if (!hook || typeof hook.fetch !== 'function' || typeof hook.id !== 'string') { warnSkip(manifest.id, 'provider hook must be { id, fetch }'); return null; }
  } else if (typeof hook !== 'function') {
    warnSkip(manifest.id, `${kind} hook must be a function`);
    return null;
  }
  return hook;
}

const SKILL_RED_FLAGS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instruction/i,
  /disregard\s+(the\s+)?(system|above|previous)/i,
  /you\s+are\s+now\b/i,
  /exfiltrat/i,
  new RegExp('modes/' + '_shared'),
  new RegExp('AGENTS' + '\\.md'),
  /human[- ]?in[- ]?the[- ]?loop\s*[:=]?\s*false/i,
  /humanInTheLoop\s*[:=]\s*false/i,
];

export function loadSkill(manifest, root) {
  if (!manifest.skill) return null;
  let body;
  try { body = readFileSync(path.join(manifest.dir, manifest.skill), 'utf8'); }
  catch { return null; }
  const flags = SKILL_RED_FLAGS.some(re => re.test(body))
    ? ['this skill contains phrases that resemble prompt-injection — review it before trusting']
    : [];
  return { body, flags, source: pluginSource(manifest, root) };
}

function pluginSource(manifest, root) {
  return manifest.dir.startsWith(path.join(root, 'plugins') + path.sep) ? 'bundled' : 'local';
}

export function lockGate(manifest, root) {
  const source = pluginSource(manifest, root);
  let lock;
  try { lock = readLock(root); } catch { return { load: true }; }
  const entry = lock.plugins?.[manifest.id];
  let d;
  try { d = diffPlugin(manifest, entry); }
  catch (err) { warnSkip(manifest.id, `integrity check failed — ${err.message}`); return { load: false }; }

  const repin = () => {
    try {
      const tree = hashPluginTree(manifest.dir);
      writeLockEntry(root, manifest.id, {
        source, version: manifest.version || '0.0.0',
        integrity: tree.integrity, files: tree.files, consent: consentSurface(manifest),
      });
    } catch { }
  };

  switch (d.status) {
    case 'unpinned': repin(); return { load: true };
    case 'match': return { load: true };
    case 'legit-update': repin(); return { load: true };
    case 'drift-nobump':
      if (source === 'bundled') { repin(); return { load: true }; }
      warnSkip(manifest.id, `files changed since you trusted it without a version bump — possible tampering (${d.changedFiles.slice(0, 5).join(', ')}). Review, then \`node plugins.mjs trust ${manifest.id}\``);
      return { load: false };
    case 'surface-widened':
      warnSkip(manifest.id, `capability surface expanded since you consented (${[...d.addedHosts, ...d.addedEnv].join(', ')}${manifest.allowsLocalhost ? ', localhost' : ''}) — re-consent: \`node plugins.mjs enable ${manifest.id}\``);
      return { load: false };
    default: return { load: true };
  }
}

export async function loadPlugins(kind, { root, dataRoot = root, dryRun = false, pluginId = null }) {
  const cfg = await loadPluginConfig(dataRoot);
  let manifests = discoverPlugins(pluginRoots(root), resolveSuccessorIds(root)).filter(m => m.hooks.includes(kind));
  if (pluginId) manifests = manifests.filter(m => m.id === pluginId);
  const out = [];
  for (const manifest of manifests) {
    if (!pluginStatus(manifest, cfg).enabled) continue;
    if (!lockGate(manifest, root).load) continue;
    const hook = await importHook(manifest, kind);
    if (!hook) continue;
    out.push({ id: manifest.id, manifest, hook, ctx: buildCtx(manifest, { dryRun, settings: pluginSettings(manifest.id, cfg) }) });
  }
  return out;
}

let dotenvLoaded = false;
export async function loadDotenvOnce(root = null) {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const { config } = await import('dotenv');
    config(root ? { path: path.join(root, '.env'), quiet: true } : { quiet: true });
  } catch {
  }
}

export async function runHook(kind, payload, { root, dataRoot = root, dryRun = false, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS, pluginId = null }) {
  await loadDotenvOnce(dataRoot);
  const loaded = await loadPlugins(kind, { root, dataRoot, dryRun, pluginId });
  const results = [];
  for (const { id, hook, ctx } of loaded) {
    const invoke = kind === 'search'
      ? Promise.resolve().then(() => hook(payload, ctx))
      : kind === 'export' || kind === 'notify'
        ? Promise.resolve().then(() => hook(payload, ctx))
        : Promise.resolve().then(() => hook(ctx));
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); });
    try {
      const result = await Promise.race([invoke, timeout]);
      results.push({ id, ok: true, result });
    } catch (err) {
      warnSkip(id, `${kind} hook failed — ${err.message}`);
      results.push({ id, ok: false, error: err.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

export function filterResultsForId(results, id) {
  return results.filter(r => r.id === id);
}

function inactiveProviderStub(id, reason) {
  return {
    id,
    detect: () => null,
    fetch: async () => { throw new Error(`plugin "${id}" inactive: ${reason}. Run \`node doctor.mjs\` for setup.`); },
  };
}

export async function mergeProviderPlugins(providersMap, { root, dataRoot = root }) {
  warnConfigLeftInCodeRoot(root, dataRoot);
  if (!existsSync(pluginsConfigPath(dataRoot))) return;

  try {
    const cfg = await loadPluginConfig(dataRoot);
    const providerManifests = discoverPlugins(pluginRoots(root), resolveSuccessorIds(root)).filter(m => m.hooks.includes('provider'));
    if (providerManifests.length === 0) return;

    const configuredOn = providerManifests.filter(m => cfg?.plugins?.[m.id]?.enabled === true);
    if (configuredOn.length === 0) return;

    await loadDotenvOnce(dataRoot);

    for (const manifest of configuredOn) {
      if (providersMap.has(manifest.id)) {
        warnSkip(manifest.id, 'a core provider already owns this id — plugin not merged');
        continue;
      }
      const { enabled, missingEnv } = pluginStatus(manifest, cfg);
      if (!enabled) {
        const reason = missingEnv.length ? `missing env ${missingEnv.join(', ')} — add to .env` : 'disabled in config/plugins.yml';
        providersMap.set(manifest.id, inactiveProviderStub(manifest.id, reason));
        continue;
      }
      if (!lockGate(manifest, root).load) {
        providersMap.set(manifest.id, inactiveProviderStub(manifest.id, 'integrity/consent check failed — see ⚠️ above; run `node plugins.mjs trust ' + manifest.id + '` or `enable ' + manifest.id + '`'));
        continue;
      }
      const hook = await importHook(manifest, 'provider');
      if (!hook) {
        providersMap.set(manifest.id, inactiveProviderStub(manifest.id, 'failed to load — see ⚠️ above'));
        continue;
      }
      const ctx = buildCtx(manifest, { settings: pluginSettings(manifest.id, cfg) });
      providersMap.set(manifest.id, {
        id: manifest.id,
        detect: () => null,
        fetch: (entry) => hook.fetch(entry, ctx),
      });
    }
  } catch (err) {
    warnSkip('plugins', `provider-plugin merge skipped this run — ${err.message}`);
  }
}
