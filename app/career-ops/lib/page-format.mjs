import { existsSync, readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

export const PAGE_FORMATS = new Set(['a4', 'letter']);

export const DEFAULT_PAGE_FORMAT = 'letter';

export const PROFILE_PAGE_FORMAT_KEY = 'page_format';

export const PAGE_WIDTHS = { a4: '210mm', letter: '8.5in' };

export const PAGE_CSS_SIZE = { a4: 'A4', letter: 'Letter' };

export function normalizePageFormat(value) {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return PAGE_FORMATS.has(lower) ? lower : null;
}

export function readProfilePageFormat(profilePath) {
  try {
    if (!profilePath || !existsSync(profilePath)) return null;
    const doc = yaml.load(readFileSync(profilePath, 'utf-8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    return normalizePageFormat(doc[PROFILE_PAGE_FORMAT_KEY]);
  } catch {
    return null;
  }
}

export function resolvePageFormat(explicit, { profilePath } = {}) {
  return (
    normalizePageFormat(explicit) ??
    readProfilePageFormat(profilePath) ??
    DEFAULT_PAGE_FORMAT
  );
}
