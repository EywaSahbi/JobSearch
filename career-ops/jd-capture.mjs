import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

export function captureSlug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function reportPrefix(num) {
  return String(num).padStart(3, '0');
}

function companyMatches(filename, slug) {
  if (slug === '') return false;
  const rest = filename
    .replace(/^\d+-/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[_-]/, '')
    .toLowerCase();
  const s = slug.toLowerCase();
  if (!rest.startsWith(s)) return false;
  const next = rest.charAt(s.length);
  return next === '' || next === '-' || next === '_' || next === '.';
}

export function findCaptureForReport(jdsDir, reportNum, { companySlug } = {}) {
  const target = Number(reportNum);
  if (!Number.isInteger(target) || target <= 0) return null;

  let entries;
  try {
    entries = readdirSync(jdsDir);
  } catch {
    return null;
  }

  const matches = entries.filter(name => {
    const m = /^(\d+)-/.exec(name);
    return m ? parseInt(m[1], 10) === target : false;
  });
  if (matches.length === 0) return null;

  const byRecency = matches
    .map(name => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(jdsDir, name)).mtimeMs;
      } catch { }
      return { name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

  let chosen = byRecency[0];
  if (companySlug !== undefined && companySlug !== null) {
    chosen = byRecency.find(e => companyMatches(e.name, String(companySlug)));
    if (!chosen) return null;
  }

  return {
    path: join(jdsDir, chosen.name),
    filename: chosen.name,
    ext: extname(chosen.name),
    candidates: byRecency.map(e => e.name),
  };
}
