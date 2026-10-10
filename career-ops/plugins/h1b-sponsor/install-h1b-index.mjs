#!/usr/bin/env node

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { fetchWithTimeout, readBoundedText } from './lib/api.mjs';
import { indexPath, metaPath } from './lib/index.mjs';

const REPO = 'msampath/h1b-sponsor-data';
const DEFAULT_TAG = 'index-latest';
const POINTER = 'index-latest.json';
const USER_AGENT = 'career-ops-plugin-h1b-sponsor/1.0';
const USAGE = 'Usage: node plugins/h1b-sponsor/install-h1b-index.mjs [--tag <release>] [--force]';

const RELEASE_ORIGINS = [
  'https://github.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
];
const MAX_REDIRECTS = 5;

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_POINTER_BYTES = 4 * 1024;
const POINTER_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 300_000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assetUrl(tag, name) {
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function guardedFetch(url, opts, consume) {
  return fetchWithTimeout(url, {
    headers: { 'Accept': '*/*', 'User-Agent': USER_AGENT },
    allowedOrigins: RELEASE_ORIGINS,
    maxRedirects: MAX_REDIRECTS,
    ...opts,
  }, consume);
}

async function fetchPointer(fetchImpl, url) {
  const out = await fetchImpl(url, { timeoutMs: POINTER_TIMEOUT_MS }, async res => {
    if (res.status !== 200) return { status: res.status };
    const read = await readBoundedText(res, MAX_POINTER_BYTES);
    return read.oversized ? { oversized: true } : { text: read.text };
  });
  if (out.status) throw new Error(`could not read the release pointer (HTTP ${out.status}): ${url}`);
  if (out.oversized) throw new Error(`the release pointer is implausibly large: ${url}`);

  let doc;
  try {
    doc = JSON.parse(String(out.text || ''));
  } catch {
    throw new Error(`the release pointer is not JSON: ${url}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error(`the release pointer is not an object: ${url}`);

  const filename = String(doc.filename || '');
  if (!FILENAME_RE.test(filename)) {
    throw new Error(`the release pointer names an unusable index filename (${JSON.stringify(doc.filename)}): ${url}`);
  }
  const sha256 = String(doc.sha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`the release pointer does not carry a sha256 digest: ${url}`);
  }
  const version = doc.version === undefined || doc.version === null
    ? null
    : String(doc.version).slice(0, 64);
  return { filename, sha256, version };
}

async function downloadAsset(fetchImpl, url, tmpFile) {
  return fetchImpl(url, { timeoutMs: ASSET_TIMEOUT_MS }, async res => {
    if (res.status !== 200) throw new Error(`could not download the index (HTTP ${res.status}): ${url}`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_INDEX_BYTES) {
      throw new Error(`the published index exceeds ${MAX_INDEX_BYTES} bytes (${declared}): ${url}`);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error(`the index response carried no readable body: ${url}`);
    }

    const hash = createHash('sha256');
    const out = createWriteStream(tmpFile);
    let writeError = null;
    out.on('error', err => { writeError = err; });
    const reader = res.body.getReader();
    let total = 0;
    try {
      for (;;) {
        if (writeError) {
          await reader.cancel().catch(() => {});
          throw writeError;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_INDEX_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`the published index exceeds ${MAX_INDEX_BYTES} bytes: ${url}`);
        }
        hash.update(value);
        if (!out.write(value)) await once(out, 'drain');
      }
    } finally {
      await new Promise(resolve => out.end(resolve));
    }
    if (writeError) throw writeError;
    return { digest: hash.digest('hex'), bytes: total };
  });
}

export async function installIndex({ fetchImpl = guardedFetch, tag = null, force = false, targetPath } = {}) {
  let target;
  try {
    target = targetPath || indexPath();
  } catch (err) {
    return { ok: false, exitCode: 1, message: (err && err.message) ? err.message : String(err) };
  }

  if (existsSync(target) && !force) {
    return {
      ok: false,
      exitCode: 0,
      message: `an index is already installed at ${target}. Pass --force to replace it with the current release.`,
    };
  }

  const release = tag || DEFAULT_TAG;
  const tmpFile = `${target}.${randomUUID()}.tmp`;
  let pointer;
  try {
    pointer = await fetchPointer(fetchImpl, assetUrl(release, POINTER));
  } catch (err) {
    return { ok: false, exitCode: 1, message: (err && err.message) ? err.message : String(err) };
  }
  const expected = pointer.sha256;
  const url = assetUrl(release, pointer.filename);

  try {
    await mkdir(path.dirname(target), { recursive: true });
    const { digest, bytes } = await downloadAsset(fetchImpl, url, tmpFile);
    if (digest !== expected) {
      await unlink(tmpFile).catch(() => {});
      return {
        ok: false,
        exitCode: 1,
        message: `checksum mismatch: the download hashed to ${digest} but the release publishes ${expected}. Nothing was installed.`,
      };
    }
    await rename(tmpFile, target);
    await writeFile(metaPath(target), `${JSON.stringify({
      sha256: digest,
      bytes,
      version: pointer.version,
      filename: pointer.filename,
      url,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return { ok: true, target, bytes, digest, url, version: pointer.version, filename: pointer.filename };
  } catch (err) {
    await unlink(tmpFile).catch(() => {});
    const reason = (err && err.name === 'AbortError')
      ? `no response within ${ASSET_TIMEOUT_MS / 1000}s`
      : ((err && err.message) ? err.message : String(err));
    return { ok: false, exitCode: 1, message: `could not install the index (${reason})` };
  }
}

function parseArgs(argv) {
  const args = { tag: null, force: false, ok: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--tag') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || !next.trim() || next.startsWith('-')) { args.ok = false; break; }
      args.tag = next.trim();
      i++;
    } else args.ok = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const result = await installIndex({ tag: args.tag, force: args.force });
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
    return;
  }
  process.stdout.write([
    `installed ${(result.bytes / 1048576).toFixed(1)} MiB to ${result.target}`,
    `build ${result.version || result.filename}`,
    `sha256 ${result.digest}`,
    '',
    'Lookups now run locally and send nothing. Refresh when DOL publishes a new',
    'quarter by re-running this command with --force.',
  ].join('\n') + '\n');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`could not install the index (${(err && err.message) ? err.message : err})\n`);
    process.exitCode = 1;
  });
}
