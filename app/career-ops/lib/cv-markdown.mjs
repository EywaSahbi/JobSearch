const THEMATIC_BREAK_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW_RE = /^\s*\|/;

export function normalizePandocLine(line) {
  let s = String(line ?? '').replace(/\r$/, '');
  s = s.replace(/(?<!\\)\\\s*$/, '');
  s = s.replace(/\[([^\]\n]*)\]\{[^}\n]*\}/g, '$1');
  if (!THEMATIC_BREAK_RE.test(s) && !TABLE_ROW_RE.test(s)) {
    s = s.replace(/(?<!-)---(?!-)/g, '—').replace(/(?<!-)--(?!-)/g, '–');
  }
  return s;
}

export function toPlainText(text) {
  return String(text ?? '')
    .replace(/(?<!\\)(\*\*|__)/g, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingText(line, level) {
  const m = String(line ?? '').match(new RegExp(`^#{${level}}\\s+(.+?)\\s*$`));
  if (!m) return null;
  const text = m[1]
    .replace(/\s*\{[^}]*\}\s*$/, '')
    .replace(/\s+#+\s*$/, '');
  return toPlainText(text);
}

export function boldLineText(line) {
  const m = String(line ?? '').match(/^(\*\*|__)(.+?)\1\s*$/);
  return m ? toPlainText(m[2]) : null;
}

const EXPERIENCE_HEADING_RE = /^(?:(?:work|professional)\s+)?experience$|^(?:employment|work)\s+history$/i;

export const EXPERIENCE_HEADING_NAMES = [
  'Experience', 'Work Experience', 'Professional Experience', 'Employment History', 'Work History',
];

export function isExperienceHeading(text) {
  return EXPERIENCE_HEADING_RE.test(String(text ?? '').trim());
}

export function parseCompanyHeading(line) {
  const header = headingText(line, 3);
  if (header === null) return null;
  const match = header.match(/^(.+?)\s+(?:—|–|--|-)\s+(.+)$/);
  return match ? { company: match[1].trim(), location: match[2].trim() } : null;
}

export function findExperienceSections(cvText) {
  const lines = String(cvText ?? '').replace(/\r\n/g, '\n').split('\n').map(normalizePandocLine);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h2 = headingText(line, 2);
    if (h2 !== null) {
      current = isExperienceHeading(h2) ? [] : null;
      if (current) sections.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return sections;
}
