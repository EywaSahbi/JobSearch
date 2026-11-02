import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalize, num, pickBestMatch, plausibleMatch } from './api.mjs';

const DEFAULT_INDEX = fileURLToPath(new URL('../../../data/h1b/index.ndjson.gz', import.meta.url));

const STAFFING_BASIS = 'secondary_entity_share';

const SEARCH_PAGE = 50;

const MAX_CANDIDATES = 500;

function evidence(rec) {
  return (num(rec && rec.filed) ?? 0) + (num(rec && rec.pwd) ?? 0) + (num(rec && rec.perm) ?? 0);
}

function byRank(a, b) {
  const av = evidence(a);
  const bv = evidence(b);
  if (av !== bv) return bv - av;
  const an = String((a && a.n) ?? '');
  const bn = String((b && b.n) ?? '');
  if (an !== bn) return an < bn ? -1 : 1;
  const ak = String((a && a.k) ?? '');
  const bk = String((b && b.k) ?? '');
  if (ak === bk) return 0;
  return ak < bk ? -1 : 1;
}

function boundedTop(limit) {
  const items = [];
  const trim = () => {
    items.sort(byRank);
    if (items.length > limit) items.length = limit;
  };
  return {
    push(rec) {
      items.push(rec);
      if (items.length >= limit * 2) trim();
    },
    drain() {
      trim();
      return items;
    },
  };
}

export function indexPath() {
  const raw = process.env.H1B_INDEX_PATH;
  if (raw === undefined) return DEFAULT_INDEX;
  const trimmed = String(raw).trim();
  if (!trimmed) {
    throw new Error('H1B_INDEX_PATH is set but empty. Unset it to use the default index location.');
  }
  return trimmed;
}

export function metaPath(file = indexPath()) {
  return `${file}.meta.json`;
}

export function hasIndex(file = indexPath()) {
  return existsSync(file);
}

const SHA256_RE = /^[0-9a-f]{64}$/;
let cachedDigest = null;

export async function indexDigest(file = indexPath()) {
  if (cachedDigest && cachedDigest.file === file) return cachedDigest.digest;

  let size;
  try {
    size = statSync(file).size;
  } catch {
    const e = new Error(`H-1B index not found: ${file}`);
    e.code = 'INDEX_MISSING';
    throw e;
  }

  let digest = null;
  try {
    const meta = JSON.parse(await readFile(metaPath(file), 'utf8'));
    if (meta && SHA256_RE.test(String(meta.sha256)) && Number(meta.bytes) === size) {
      digest = String(meta.sha256);
    }
  } catch { }

  if (!digest) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    digest = hash.digest('hex');
  }

  cachedDigest = { file, digest };
  return digest;
}

export async function indexSource(file = indexPath()) {
  return `local:h1b-index@sha256-${(await indexDigest(file)).slice(0, 12)}`;
}

async function* readRecords(file) {
  const source = createReadStream(file);
  const gunzip = createGunzip();
  source.on('error', err => gunzip.destroy(err));
  const rl = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec && typeof rec === 'object' && typeof rec.n === 'string' && num(rec.filed) !== null) yield rec;
    }
  } catch (err) {
    const e = new Error(`H-1B index unreadable (${file}): ${err && err.message ? err.message : err}`);
    e.code = 'INDEX_UNREADABLE';
    throw e;
  } finally {
    rl.close();
    gunzip.destroy();
    source.destroy();
  }
}

const seen = new Map();
const memoKey = (file, id) => `${file}\u0000${id}`;

function indexFile(opts) {
  return opts.indexPath || indexPath();
}

function recordToProfile(rec) {
  const nPwd = num(rec.pwd) ?? 0;
  const nPerm = num(rec.perm) ?? 0;
  return {
    n_lca: num(rec.filed) ?? 0,
    n_certified: num(rec.cert) ?? null,
    n_pwd: nPwd,
    n_perm: nPerm,
    does_gc: rec.gc === true || nPwd > 0 || nPerm > 0,
    first_year: num(rec.fy),
    last_year: num(rec.ly),
    red_flags: {
      staffing_shop: {
        value: rec.sv === true,
        share: typeof rec.sh === 'number' ? rec.sh : null,
        n_secondary: num(rec.ns),
        n_total: num(rec.filed),
        basis: STAFFING_BASIS,
      },
    },
    employer_name: rec.n ?? null,
    employer_id: rec.k ?? null,
  };
}

export async function resolveEmployer(name, opts = {}) {
  const q = String(name || '').trim();
  if (q.length < 2) return null;

  const file = indexFile(opts);
  const target = normalize(q);
  const exact = [];
  const plausible = boundedTop(MAX_CANDIDATES);
  for await (const rec of readRecords(file)) {
    const isExact = normalize(rec.n) === target;
    if (!isExact && !plausibleMatch(q, rec.n)) continue;
    seen.set(memoKey(file, rec.k), rec);
    if (isExact) exact.push(rec);
    else plausible.push(rec);
  }

  const candidates = [...exact, ...plausible.drain()].sort(byRank);
  const match = pickBestMatch(q, candidates.map(r => ({ id: String(r.k), name: String(r.n) })));
  if (!match || !match.id) return null;
  return { id: String(match.id), displayName: String(match.name || q) };
}

export async function searchEmployers(name, opts = {}) {
  const q = String(name || '').trim();
  if (q.length < 2) return { total: 0, results: [] };

  const target = normalize(q);
  const page = boundedTop(SEARCH_PAGE);
  let total = 0;
  for await (const rec of readRecords(indexFile(opts))) {
    if (!normalize(rec.n).includes(target)) continue;
    total++;
    page.push(rec);
  }
  return { total, results: page.drain().map(r => ({ id: String(r.k), name: String(r.n) })) };
}

export async function getEmployerProfile(id, opts = {}) {
  const sanitized = String(id || '').trim();
  if (!sanitized) throw new Error('getEmployerProfile: id is required');

  const file = indexFile(opts);
  const memo = seen.get(memoKey(file, sanitized));
  if (memo) return recordToProfile(memo);

  for await (const rec of readRecords(file)) {
    if (String(rec.k) !== sanitized) continue;
    seen.set(memoKey(file, sanitized), rec);
    return recordToProfile(rec);
  }
  return null;
}
