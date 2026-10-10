#!/usr/bin/env node

import { chromium } from 'playwright';
import { resolve, dirname, relative, sep, isAbsolute, basename } from 'path';
import { readFile } from 'fs/promises';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { readStyleTokens, injectThemeStyle, readCvSectionOrder } from './theme-style.mjs';
import { validateCvExperienceOrder } from './cv-experience-order.mjs';
import { resolvePdfIndexPath, resolveTrackerPath, resolveWorkspaceRootFor } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { stripEmptyRenderedSections } from './cv-sections-core.mjs';
import { PAGE_CSS_SIZE, PAGE_FORMATS, normalizePageFormat, resolvePageFormat } from './lib/page-format.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackerPath = resolveTrackerPath(getCareerOpsRoot());
const workspaceRoot = resolveWorkspaceRootFor(getCareerOpsRoot());
const PDF_PAGE_MARGIN = '0.6in';

let __rootCache = { key: null, root: null, canonical: null };
function refreshRootCache() {
  const root = resolveWorkspaceRootFor(getCareerOpsRoot());
  if (__rootCache.key !== root) {
    __rootCache = { key: root, root, canonical: realpathSync(root) };
  }
  return __rootCache;
}

function currentWorkspaceRoot() { return refreshRootCache().root; }
function canonicalWorkspaceRoot() { return refreshRootCache().canonical; }

function assertInsideWorkspace(absPath, label) {
  let probe = absPath;
  const tail = [];
  while (!existsSync(probe)) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let canonical;
  try {
    canonical = existsSync(probe) ? resolve(realpathSync(probe), ...tail) : absPath;
  } catch (err) {
    throw new Error(
      `${label} could not be canonicalized against the tracker workspace`
      + ` (${ (err)?.code || 'realpath failed'} on ${probe}): ${absPath}`,
    );
  }
  const workspace = canonicalWorkspaceRoot();
  const rel = relative(workspace, canonical);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `${label} escapes the tracker workspace: ${absPath}`
      + ` (workspaceRoot=${workspace} canonical=${canonical} rel=${rel})`,
    );
  }
  return absPath;
}

mkdirSync(resolve(workspaceRoot, 'output'), { recursive: true });

const WORD_CHAR = String.raw`[[\p{L}\p{N}]--[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]]`;
const HYPHENATED_WORD_SOURCE = String.raw`(?<![${WORD_CHAR}\-])${WORD_CHAR}+(?:-${WORD_CHAR}+)+(?![${WORD_CHAR}\-])`;
const HYPHENATED_WORD = new RegExp(HYPHENATED_WORD_SOURCE, 'v');
const HYPHENATED_WORDS = new RegExp(HYPHENATED_WORD_SOURCE, 'gv');
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const HYPHENATED_RUN_MAX = 40;

function normalizeTextForATS(html) {
  const replacements = {};
  const bump = (key, n) => { replacements[key] = (replacements[key] || 0) + n; };

  const masks = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    }
  );

  let plainUntil = null;
  const text = (t) => (plainUntil ? sanitizeText(t) : keepHyphenatedWordsWhole(sanitizeText(t)));
  const TAG = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z](?:[^>=]|=\s*"[^"]*"|=\s*'[^']*'|=(?!\s*["']))*>/y;
  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) { out += text(masked.slice(i)); break; }
    out += text(masked.slice(i, lt));
    TAG.lastIndex = lt;
    const gt = TAG.test(masked) ? TAG.lastIndex - 1 : masked.indexOf('>', lt);
    if (gt === -1) { out += masked.slice(lt); break; }
    const tag = masked.slice(lt, gt + 1);
    const name = /^<\/?([A-Za-z][\w:-]*)/.exec(tag)?.[1].toLowerCase();
    if (plainUntil && (plainUntil === 'option' || (tag[1] === '/' && name === plainUntil))) plainUntil = null;
    if (!plainUntil && tag[1] !== '/' && !tag.endsWith('/>') && /^(?:title|textarea|option|svg|math|xmp|plaintext|noembed|noframes|iframe|noscript)$/.test(name || '')) {
      plainUntil = name;
    }
    out += tag;
    i = gt + 1;
  }

  const restored = out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);
  return { html: restored, replacements };

  function sanitizeText(text) {
    if (!text) return text;
    let t = text;
    t = t.replace(/\u2014/g, () => { bump('em-dash', 1); return '-'; });
    t = t.replace(/\u2013/g, () => { bump('en-dash', 1); return '-'; });
    t = t.replace(/[\u201C\u201D\u201E\u201F]/g, () => { bump('smart-double-quote', 1); return '"'; });
    t = t.replace(/[\u2018\u2019\u201A\u201B]/g, () => { bump('smart-single-quote', 1); return "'"; });
    t = t.replace(/\u2026/g, () => { bump('ellipsis', 1); return '...'; });
    t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, () => { bump('zero-width', 1); return ''; });
    t = t.replace(/\u00A0/g, () => { bump('nbsp', 1); return ' '; });
    t = t.replace(/\s*\u2192\s*/g, () => { bump('right-arrow', 1); return ' to '; });
    t = t.replace(/\s*\u2190\s*/g, () => { bump('left-arrow', 1); return ' from '; });
    t = t.replace(/\s*[\u2191\u2193]\s*/g, () => { bump('vert-arrow', 1); return ' '; });
    t = t.replace(/\s*\u00B7\s*/g, () => { bump('middot', 1); return ' | '; });
    t = t.replace(/\s*\u2022\s*/g, () => { bump('bullet', 1); return ' | '; });
    t = t.replace(/\u20AC/g, () => { bump('euro', 1); return 'EUR '; });
    t = t.replace(/\u00A3/g, () => { bump('pound', 1); return 'GBP '; });
    t = t.replace(/\*\*([^*]+?)\*\*/g, (_, inner) => {
      bump('markdown-bold', 1);
      return `<strong>${inner}</strong>`;
    });
    return t;
  }

  function keepHyphenatedWordsWhole(text) {
    if (!text || !text.includes('-')) return text;
    const wrap = (s) => {
      bump('hyphen-nowrap', 1);
      return `<span style="white-space:nowrap">${s}</span>`;
    };
    return text.split(/(<[^>]*>|\u0000MASK\d+\u0000)/).map((part, n) => (n % 2 ? part : part.replace(/\S+/g, (run) => {
      if (!HYPHENATED_WORD.test(run)) return run;
      if (CJK.test(run)) return run.replace(HYPHENATED_WORDS, (w) => (w.length > HYPHENATED_RUN_MAX ? w : wrap(w)));
      return run.length > HYPHENATED_RUN_MAX ? run : wrap(run);
    }))).join('');
  }
}

function foldDiacritics(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

const SECTION_ALIASES = new Map([
  ['summary', 'summary'],
  ['professional summary', 'summary'],
  ['competencies', 'competencies'],
  ['core competencies', 'competencies'],
  ['experience', 'experience'],
  ['work experience', 'experience'],
  ['professional experience', 'experience'],
  ['projects', 'projects'],
  ['selected projects', 'projects'],
  ['personal projects', 'projects'],
  ['education', 'education'],
  ['education & certifications', 'education'],
  ['certifications', 'certifications'],
  ['awards', 'awards'],
  ['honors', 'awards'],
  ['honours', 'awards'],
  ['awards & honors', 'awards'],
  ['awards and honors', 'awards'],
  ['honors & awards', 'awards'],
  ['awards & honours', 'awards'],
  ['skills', 'skills'],
  ['technical skills', 'skills'],
  ['interests', 'interests'],
  ['podsumowanie', 'summary'],
  ['podsumowanie zawodowe', 'summary'],
  ['profil zawodowy', 'summary'],
  ['kompetencje', 'competencies'],
  ['kompetencje kluczowe', 'competencies'],
  ['kluczowe kompetencje', 'competencies'],
  ['doświadczenie', 'experience'],
  ['doświadczenie zawodowe', 'experience'],
  ['przebieg kariery', 'experience'],
  ['projekty', 'projects'],
  ['kluczowe projekty', 'projects'],
  ['wybrane projekty', 'projects'],
  ['wykształcenie', 'education'],
  ['edukacja', 'education'],
  ['wykształcenie i certyfikaty', 'education'],
  ['certyfikaty', 'certifications'],
  ['certyfikaty i szkolenia', 'certifications'],
  ['szkolenia i certyfikaty', 'certifications'],
  ['nagrody', 'awards'],
  ['wyróżnienia', 'awards'],
  ['nagrody i wyróżnienia', 'awards'],
  ['umiejętności', 'skills'],
  ['umiejętności techniczne', 'skills'],
  ['perfil', 'summary'],
  ['perfil profesional', 'summary'],
  ['resumen', 'summary'],
  ['resumen profesional', 'summary'],
  ['competencias', 'competencies'],
  ['competencias clave', 'competencies'],
  ['competencias principales', 'competencies'],
  ['experiencia', 'experience'],
  ['experiencia profesional', 'experience'],
  ['experiencia laboral', 'experience'],
  ['trayectoria profesional', 'experience'],
  ['proyectos', 'projects'],
  ['proyectos destacados', 'projects'],
  ['proyectos personales', 'projects'],
  ['proyectos y laboratorios', 'projects'],
  ['formación', 'education'],
  ['formación académica', 'education'],
  ['educación', 'education'],
  ['estudios', 'education'],
  ['certificaciones', 'certifications'],
  ['certificados', 'certifications'],
  ['premios', 'awards'],
  ['reconocimientos', 'awards'],
  ['premios y reconocimientos', 'awards'],
  ['habilidades', 'skills'],
  ['habilidades técnicas', 'skills'],
  ['conocimientos técnicos', 'skills'],
  ['herramientas e idiomas', 'skills'],
  ['intereses', 'interests'],
  ['專業摘要', 'summary'],
  ['专业摘要', 'summary'],
  ['摘要', 'summary'],
  ['個人簡介', 'summary'],
  ['个人简介', 'summary'],
  ['簡介', 'summary'],
  ['简介', 'summary'],
  ['核心能力', 'competencies'],
  ['核心競爭力', 'competencies'],
  ['核心竞争力', 'competencies'],
  ['工作經歷', 'experience'],
  ['工作经历', 'experience'],
  ['工作經驗', 'experience'],
  ['工作经验', 'experience'],
  ['專業經歷', 'experience'],
  ['专业经历', 'experience'],
  ['專案', 'projects'],
  ['项目', 'projects'],
  ['專案經驗', 'projects'],
  ['项目经验', 'projects'],
  ['專案經歷', 'projects'],
  ['项目经历', 'projects'],
  ['專案成就', 'projects'],
  ['项目成就', 'projects'],
  ['精選專案', 'projects'],
  ['精选项目', 'projects'],
  ['學歷', 'education'],
  ['学历', 'education'],
  ['教育背景', 'education'],
  ['教育經歷', 'education'],
  ['教育经历', 'education'],
  ['證照', 'certifications'],
  ['证照', 'certifications'],
  ['證書', 'certifications'],
  ['证书', 'certifications'],
  ['專業證照', 'certifications'],
  ['专业证书', 'certifications'],
  ['認證', 'certifications'],
  ['认证', 'certifications'],
  ['資格認證', 'certifications'],
  ['资格认证', 'certifications'],
  ['獲獎', 'awards'],
  ['获奖', 'awards'],
  ['獎項', 'awards'],
  ['奖项', 'awards'],
  ['榮譽', 'awards'],
  ['荣誉', 'awards'],
  ['技能', 'skills'],
  ['專長', 'skills'],
  ['专长', 'skills'],
  ['技術能力', 'skills'],
  ['技术能力', 'skills'],
  ['技術棧', 'skills'],
  ['技术栈', 'skills'],
  ['興趣', 'interests'],
  ['兴趣', 'interests'],
].map(([alias, key]) => [foldDiacritics(alias), key]));

function normalizeSectionTitle(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sectionKey(text) {
  const normalized = foldDiacritics(normalizeSectionTitle(text));
  return SECTION_ALIASES.get(normalized) ?? normalized;
}

function extractRenderedSectionOrder(html) {
  const titleMatches = [...html.matchAll(/class=["'][^"']*\bsection-title\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)];
  const sections = [];

  for (const match of titleMatches) {
    const text = normalizeSectionTitle(match[1]);
    if (!text) continue;
    sections.push({ key: sectionKey(text), title: text });
  }

  return sections;
}

function extractSourceSectionOrder(markdown) {
  const sections = [];

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const text = normalizeSectionTitle(heading[2]);
    if (!text) continue;
    sections.push({ key: sectionKey(text), title: text });
  }

  return sections;
}

const CANONICAL_TAILORED_ORDER = [
  'summary', 'competencies', 'experience', 'projects',
  'education', 'certifications', 'awards', 'interests', 'skills',
];
const CANONICAL_TAILORED_POSITIONS = new Map(
  CANONICAL_TAILORED_ORDER.map((key, index) => [key, index]),
);

function findOrderDivergence(comparableSections, positions) {
  for (let i = 1; i < comparableSections.length; i++) {
    const previous = comparableSections[i - 1];
    const current = comparableSections[i];
    if (positions.get(current.key) < positions.get(previous.key)) return i;
  }
  return -1;
}

export function validateCvSectionOrder(html, cvMarkdown, { allowReorder = false } = {}) {
  const rendered = extractRenderedSectionOrder(html);
  const source = extractSourceSectionOrder(cvMarkdown);
  if (rendered.length < 2 || source.length < 2) return;

  const sourcePositions = new Map(source.map((section, index) => [section.key, index]));
  const renderedComparable = rendered.filter(section => sourcePositions.has(section.key));
  if (renderedComparable.length < 2) return;

  if (findOrderDivergence(renderedComparable, sourcePositions) === -1) return;

  const canonicalComparable = rendered.filter(section => CANONICAL_TAILORED_POSITIONS.has(section.key));
  if (canonicalComparable.length >= 2
      && findOrderDivergence(canonicalComparable, CANONICAL_TAILORED_POSITIONS) === -1) {
    return;
  }

  const renderedOrder = renderedComparable.map(section => section.title).join(' -> ');
  const sourceOrder = source
    .filter(section => renderedComparable.some(renderedSection => renderedSection.key === section.key))
    .map(section => section.title)
    .join(' -> ');
  const message = `CV section order diverges from cv.md: rendered ${renderedOrder}; cv.md ${sourceOrder}`;
  if (allowReorder) {
    console.warn(`⚠️  ${message} (proceeding — --allow-reorder set)`);
    return;
  }
  throw new Error(message);
}

export const CV_SECTION_KEYS = [...new Set(SECTION_ALIASES.values())];

const SECTION_MARKER_RE = /<!--\s+[A-Z][A-Z ]*-->/g;
const SECTION_TITLE_RE = /class=["'][^"']*\bsection-title\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;

const DISPLAY_TITLE_MAX = 60;

function displayTitle(raw) {
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const points = [...text];
  if (points.length <= DISPLAY_TITLE_MAX) return text;
  const kept = points.slice(0, DISPLAY_TITLE_MAX - 1);
  while (kept.length > 0 && /\p{M}/u.test(kept[kept.length - 1])) kept.pop();
  return `${kept.join('')}…`;
}

function findSectionTitle(html, start, end, inert) {
  const within = html.slice(start, end);
  SECTION_TITLE_RE.lastIndex = 0;
  let match;
  while ((match = SECTION_TITLE_RE.exec(within)) !== null) {
    if (!isInRanges(inert, start + match.index)) return match[1];
  }
  return null;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'textarea', 'title',
  'xmp', 'plaintext', 'iframe', 'noembed', 'noframes',
]);

function tagEnd(html, from) {
  let quote = null;
  for (let i = from + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function rawTextRanges(html) {
  const ranges = [];
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }

    const close = tagEnd(html, open);
    if (close === -1) break;
    const inner = html.slice(open + 1, close);
    index = close + 1;
    if (inner.startsWith('/')) continue;

    const name = /^([a-zA-Z][\w:-]*)/.exec(inner);
    if (!name || !RAW_TEXT_ELEMENTS.has(name[1].toLowerCase())) continue;

    if (name[1].toLowerCase() === 'plaintext') {
      ranges.push([index, html.length]);
      break;
    }

    const closeTag = new RegExp(`</${name[1]}\\s*>`, 'gi');
    closeTag.lastIndex = index;
    const end = closeTag.exec(html);
    ranges.push([index, end ? end.index : html.length]);
    index = end ? end.index + end[0].length : html.length;
  }

  return ranges;
}

function isInRanges(ranges, position) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (position < ranges[mid][0]) high = mid - 1;
    else if (position >= ranges[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
}

function scanNesting(html, from, to) {
  let index = from;
  let depth = 0;

  while (index < to) {
    const open = html.indexOf('<', index);
    if (open === -1 || open >= to) break;

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close === -1 || close + 3 > to) return null;
      index = close + 3;
      continue;
    }

    const close = tagEnd(html, open);
    if (close === -1 || close >= to) return null;
    const inner = html.slice(open + 1, close);
    index = close + 1;

    if (inner.startsWith('/')) {
      if (!/^\/[a-zA-Z][\w:-]*\s*$/.test(inner)) continue;
      if (depth === 0) return { depth, exitAt: open };
      depth--;
      continue;
    }

    const name = /^([a-zA-Z][\w:-]*)/.exec(inner);
    if (!name) continue;
    const tag = name[1].toLowerCase();

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      if (tag === 'plaintext') return null;
      const closeTag = new RegExp(`</${tag}\\s*>`, 'gi');
      closeTag.lastIndex = index;
      const end = closeTag.exec(html);
      if (!end || end.index + end[0].length > to) return null;
      index = end.index + end[0].length;
      continue;
    }

    if (inner.endsWith('/') || VOID_ELEMENTS.has(tag)) continue;

    depth++;
  }

  return { depth, exitAt: -1 };
}

function isStructuralTail(html, from) {
  let index = from;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    if (html.slice(index, open).trim() !== '') return false;

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close === -1) return false;
      index = close + 3;
      continue;
    }

    const close = tagEnd(html, open);
    if (close === -1) return false;
    if (!/^\/[a-zA-Z][\w:-]*\s*$/.test(html.slice(open + 1, close))) return false;
    index = close + 1;
  }

  return html.slice(index).trim() === '';
}

function extractSectionBlocks(html) {
  const inert = rawTextRanges(html);
  const markers = [...html.matchAll(SECTION_MARKER_RE)]
    .filter(marker => !isInRanges(inert, marker.index));
  const blocks = [];
  const ambiguous = new Set();

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const next = i + 1 < markers.length ? markers[i + 1].index : html.length;

    const title = findSectionTitle(html, start, next, inert);
    if (!title) continue;
    const text = normalizeSectionTitle(title);
    if (!text) continue;
    const key = sectionKey(text);

    const scan = scanNesting(html, start, next);
    if (!scan) {
      ambiguous.add(key);
      continue;
    }

    const end = scan.exitAt === -1 ? next : scan.exitAt;
    const bounded = scan.exitAt === -1 ? scan : scanNesting(html, start, end);
    if (!bounded || bounded.depth !== 0 || (end !== next && !isStructuralTail(html, end))) {
      ambiguous.add(key);
      continue;
    }

    blocks.push({ key, start, end, title: displayTitle(title) });
  }

  const unrecognized = new Map();
  for (const block of blocks) {
    if (!CV_SECTION_KEYS.includes(block.key)) unrecognized.set(block.key, block.title);
  }

  return { blocks, ambiguous, unrecognized };
}

export function reorderCvSections(html, order) {
  if (!Array.isArray(order) || order.length === 0) return html;
  if (order.length < 2) {
    console.warn(`⚠️  config/profile.yml cv.sections lists only "${displayTitle(order[0])}". An order needs at least two sections — one name states no relationship, so nothing was changed.`);
    return html;
  }

  const { blocks, ambiguous, unrecognized } = extractSectionBlocks(html);

  const byKey = new Map();
  for (const block of blocks) {
    if (!byKey.has(block.key)) byKey.set(block.key, block);
  }

  const chosen = [];
  const unresolved = [];
  const seen = new Set();
  for (const name of order) {
    const shown = displayTitle(name);
    if (seen.has(name)) {
      console.warn(`⚠️  config/profile.yml cv.sections lists "${shown}" more than once — keeping its first position.`);
      continue;
    }
    seen.add(name);
    if (!CV_SECTION_KEYS.includes(name)) {
      console.warn(`⚠️  config/profile.yml cv.sections lists "${shown}", which is not a CV section — ignoring it. Recognized: ${CV_SECTION_KEYS.join(', ')}.`);
      continue;
    }
    const block = byKey.get(name);
    if (block) {
      chosen.push(block);
    } else if (ambiguous.has(name)) {
      console.warn(`⚠️  config/profile.yml cv.sections lists "${shown}", but this CV's markup does not enclose that section on its own — leaving it in place, because moving it would leave tags unbalanced.`);
    } else {
      unresolved.push(name);
    }
  }

  const reportUnresolved = () => {
    if (unresolved.length === 0 || unrecognized.size === 0) return;
    const names = unresolved.map(name => `"${displayTitle(name)}"`).join(', ');
    const titles = [...unrecognized.values()].map(title => `"${title}"`).join(', ');
    console.warn(`⚠️  config/profile.yml cv.sections names ${names}, which matched no section in this CV. The CV also renders ${unrecognized.size} section title(s) the section-order alias table doesn't recognize (${titles}) — if one of those is the section you meant, its title needs an entry in SECTION_ALIASES in generate-pdf.mjs. Otherwise the name has no effect and can be dropped.`);
  };
  if (chosen.length < 2) {
    reportUnresolved();
    return html;
  }

  const slots = [...chosen].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (let i = 0; i < slots.length; i++) {
    out += html.slice(cursor, slots[i].start);
    out += html.slice(chosen[i].start, chosen[i].end);
    cursor = slots[i].end;
  }

  const reordered = out + html.slice(cursor);
  reportUnresolved();
  return reordered;
}

export function enforcePageBudget(pageCount, { maxPages = 2, strictPages = false } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`Could not determine the rendered PDF page count (received ${pageCount}).`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`Invalid page budget "${maxPages}". Use a positive integer.`);
  }
  if (pageCount <= maxPages) return;

  const actualLabel = 'pages';
  const allowedLabel = maxPages === 1 ? 'page' : 'pages';
  const message =
    `CV is ${pageCount} ${actualLabel}; the allowed maximum is ${maxPages} ${allowedLabel}. ` +
    'Trim lower-priority bullets, older roles, secondary projects, or the competencies strip, then regenerate.';

  if (strictPages) {
    throw new Error(`${message} (--strict-pages requested)`);
  }

  console.warn(`⚠️  ${message} Continuing because overflow is warning-only by default; use --strict-pages to reject it.`);
}

function countRenderedPdfPages(pdfBuffer) {
  const pdf = pdfBuffer.toString('latin1');
  const objects = new Map();
  const objectPattern = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g;

  for (const match of pdf.matchAll(objectPattern)) {
    const streamIndex = match[3].search(/\bstream(?:\r?\n|\r)/);
    const dictionary = streamIndex === -1 ? match[3] : match[3].slice(0, streamIndex);
    objects.set(`${match[1]} ${match[2]}`, dictionary);
  }

  const catalog = [...objects.values()].find((body) => /\/Type\s*\/Catalog\b/.test(body));
  const pagesRef = catalog?.match(/\/Pages\s+(\d+)\s+(\d+)\s+R\b/);
  const pages = pagesRef ? objects.get(`${pagesRef[1]} ${pagesRef[2]}`) : null;
  const count = pages && /\/Type\s*\/Pages\b/.test(pages)
    ? pages.match(/\/Count\s+(\d+)\b/)
    : null;
  const pageCount = count ? Number(count[1]) : 0;

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('Could not determine the rendered PDF page count from its page tree.');
  }
  return pageCount;
}

export function workspaceRelativeManifestPath(pathValue, rootDir = currentWorkspaceRoot()) {
  if (!pathValue) return '';
  const rel = relative(rootDir, resolve(pathValue));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return '';
  return rel.split(sep).join('/');
}

export function repoRelativeManifestPath(pathValue, rootDir = currentWorkspaceRoot()) {
  return workspaceRelativeManifestPath(pathValue, rootDir);
}

function nearestExistingPath(pathValue) {
  let candidate = pathValue;
  while (true) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export function isWorkspaceOutputPath(pathValue, rootDir = currentWorkspaceRoot()) {
  const root = resolve(rootDir);
  const candidate = resolve(pathValue);
  const lexical = relative(root, candidate);
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    return false;
  }

  try {
    const canonicalRoot = realpathSync(root);
    const canonicalAnchor = realpathSync(nearestExistingPath(candidate));
    const canonical = relative(canonicalRoot, canonicalAnchor);
    return canonical === '' || (canonical !== '..' && !canonical.startsWith(`..${sep}`) && !isAbsolute(canonical));
  } catch {
    return false;
  }
}

export function injectPrintPageCss(html, format) {
  const pageSize = PAGE_CSS_SIZE[resolvePageFormat(format, {
    profilePath: resolve(workspaceRoot, 'config', 'profile.yml'),
  })];
  const pageStyle = `<style id="career-ops-page-setup">\n@page { size: ${pageSize}; margin: var(--page-margin, ${PDF_PAGE_MARGIN}); }\n</style>`;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => `${pageStyle}\n</head>`);
  }

  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, match => `${match}\n<head>\n${pageStyle}\n</head>`);
  }

  return `${pageStyle}\n${html}`;
}

export const ARTIFACT_KINDS = ['cv', 'cover'];

export function resolveArtifactKind(explicit, outputPath) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const declared = String(explicit).trim().toLowerCase();
    return ARTIFACT_KINDS.includes(declared)
      ? { kind: declared, source: 'declared' }
      : { kind: null, source: 'declared' };
  }

  const name = basename(outputPath || '').toLowerCase().replace(/\.[^.]*$/, '');
  if (name.startsWith('cv-')) return { kind: 'cv', source: 'name' };
  if (/^cover([-_]|$)/.test(name) || /[-_]cover$/.test(name)) {
    return { kind: 'cover', source: 'name' };
  }
  return { kind: 'cv', source: 'default' };
}

export function applyManifestRow(existingLines, row) {
  const normKey = (s) => (s || '').trim().replace(/^0+(?=\d)/, '');
  const incomingKind = row.kind === 'cover' ? 'cover' : 'cv';

  const kept = existingLines.filter((line) => {
    if (!line.trim() || line.startsWith('#')) return false;
    const fields = line.split('\t');
    if (fields[1] === row.pdf) return false;
    if (!row.reportNum || normKey(fields[0]) !== normKey(row.reportNum)) return true;
    const existingKind = (fields[5] || '').trim();
    return incomingKind === 'cover'
      ? existingKind !== 'cover'
      : existingKind === 'cover';
  });

  kept.push([row.reportNum || '', row.pdf, row.html, row.format, row.date, incomingKind].join('\t'));
  return kept;
}

function updatePDFManifest(reportNum, pdfPath, htmlPath, format, kind) {
  const manifestPath = resolvePdfIndexPath(trackerPath);
  const toRel = (p) => relative(workspaceRoot, p).split(sep).join('/');
  const relPDF = toRel(pdfPath);
  const relHTML = workspaceRelativeManifestPath(htmlPath, workspaceRoot);
  const date = new Date().toISOString().slice(0, 10);

  const existing = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf-8').split('\n')
    : [];
  const lines = applyManifestRow(existing, {
    reportNum,
    pdf: relPDF,
    html: relHTML,
    format,
    date,
    kind,
  });

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit\n' +
      lines.join('\n') + '\n'
  );
  return relPDF;
}

async function generatePDF() {
  const args = process.argv.slice(2);
  let skipFactCheck = false;

  let kindFlag = '', kindSupplied = false, reportSupplied = false;
  let inputPath, outputPath, format = null, reportNum = '', allowReorder = false, allowNonChronological = false;
  let maxPages = 2, maxPagesInput = '2', strictPages = false, batchManifestPath = null;

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--report=')) {
      reportSupplied = true;
      reportNum = arg.split('=')[1].trim();
    } else if (arg === '--report') {
      reportSupplied = true;
      reportNum = '';
    } else if (arg === '--kind') {
      kindSupplied = true;
      kindFlag = '';
    } else if (arg.startsWith('--kind=')) {
      kindSupplied = true;
      kindFlag = arg.slice('--kind='.length).trim();
    } else if (arg.startsWith('--batch=')) {
      batchManifestPath = arg.slice('--batch='.length);
    } else if (arg.startsWith('--max-pages=')) {
      maxPagesInput = arg.slice('--max-pages='.length);
      maxPages = Number(maxPagesInput);
    } else if (arg === '--allow-reorder') {
      allowReorder = true;
    } else if (arg === '--allow-nonchronological') {
      allowNonChronological = true;
    } else if (arg === '--strict-pages') {
      strictPages = true;
    } else if (arg === '--skip-fact-check') {
      skipFactCheck = true;
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (reportSupplied && !reportNum) {
    console.error('Invalid --report "". Use a numeric report number, e.g. --report=42.');
    process.exit(1);
  }

  if (kindSupplied && (!kindFlag || !resolveArtifactKind(kindFlag).kind)) {
    console.error(`Invalid --kind "${kindFlag}". Use: ${ARTIFACT_KINDS.join(', ')}`);
    process.exit(1);
  }

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    console.error(`Invalid --max-pages "${maxPagesInput}". Use a positive integer, e.g. --max-pages=1 or --max-pages=2.`);
    process.exit(1);
  }

  if (format !== null) {
    const normalized = normalizePageFormat(format);
    if (!normalized) {
      console.error(`Invalid format "${format}". Use: ${[...PAGE_FORMATS].join(', ')}`);
      process.exit(1);
    }
    format = normalized;
  }
  format = resolvePageFormat(format, { profilePath: resolve(workspaceRoot, 'config', 'profile.yml') });

  if (batchManifestPath) {
    if (reportNum) {
      console.error('--report is not valid with --batch. Set "reportNum" per entry in the manifest instead.');
      process.exit(1);
    }
    if (kindSupplied) {
      console.error('--kind is not valid with --batch. Set "kind" per entry in the manifest instead.');
      process.exit(1);
    }
    return runBatchFromManifest(batchManifestPath, { format, maxPages, strictPages, allowReorder, allowNonChronological });
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4] [--report=NNN] [--kind=cv|cover] [--allow-reorder] [--allow-nonchronological] [--max-pages=N] [--strict-pages]');
    console.error('   or: node generate-pdf.mjs --batch=<manifest.json> [--format=letter|a4] [--allow-reorder] [--allow-nonchronological] [--max-pages=N] [--strict-pages]');
    console.error('');
    console.error('Batch mode renders every document in the JSON manifest (an array of');
    console.error('{input, output, format?, reportNum?, kind?}) through one shared Chromium and writes');
    console.error('<manifest>.results.json; it exits non-zero if any document fails.');
    console.error('');
    console.error('This script only converts an already-built HTML file to PDF.');
    console.error('The input HTML is produced by the pdf mode: the agent fills cv-template.html');
    console.error('with content tailored to the specific job (see modes/pdf.md) — there is no');
    console.error('mechanical markdown-to-HTML step by design. Run `/career-ops pdf` in your AI');
    console.error('CLI to drive the full flow end to end.');
    process.exit(1);
  }

  if (reportNum && !/^\d+$/.test(reportNum)) {
    console.error(`Invalid --report "${reportNum}". Use the numeric tracker/report number, e.g. --report=018`);
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  try {
    assertInsideWorkspace(inputPath, 'input');
  } catch (err) {
    console.error(`Refusing to write the PDF outside the tracker workspace: ${err.message}`);
    process.exit(1);
  }
  if (!isWorkspaceOutputPath(outputPath, workspaceRoot)) {
    console.error(`Refusing to write the PDF outside the tracker workspace: ${outputPath}`);
    process.exit(1);
  }

  console.log(`📄 Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);
  console.log(`📏 Format: ${format.toUpperCase()}`);
  console.log(`📐 Page budget: ${maxPages}${strictPages ? ' (strict)' : ' (warning only)'}`);

  let html = await readFile(inputPath, 'utf-8');
  let cvMarkdown = '';
  try {
    cvMarkdown = await readFile(resolve(workspaceRoot, 'cv.md'), 'utf-8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  html = stripEmptyRenderedSections(html);

  html = reorderCvSections(html, readCvSectionOrder(resolve(workspaceRoot, 'config', 'profile.yml')));

  validateCvSectionOrder(html, cvMarkdown, { allowReorder });
  validateCvExperienceOrder(html, { allowNonChronological });

  const normalized = normalizeTextForATS(html);
  html = normalized.html;
  const totalReplacements = Object.values(normalized.replacements).reduce((a, b) => a + b, 0);
  if (totalReplacements > 0) {
    const breakdown = Object.entries(normalized.replacements).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
  }

  if (!skipFactCheck && cvMarkdown) {
    const { assertFacts, printAdvisoryFacts } = await import('./verify-cv-facts.mjs');
    const factCheck = assertFacts(html, { label: basename(inputPath) });
    if (factCheck.configMissing) {
      console.warn('⚠️  No config/cv-facts.json — forbidden/advisory phrase checks did not run.');
    }
    if (factCheck.verdict === 'warn') {
      console.warn(`⚠️  CV fact check warning: ${basename(inputPath)}`);
      for (const phrase of factCheck.warnings) console.warn(`  - advisory phrase: ${phrase}`);
      printAdvisoryFacts(factCheck.advisoryFacts, console.warn);
    } else {
      console.log('✅ Fact check passed');
    }
  }

  return renderHtmlToPdf(html, outputPath, {
    format,
    baseDir: dirname(inputPath),
    reportNum,
    kind: kindFlag,
    inputPath,
    maxPages,
    strictPages,
    styleTokens: readStyleTokens(resolve(workspaceRoot, 'config', 'profile.yml')),
  });
}

async function runBatchFromManifest(manifestPath, globals) {
  const resolvedManifest = resolve(manifestPath);
  const manifestDir = dirname(resolvedManifest);

  try {
    assertInsideWorkspace(resolvedManifest, 'batch manifest');
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = await readFile(resolvedManifest, 'utf-8');
  } catch (err) {
    console.error(`❌ Cannot read batch manifest: ${resolvedManifest} (${err.message})`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Batch manifest is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('❌ Batch manifest must be a non-empty JSON array of {input, output, format?, reportNum?}.');
    process.exit(1);
  }

  const results = new Array(manifest.length).fill(null);
  const entries = [];

  let cvMarkdown = '';
  try {
    cvMarkdown = await readFile(resolve(workspaceRoot, 'cv.md'), 'utf-8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const profilePath = resolve(workspaceRoot, 'config', 'profile.yml');
  const cvSectionOrder = readCvSectionOrder(profilePath);
  const styleTokens = readStyleTokens(profilePath);

  for (let i = 0; i < manifest.length; i++) {
    const spec = manifest[i];
    try {
      if (!spec || typeof spec.input !== 'string' || typeof spec.output !== 'string') {
        throw new Error('each entry needs a string "input" and "output"');
      }

      const declaredFormat = spec.format || globals.format;
      const entryFormat = normalizePageFormat(declaredFormat);
      if (!entryFormat) {
        throw new Error(`invalid format "${declaredFormat}" (use: ${[...PAGE_FORMATS].join(', ')})`);
      }

      const entryKindSupplied = Object.prototype.hasOwnProperty.call(spec, 'kind');
      const entryKind = (spec.kind ?? '').toString().trim();
      if (entryKindSupplied && (!entryKind || !resolveArtifactKind(entryKind).kind)) {
        throw new Error(`invalid kind "${entryKind}" (use: ${ARTIFACT_KINDS.join(', ')})`);
      }

      const entryReportSupplied = Object.prototype.hasOwnProperty.call(spec, 'reportNum');
      const entryReport = (spec.reportNum ?? '').toString().trim();
      if (entryReportSupplied && (!entryReport || !/^\d+$/.test(entryReport))) {
        throw new Error(`invalid reportNum "${entryReport}" (use the numeric report number)`);
      }

      const entryInput = resolve(manifestDir, spec.input);
      const entryOutput = resolve(manifestDir, spec.output);

      assertInsideWorkspace(entryInput, 'input');
      if (!isWorkspaceOutputPath(entryOutput, workspaceRoot)) {
        throw new Error(`output escapes the tracker workspace: ${entryOutput}`);
      }

      let html = await readFile(entryInput, 'utf-8');
      html = stripEmptyRenderedSections(html);
      html = reorderCvSections(html, cvSectionOrder);
      validateCvSectionOrder(html, cvMarkdown, { allowReorder: globals.allowReorder });
      validateCvExperienceOrder(html, { allowNonChronological: globals.allowNonChronological });
      html = normalizeTextForATS(html).html;

      entries.push({
        _idx: i,
        html,
        outputPath: entryOutput,
        format: entryFormat,
        baseDir: dirname(entryInput),
        reportNum: entryReport,
        kind: entryKind,
        inputPath: entryInput,
        maxPages: globals.maxPages,
        strictPages: globals.strictPages,
        styleTokens,
      });
    } catch (err) {
      console.error(`❌ Skipping batch entry ${i} (${spec?.output ?? '?'}): ${err.message}`);
      const failedOutput = spec && typeof spec.output === 'string' ? resolve(manifestDir, spec.output) : null;
      results[i] = { outputPath: failedOutput, ok: false, error: err.message };
    }
  }

  if (entries.length > 0) {
    console.log(`📦 Batch: rendering ${entries.length} document(s) in one Chromium…`);
    const rendered = await renderBatch(entries);
    rendered.forEach((r, k) => { results[entries[k]._idx] = r; });
  }

  const ok = results.filter((r) => r && r.ok).length;
  const failed = results.length - ok;

  const resultsPath = `${resolvedManifest}.results.json`;
  try {
    assertInsideWorkspace(resultsPath, 'batch results');
    writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
    console.log(`🔗 Batch results: ${resultsPath}`);
  } catch (err) {
    console.error(`⚠️  Could not write batch results manifest: ${err.message}`);
    process.exitCode = 1;
  }

  console.log(`📦 Batch complete: ${ok} ok, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  return { ok, failed, results };
}

const _fontDataUrlCache = new Map();

export async function inlineLocalFonts(html) {
  const FONT_REF = /url\(\s*(['"]?)\.\/fonts\/([^'")\s]+)\1\s*\)/g;
  const MIME = { woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf' };
  const fontsDir = resolve(__dirname, 'fonts');
  const names = [...new Set([...html.matchAll(FONT_REF)].map((m) => m[2]))];
  const dataUrls = new Map();
  for (const name of names) {
    const fontPath = resolve(fontsDir, name);
    const rel = relative(fontsDir, fontPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      console.warn(`⚠️  Font reference escapes fonts/, keeping original reference: ${name}`);
      continue;
    }
    if (_fontDataUrlCache.has(fontPath)) {
      dataUrls.set(name, _fontDataUrlCache.get(fontPath));
      continue;
    }
    try {
      const buf = await readFile(fontPath);
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      const dataUrl = `url('data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}')`;
      _fontDataUrlCache.set(fontPath, dataUrl);
      dataUrls.set(name, dataUrl);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      console.warn(`⚠️  Font file not found, keeping original reference: fonts/${name}`);
    }
  }
  return html.replace(FONT_REF, (match, _quote, name) => dataUrls.get(name) || match);
}

export async function renderHtmlToPdf(html, outputPath, opts = {}) {
  const launchBrowser = opts.launchBrowser || ((options) => chromium.launch(options));
  let browser = null;
  try {
    browser = await launchBrowser({ headless: true });
    return await renderInPage(browser, html, outputPath, opts);
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        console.warn(`⚠️  Browser cleanup failed: ${err.message}`);
      });
    }
  }
}

async function renderInPage(browser, html, outputPath, opts = {}) {
  const outputRoot = opts.workspaceRoot || workspaceRoot;
  const format = resolvePageFormat(opts.format, { profilePath: resolve(outputRoot, 'config', 'profile.yml') });
  const requestedBaseDir = resolve(opts.baseDir || outputRoot);
  const baseDir = isWorkspaceOutputPath(
    resolve(requestedBaseDir, '.career-ops-render-anchor'),
    outputRoot,
  ) ? requestedBaseDir : resolve(outputRoot);
  const reportNum = opts.reportNum || '';
  const inputPath = opts.inputPath || '';
  const { kind: artifactKind } = resolveArtifactKind(opts.kind, outputPath);
  if (!artifactKind) {
    throw new Error(`Invalid artifact kind "${opts.kind}". Use: ${ARTIFACT_KINDS.join(', ')}`);
  }

  if (!isWorkspaceOutputPath(outputPath, outputRoot)) {
    throw new Error(`Refusing to write the PDF outside the tracker workspace: ${outputPath}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  const styleTokens = opts.styleTokens ?? readStyleTokens(resolve(outputRoot, 'config', 'profile.yml'));
  html = injectThemeStyle(html, styleTokens);

  html = injectPrintPageCss(html, format);
  html = await inlineLocalFonts(html);

  const tmpHtmlPath = resolve(baseDir, `.career-ops-render-${randomUUID()}.html`);
  const { writeFile, unlink } = await import('fs/promises');
  await writeFile(tmpHtmlPath, html, 'utf-8');

  let page = null;
  let context = null;
  try {
    context = browser.newContext
      ? await browser.newContext({ javaScriptEnabled: false })
      : null;
    page = context ? await context.newPage() : await browser.newPage();
    if (page.route) {
      await page.route('**/*', (route) => {
        const url = route.request().url();
        return url.startsWith('file:') || url.startsWith('data:')
          ? route.continue()
          : route.abort();
      });
    }

    await page.goto(pathToFileURL(tmpHtmlPath).href, {
      waitUntil: 'load',
    });

    await page.evaluate(() => document.fonts.ready);

    const pdfBuffer = await page.pdf({
      printBackground: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
      },
      preferCSSPageSize: true,
    });

    await writeFile(outputPath, pdfBuffer);

    const pageCount = countRenderedPdfPages(pdfBuffer);

    enforcePageBudget(pageCount, {
      maxPages: opts.maxPages ?? 2,
      strictPages: opts.strictPages ?? false,
    });

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    try {
      updatePDFManifest(reportNum, outputPath, inputPath, format, artifactKind);
      console.log(`🔗 Manifest: data/pdf-index.tsv updated${reportNum ? ` (report ${reportNum})` : ' (no --report given)'}`);
    } catch (err) {
      console.error(`⚠️  Manifest update failed: ${err.message}`);
    }

    return { outputPath, pageCount, size: pdfBuffer.length };
  } finally {
    if (page && typeof page.close === 'function') {
      await page.close().catch((err) => {
        console.warn(`⚠️  Page cleanup failed: ${err.message}`);
      });
    }
    if (context && typeof context.close === 'function') {
      await context.close().catch((err) => {
        console.warn(`⚠️  Context cleanup failed: ${err.message}`);
      });
    }
    await unlink(tmpHtmlPath).catch((err) => {
      if (err?.code !== 'ENOENT') {
        console.warn(`⚠️  Temporary HTML cleanup failed: ${err.message}`);
      }
    });
  }
}

export async function renderBatch(entries, opts = {}) {
  const launchBrowser = opts.launchBrowser || ((options) => chromium.launch(options));
  const results = [];
  let browser = null;
  try {
    try {
      browser = await launchBrowser({ headless: true });
    } catch (err) {
      console.error(`❌ Batch browser launch failed: ${err.message}`);
      for (const entry of entries) {
        results.push({ outputPath: entry.outputPath, ok: false, error: `browser launch failed: ${err.message}` });
      }
      return results;
    }
    for (const entry of entries) {
      try {
        const r = await renderInPage(browser, entry.html, entry.outputPath, entry);
        results.push({ outputPath: entry.outputPath, ok: true, pageCount: r.pageCount, size: r.size });
      } catch (err) {
        console.error(`❌ Batch entry failed (${entry.outputPath}): ${err.message}`);
        results.push({ outputPath: entry.outputPath, ok: false, error: err.message });
      }
    }
    return results;
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        console.warn(`⚠️  Browser cleanup failed: ${err.message}`);
      });
    }
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  generatePDF().catch((err) => {
    console.error('❌ PDF generation failed:', err.message);
    process.exit(1);
  });
}

export { normalizeTextForATS, sectionKey };
