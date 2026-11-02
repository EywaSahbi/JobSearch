import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('../../../data/cache/h1b', import.meta.url));
const DEFAULT_TTL_DAYS = 90;
const DEFAULT_NEG_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

export function cacheKey(name) {
  const raw = typeof name === 'string' ? name : '';
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(raw.toLowerCase().trim()).digest('hex').slice(0, 8);
  return `${(slug || 'noname').slice(0, 80)}-${digest}`;
}

function entryPath(cacheDir, name) {
  return path.join(cacheDir, `${cacheKey(name)}.json`);
}

export async function readCache(name, opts = {}) {
  const cacheDir = opts.cacheDir ?? DEFAULT_DIR;
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : DEFAULT_TTL_DAYS;
  const negTtlDays = Number.isFinite(opts.negativeTtlDays) ? opts.negativeTtlDays : DEFAULT_NEG_TTL_DAYS;

  let raw;
  try {
    raw = await readFile(entryPath(cacheDir, name), 'utf8');
  } catch {
    return null;
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object' || typeof entry.fetchedAt !== 'string') return null;
  if (!('data' in entry)) return null;

  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;

  const age = Date.now() - fetchedAt;
  if (age < 0) return null;

  const ttl = entry.negative === true ? negTtlDays : ttlDays;
  if (age > ttl * DAY_MS) return null;

  return entry;
}

export async function writeCache(name, data, opts = {}) {
  const cacheDir = opts.cacheDir ?? DEFAULT_DIR;
  const negative = opts.negative === true;

  await mkdir(cacheDir, { recursive: true });

  const fetchedAt = typeof opts.fetchedAt === 'string' ? opts.fetchedAt : new Date().toISOString();
  const entry = { data, fetchedAt };
  if (negative) entry.negative = true;

  const finalPath = entryPath(cacheDir, name);
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf8');
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  return entry;
}
