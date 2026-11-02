import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

export function parseMeta(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const block = text.match(/<!--\s*career-ops-template\s*([\s\S]*?)-->/);
  if (!block) return {};
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.*?)\s*$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2];
  }
  return meta;
}

export const PARTIAL_SECTIONS = Object.freeze([
  'competencies', 'experience', 'projects', 'education', 'certifications', 'awards', 'skills',
]);

export function declaredSections(meta) {
  const raw = meta?.sections;
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (value.toLowerCase() === 'all') return new Set(PARTIAL_SECTIONS);
  const names = value.split(/[\s,]+/).filter(Boolean).map((n) => n.toLowerCase());
  if (names.length === 0) {
    throw new Error('manifest key "sections" is empty — write "all" or a list of section names');
  }
  const unknown = names.filter((n) => !PARTIAL_SECTIONS.includes(n));
  if (unknown.length) {
    throw new Error(
      `manifest key "sections" names unknown section${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} `
        + `(known: ${PARTIAL_SECTIONS.join(', ')}, or "all")`
    );
  }
  return new Set(names);
}

export function checkDeclaredSections(templatePath) {
  const declared = declaredSections(parseMeta(templatePath));
  if (!declared) return { declared: null, missing: [] };
  const sectionsDir = resolve(dirname(templatePath), 'sections');
  const missing = PARTIAL_SECTIONS.filter(
    (name) => declared.has(name) && !existsSync(resolve(sectionsDir, `${name}.html`))
  );
  return { declared, missing };
}

