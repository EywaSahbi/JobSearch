import { readFileSync } from 'fs';

export const LEGACY_COLMAP = {
  num: 1, date: 2, company: 3, role: 4, score: 5, status: 6, pdf: 7, report: 8, notes: 9,
};

export const HEADER_ALIASES = (() => {
  const src = new URL('./tracker-aliases.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(src, 'utf-8'));
  } catch (e) {
    throw new Error(
      `tracker-parse.mjs: cannot load tracker-aliases.json (${e.message}). ` +
      'The file ships with career-ops next to tracker-parse.mjs — restore it ' +
      'from the repo or re-run: node update-system.mjs apply',
    );
  }
})();

export const SCORE_CELL_RE = /^\d+(?:\.\d+)?\/5$/;

export function looksLikeScoreCell(v) {
  const t = String(v ?? '').replace(/\*\*/g, '').trim();
  return SCORE_CELL_RE.test(t) || t === 'N/A' || t === 'DUP' || t === '—' || t === '-';
}

export const SEPARATOR_ROW_RE = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;

export function isSeparatorRow(line) {
  return typeof line === 'string' && SEPARATOR_ROW_RE.test(line);
}

const REQUIRED_HEADER_FIELDS = ['num', 'company', 'role', 'score', 'status'];

function headerSchemaMap(cells) {
  const map = {};
  cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
  return REQUIRED_HEADER_FIELDS.every(k => map[k] != null) ? map : null;
}

export function isHeaderRow(line) {
  if (typeof line !== 'string' || !line.startsWith('|')) return false;
  return headerSchemaMap(line.split('|').map(s => s.trim().toLowerCase())) !== null;
}

export function resolveScoreStatus(a, b) {
  const aScore = looksLikeScoreCell(a);
  const bScore = looksLikeScoreCell(b);
  if (aScore === bScore) return null;
  return aScore ? { score: a, status: b } : { score: b, status: a };
}

export const TSV_REQUIRED_FIELDS = ['num', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report'];

export const TSV_ADDITION_HEADER = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes'].join('\t');

const TSV_HEADER_MIN_LABELS = 3;

export function looksLikeTsvHeaderRow(cells) {
  if (!Array.isArray(cells) || cells.length < TSV_HEADER_MIN_LABELS) return false;
  if (/^\d+$/.test(String(cells[0] ?? '').trim())) return false;
  const recognized = new Set();
  for (const c of cells) {
    const key = HEADER_ALIASES[String(c ?? '').trim().toLowerCase()];
    if (key != null) recognized.add(key);
  }
  return recognized.size >= TSV_HEADER_MIN_LABELS;
}

export function resolveTsvColumns(cells) {
  const map = {};
  const duplicates = [];
  const unknown = [];
  (cells || []).forEach((c, i) => {
    const label = String(c ?? '').trim();
    if (!label) return;
    const key = HEADER_ALIASES[label.toLowerCase()];
    if (key == null) { unknown.push(label); return; }
    if (map[key] != null) { duplicates.push(key); return; }
    map[key] = i;
  });
  const missing = TSV_REQUIRED_FIELDS.filter(k => map[k] == null);
  return { map, missing, duplicates, unknown };
}

export function trackerRowSeparator(line) {
  return line.includes('\t') && line.split('|').length <= 3 ? '\t' : '|';
}

export function splitTrackerCells(line) {
  if (trackerRowSeparator(line) === '|') return line.split('|');
  const opening = line.indexOf('|');
  if (opening < 0) return line.split('|');
  const closing = line.trimEnd().endsWith('|') ? line.lastIndexOf('|') : -1;
  const body = line.slice(opening + 1, closing > opening ? closing : undefined);
  return [line.slice(0, opening), ...body.split('\t'), ...(closing > opening ? [line.slice(closing + 1)] : [])];
}

export function detectColumns(lines, { allowTabs = false, allowIndentation = false } = {}) {
  for (const line of lines) {
    if (!(allowIndentation ? line.trimStart() : line).startsWith('|')) continue;
    const cells = allowTabs ? splitTrackerCells(line) : line.split('|');
    const map = headerSchemaMap(cells.map(s => s.trim().toLowerCase()));
    if (map) return map;
  }
  return null;
}

export function resolveColumns(lines, options) {
  return detectColumns(lines, options) || LEGACY_COLMAP;
}

export function parseTrackerRow(line, colmap = LEGACY_COLMAP, { allowTabs = false, allowIndentation = false } = {}) {
  if (typeof line !== 'string' || !(allowIndentation ? line.trimStart() : line).startsWith('|')) return null;
  const parts = (allowTabs ? splitTrackerCells(line) : line.split('|')).map(s => s.trim());
  const width = Math.max(...Object.values(colmap)) + (line.trimEnd().endsWith('|') ? 2 : 1);
  if (parts.length < width) return null;
  const num = parseInt(parts[colmap.num], 10);
  if (isNaN(num)) return null;
  const at = (k) => (colmap[k] != null ? (parts[colmap[k]] ?? '') : '');
  const row = {
    num,
    date: at('date'),
    company: at('company'),
    role: at('role'),
    score: at('score'),
    status: at('status'),
    pdf: at('pdf'),
    report: at('report'),
    notes: at('notes'),
    url: extractCellUrl(at('url')),
    raw: line,
  };
  if (colmap.location != null) row.location = at('location');
  if (colmap.via != null) row.via = at('via');
  return row;
}

export const REQ_NUMBER_RE = /\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/i;

export function extractReqNumber(notes) {
  if (!notes) return null;
  const m = String(notes).match(REQ_NUMBER_RE);
  return m ? m[1].toUpperCase() : null;
}

function markdownLinkDestination(raw) {
  const value = String(raw).trimStart();
  if (value.startsWith('<')) {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === '\\') {
        i++;
      } else if (value[i] === '>') {
        return value.slice(1, i).replace(/\\([\\()<> ])/g, '$1');
      }
    }
    return null;
  }

  let depth = 0;
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === '(') depth++;
    else if (value[i] === ')' && depth > 0) depth--;
    else if (/\s/.test(value[i]) && depth === 0) {
      end = i;
      break;
    }
  }
  const destination = value.slice(0, end).trim();
  return destination ? destination.replace(/\\([\\()<> ])/g, '$1') : null;
}

export function parseMarkdownLinks(value) {
  const links = [];
  let cursor = 0;
  while (cursor < value.length) {
    const labelStart = value.indexOf('[', cursor);
    if (labelStart === -1) break;

    let labelEnd = -1;
    for (let i = labelStart + 1; i < value.length; i++) {
      if (value[i] === '\\') i++;
      else if (value[i] === ']') {
        labelEnd = i;
        break;
      }
    }
    if (labelEnd === -1 || value[labelEnd + 1] !== '(') {
      cursor = labelStart + 1;
      continue;
    }

    let depth = 1;
    let linkEnd = -1;
    for (let i = labelEnd + 2; i < value.length; i++) {
      if (value[i] === '\\') {
        i++;
      } else if (value[i] === '(') {
        depth++;
      } else if (value[i] === ')' && --depth === 0) {
        linkEnd = i;
        break;
      }
    }
    if (linkEnd === -1) {
      cursor = labelStart + 1;
      continue;
    }

    const target = markdownLinkDestination(value.slice(labelEnd + 2, linkEnd));
    if (target != null) links.push({ label: value.slice(labelStart + 1, labelEnd), target });
    cursor = linkEnd + 1;
  }
  return links;
}

export function extractCellUrl(cellValue) {
  const value = String(cellValue ?? '').trim();
  if (!value) return '';
  for (const link of parseMarkdownLinks(value)) {
    const target = String(link.target).trim().replace(/^<|>$/g, '');
    if (/^https?:\/\//i.test(target)) return target;
  }
  return value;
}

function reportNumberFromTarget(rawTarget) {
  const target = String(rawTarget).trim().replace(/^<|>$/g, '');
  if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return null;
  const pathname = target.split(/[?#]/, 1)[0];
  const match = pathname.match(/(?:^|[\\/])reports[\\/]0*(\d+)-/i)
    || pathname.match(/(?:^|[\\/])0*(\d+)-[^\\/]*\.md$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export function extractTrackerReportLinks(reportCell, notesCell = '') {
  const value = String(reportCell ?? '').trim();
  if (!value || value === '-' || value === '—') return scanNotesForReportLinks(notesCell);

  const links = [];
  const markdownLinks = parseMarkdownLinks(value);
  for (const link of markdownLinks) {
    const target = reportNumberFromTarget(link.target);
    if (target == null) continue;
    const rawLabel = link.label.trim();
    const labelNum = /^\d+$/.test(rawLabel) ? parseInt(rawLabel, 10) : null;
    links.push({ target, label: labelNum != null && labelNum > 0 ? labelNum : null });
  }

  if (markdownLinks.length === 0) {
    const target = reportNumberFromTarget(value);
    if (target != null) links.push({ target, label: null });
  }
  return links.length > 0 ? links : scanNotesForReportLinks(notesCell);
}

export function extractTrackerReportNumbers(reportCell, notesCell = '') {
  const numbers = new Set();
  for (const { target, label } of extractTrackerReportLinks(reportCell, notesCell)) {
    if (label != null) numbers.add(label);
    numbers.add(target);
  }
  return [...numbers];
}

function scanNotesForReportLinks(notesCell) {
  const notes = String(notesCell ?? '').trim();
  if (!notes) return [];
  const seen = new Set();
  const links = [];
  for (const link of parseMarkdownLinks(notes)) {
    const target = String(link.target).trim().replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const pathname = target.split(/[?#]/, 1)[0];
    if (!/(?:^|[\\/])reports[\\/]/i.test(pathname)) continue;
    const match = pathname.match(/(?:^|[\\/])reports[\\/]0*(\d+)-/i);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (!Number.isInteger(num) || num <= 0 || seen.has(num)) continue;
    seen.add(num);
    links.push({ target: num, label: null });
  }
  return links;
}

export function normalizeVia(name) {
  return normalizeTextKey(name);
}

export function normalizeTextKey(value, separator = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/̇/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
