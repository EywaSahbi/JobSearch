import { createHash } from 'crypto';
import { normalizeTextKey } from './tracker-parse.mjs';

export const FINGERPRINT_MIN_TEXT = 200;

export const CROSSLIST_THRESHOLD = 0.92;

export const CROSSLIST_WINDOW_DAYS = 90;

export function normalizeJdText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function fingerprintText(text) {
  const normalized = normalizeJdText(text);
  if (normalized.length < FINGERPRINT_MIN_TEXT) return '';
  const tokens = normalized.split(' ');
  if (tokens.length < 3) return '';
  const weights = new Array(64).fill(0);
  for (let i = 0; i <= tokens.length - 3; i++) {
    const shingle = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    const digest = createHash('sha1').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3];
      weights[bit] += (byte >> (7 - (bit & 7))) & 1 ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) hash |= 1n << BigInt(63 - bit);
  }
  return hash.toString(16).padStart(16, '0');
}

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const POPCOUNT16 = (() => {
  const table = new Uint8Array(1 << 16);
  for (let i = 1; i < table.length; i++) table[i] = table[i >> 1] + (i & 1);
  return table;
})();

function popcount32(x) {
  return POPCOUNT16[x & 0xffff] + POPCOUNT16[(x >>> 16) & 0xffff];
}

function splitFingerprint(fp) {
  const s = String(fp);
  return { hi: parseInt(s.slice(0, 8), 16) | 0, lo: parseInt(s.slice(8, 16), 16) | 0 };
}

export function similarity(a, b) {
  if (!FINGERPRINT_RE.test(a || '') || !FINGERPRINT_RE.test(b || '')) return 0;
  const x = splitFingerprint(a);
  const y = splitFingerprint(b);
  return 1 - (popcount32(x.hi ^ y.hi) + popcount32(x.lo ^ y.lo)) / 64;
}

function maxDistanceFor(threshold) {
  for (let d = 0; d <= 64; d++) {
    if (!(1 - d / 64 >= threshold)) return d - 1;
  }
  return 64;
}

function companyKey(name) {
  return normalizeTextKey(String(name ?? ''));
}

export function findCrossListings(offers, historyRows, opts = {}) {
  const threshold = opts.threshold ?? CROSSLIST_THRESHOLD;
  const windowDays = opts.windowDays ?? CROSSLIST_WINDOW_DAYS;
  const today = opts.today ? new Date(opts.today) : new Date();
  const cutoff = today.getTime() - windowDays * 86400000;
  const maxDist = maxDistanceFor(threshold);
  const zeroScores = 0 >= threshold;

  const recent = [];
  for (const row of historyRows) {
    if (!row.fingerprint) continue;
    const t = Date.parse(row.dateStr);
    if (Number.isNaN(t) || t < cutoff) continue;
    const valid = FINGERPRINT_RE.test(row.fingerprint);
    const half = valid ? splitFingerprint(row.fingerprint) : null;
    recent.push({ row, key: companyKey(row.company), url: row.url, valid, hi: half ? half.hi : 0, lo: half ? half.lo : 0 });
  }

  const matches = [];
  for (const offer of offers) {
    if (!offer.fingerprint) continue;
    const offerCompany = companyKey(offer.company);
    const offerValid = FINGERPRINT_RE.test(offer.fingerprint);
    if (!offerValid && !zeroScores) continue;
    const half = offerValid ? splitFingerprint(offer.fingerprint) : null;
    const offerHi = half ? half.hi : 0;
    const offerLo = half ? half.lo : 0;
    for (const cand of recent) {
      if (cand.key === offerCompany) continue;
      if (cand.url === offer.url) continue;
      let score;
      if (offerValid && cand.valid) {
        const dist = popcount32(offerHi ^ cand.hi) + popcount32(offerLo ^ cand.lo);
        if (dist > maxDist) continue;
        score = 1 - dist / 64;
      } else {
        if (!zeroScores) continue;
        score = 0;
      }
      matches.push({ offer, row: cand.row, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}
