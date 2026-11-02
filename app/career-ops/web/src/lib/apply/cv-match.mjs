import fs from 'node:fs';
import path from 'node:path';

export function hasToken(filenameLower, token) {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(filenameLower);
}

export function matchesTailoredCv(filenameLower, slug) {
  if (!filenameLower.startsWith('cv-')) return false;
  return hasToken(filenameLower, slug);
}

export function matchesTailoredCover(filenameLower, slug) {
  if (filenameLower.startsWith('cv-')) return false;
  if (!hasToken(filenameLower, 'cover')) return false;
  return hasToken(filenameLower, slug);
}

export function sortNewestFirst(dir, files) {
  return files
    .map((f) => {
      try {
        return { f, mtime: statMtime(dir, f) };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.f);
}

function statMtime(dir, f) {
  const stat = fs.statSync(path.join(dir, f));
  if (!stat.isFile()) throw new Error(`${f} is not a file`);
  return stat.mtimeMs;
}
