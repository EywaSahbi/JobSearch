#!/usr/bin/env node

import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join, resolve } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function activityDirFor(options = {}) {
  const dir = resolve(options.activityDir
    || process.env.CAREER_OPS_ACTIVITY_DIR
    || join(options.rootDir || ROOT, '.career-ops-locks', 'active'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function keyFingerprint(key) {
  return createHash('sha1').update(String(key)).digest('hex');
}

function sentinelPath(activityDir, key) {
  return join(activityDir, `${keyFingerprint(key)}.json`);
}

function readSentinel(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return err?.code === 'EPERM' ? true : null;
  }
}

function isStale(entry, path, ttlMs) {
  if (!entry) return true;
  try {
    if (Date.now() - statSync(path).mtimeMs > ttlMs) return true;
  } catch {
    return true;
  }
  if (entry.pid) {
    const alive = processIsAlive(entry.pid);
    if (entry.process_bound === true && alive === false) return true;
  }
  return false;
}

export function checkActivity(key, options = {}) {
  const activityDir = activityDirFor(options);
  const path = sentinelPath(activityDir, key);
  if (!existsSync(path)) return { active: false, owner: null };

  const entry = readSentinel(path);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (isStale(entry, path, ttlMs)) return { active: false, owner: null };
  return { active: true, owner: entry };
}

export function claimActivity(key, options = {}) {
  const activityDir = activityDirFor(options);
  const path = sentinelPath(activityDir, key);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const existing = readSentinel(path);
  if (existing && !isStale(existing, path, ttlMs)) {
    return { claimed: false, owner: existing, token: null };
  }
  if (existing) {
    try { unlinkSync(path); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  }

  const token = randomUUID();
  const entry = {
    key: String(key),
    token,
    pid: process.pid,
    process_bound: options.processBound === true,
    label: options.label || null,
    claimed_at: new Date().toISOString(),
  };
  try {
    writeFileSync(path, JSON.stringify(entry), { flag: 'wx' });
    return { claimed: true, owner: entry, token };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    return { claimed: false, owner: readSentinel(path), token: null };
  }
}

export function releaseActivity(key, options = {}) {
  const activityDir = activityDirFor(options);
  const path = sentinelPath(activityDir, key);
  const force = options.force === true;
  if (!force && !options.token) throw new Error('Claim ownership token is required for release');
  try {
    const entry = readSentinel(path);
    if (!force && entry?.token !== options.token) return false;
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export function gcStaleActivity(options = {}) {
  const activityDir = activityDirFor(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let removed = 0;
  for (const name of readdirSync(activityDir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(activityDir, name);
    const entry = readSentinel(path);
    if (isStale(entry, path, ttlMs)) {
      try { unlinkSync(path); removed++; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    }
  }
  return removed;
}

export function describeActiveOwner(owner) {
  if (!owner) return null;
  const started = owner.claimed_at ? new Date(owner.claimed_at) : null;
  const ageMin = started ? Math.max(0, Math.round((Date.now() - started.getTime()) / 60_000)) : null;
  const when = ageMin == null ? 'a little while ago' : ageMin < 1 ? 'just now' : `${ageMin} min ago`;
  const label = owner.label ? ` (${owner.label})` : '';
  return `another session appears to already be active on "${owner.key}"${label}, started ${when} — continuing anyway`;
}

function runCli() {
  const [,, cmd, arg] = process.argv;
  const labelIdx = process.argv.indexOf('--label');
  const label = labelIdx > -1 ? process.argv[labelIdx + 1] : undefined;
  const tokenIdx = process.argv.indexOf('--token');
  const token = tokenIdx > -1 ? process.argv[tokenIdx + 1] : undefined;
  const ttlIdx = process.argv.indexOf('--ttl-ms');
  const ttlMs = ttlIdx > -1 ? Number(process.argv[ttlIdx + 1]) : undefined;

  if (cmd === '--help' || cmd === '-h' || !cmd) {
    process.stdout.write([
      'Usage: node session-activity.mjs <claim|check|release|gc> [key] [options]',
      '',
      '  claim <key> [--label text] [--ttl-ms N]   Claim key as active (never blocks)',
      '  check <key>                                Report whether key is currently claimed',
      '  release <key> --token <token>              Release a claim this caller owns',
      '  gc                                          Remove stale sentinels',
      '',
    ].join('\n'));
    return 0;
  }

  if (cmd === 'claim') {
    if (!arg) { process.stderr.write('Usage: node session-activity.mjs claim <key>\n'); return 1; }
    const result = claimActivity(arg, { label, ttlMs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (cmd === 'check') {
    if (!arg) { process.stderr.write('Usage: node session-activity.mjs check <key>\n'); return 1; }
    const result = checkActivity(arg, { ttlMs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (cmd === 'release') {
    if (!arg) { process.stderr.write('Usage: node session-activity.mjs release <key> --token <token>\n'); return 1; }
    const released = releaseActivity(arg, { token });
    process.stdout.write(`${JSON.stringify({ released })}\n`);
    return 0;
  }

  if (cmd === 'gc') {
    const removed = gcStaleActivity({ ttlMs });
    process.stdout.write(`${JSON.stringify({ removed })}\n`);
    return 0;
  }

  process.stderr.write(`session-activity: unknown command "${cmd}"\n`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}
