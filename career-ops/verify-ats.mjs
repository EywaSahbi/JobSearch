#!/usr/bin/env node

import { readFileSync, statSync } from 'fs';
import { isAbsolute, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs'; 
import { asciiFold } from './lib/ascii-fold.mjs';

const DEFAULT_MIN_SCORE = 70;

const WEIGHTS = {
  text: 15,
  sections: 20,
  contact: 15,
  layout: 20,
  images: 10,
  fonts: 10,
  charset: 5,
  hidden: 5,
};

const TEXT_MIN_CHARS = 300;
const TEXT_LOW_WITH_IMG = 800;

const ATS_SAFE_FONTS = new Set([
  'arial', 'helvetica', 'helvetica neue', 'liberation sans', 'dejavu sans',
  'calibri', 'candara', 'corbel', 'segoe ui', 'tahoma', 'verdana', 'trebuchet ms',
  'times new roman', 'times', 'georgia', 'cambria', 'garamond', 'book antiqua',
  'palatino', 'palatino linotype', 'lato', 'roboto', 'open sans', 'noto sans',
  'source sans pro', 'pt sans',
  'hiragino sans', 'hiragino kaku gothic pron', 'yu gothic', 'yugothic',
  'noto sans cjk jp', 'noto sans jp', 'meiryo', 'ms pgothic', 'pingfang sc',
  'hiragino sans gb', 'microsoft yahei', 'noto sans cjk sc', 'noto sans sc',
  'source han sans sc',
  'apple sd gothic neo', 'malgun gothic', 'noto sans cjk kr', 'noto sans kr',
  'nanum gothic', 'pingfang tc', 'microsoft jhenghei', 'noto sans cjk tc',
  'noto sans tc', 'source han sans tc',
]);

const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{6,23}\d/g;
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_CANDIDATES = 50;

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  szlig: 'ß', thorn: 'þ', eth: 'ð', scaron: 'š', zcaron: 'ž', oelig: 'œ',
};

function decodeEntities(text) {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function stripInline(fragment) {
  return collapse(decodeEntities(fragment.replace(/<[^>]+>/g, ' ')));
}

function parseFontFamilies(declaration) {
  return declaration
    .replace(/var\([ \t\n\f\r]*--(?:\\[\s\S]|[^ \t\n\f\r,()])*[ \t\n\f\r]*,?/gi, ' ')
    .split(',')
    .map(raw => cssTrim(raw.replace(/['"()]/g, '')).toLowerCase())
    .filter(Boolean);
}

function cssTrim(text) {
  return text.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');
}

function describeFontName(name) {
  return name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, ch => {
    if (ch === ' ') return ch;
    const code = ch.codePointAt(0);
    return code > 0xffff
      ? `\\u{${code.toString(16)}}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function stripNonContentRegions(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractVisibleText(html) {
  return collapse(
    stripNonContentRegions(html)
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
  );
}

function hasPhoneNumber(text) {
  const candidates = text.match(PHONE_CANDIDATE_RE);
  if (!candidates) return false;
  for (const candidate of candidates.slice(0, PHONE_MAX_CANDIDATES)) {
    if ((candidate.match(/\d/g) || []).length >= PHONE_MIN_DIGITS) return true;
  }
  return false;
}

function linkContacts(html) {
  let email = false, phone = false;
  for (const m of stripNonContentRegions(html).matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const href = (m[1] ?? m[2]).trim();
    if (/^mailto:.+@.+/i.test(href)) email = true;
    else if (/^tel:.*\d/i.test(href)) phone = true;
  }
  return { email, phone };
}

function hasMultiColumn(blob) {
  const count = blob.match(/column-count\s*:\s*(\d+)/i);
  if (count && Number(count[1]) >= 2) return true;
  for (const m of blob.matchAll(/\bcolumns\s*:\s*([^;{}]+)/gi)) {
    for (const token of m[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(token) && Number(token) >= 2) return true;
    }
  }
  return false;
}

function extractStyleText(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
}

function extractInlineStyles(html) {
  return [...html.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(m => m[1] ?? m[2]);
}

function cssDeclarations(style) {
  const declarations = [];
  const closers = [];
  const isCssSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  let current = '';
  let quote = null;
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (c === '\\' && i + 1 < style.length) {
      const escaped = style[i + 1] === '\r' && style[i + 2] === '\n' ? '\r\n' : style[i + 1];
      current += c + escaped;
      i += escaped.length;
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote || c === '\n' || c === '\r' || c === '\f') quote = null;
      continue;
    }
    if (c === '/' && style[i + 1] === '*') {
      const end = style.indexOf('*/', i + 2);
      i = end === -1 ? style.length : end + 1;
      current += ' ';
      continue;
    }
    if (c === ';' && closers.length === 0) {
      declarations.push(current);
      current = '';
      continue;
    }
    if (c === '(' && /(?:^|[^\w\u0080-\uffff-])url$/i.test(style.slice(Math.max(0, i - 4), i))) {
      let bodyStart = i + 1;
      while (bodyStart < style.length && isCssSpace(style[bodyStart])) bodyStart++;
      if (style[bodyStart] !== '"' && style[bodyStart] !== "'") {
        let end = i + 1;
        while (end < style.length && style[end] !== ')') end += style[end] === '\\' ? 2 : 1;
        current += style.slice(i, end + 1);
        i = Math.min(end, style.length - 1);
        continue;
      }
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') closers.push(')');
    else if (c === '[') closers.push(']');
    else if (c === '{') closers.push('}');
    else if (c === closers[closers.length - 1]) closers.pop();
    current += c;
  }
  declarations.push(current);
  return declarations;
}

function extractHeadings(html) {
  const out = [];
  for (const m of html.matchAll(/<[^>]*class\s*=\s*"[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\//gi)) {
    out.push(stripInline(m[1]));
  }
  for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    out.push(stripInline(m[1]));
  }
  return out
    .flatMap(s => [s.toLowerCase(), asciiFold(s).toLowerCase()])
    .filter(Boolean);
}

function normalizeKeywords(keywords, role) {
  const list = [];
  if (Array.isArray(keywords)) list.push(...keywords);
  else if (typeof keywords === 'string') list.push(...keywords.split(','));
  if (role) list.push(...String(role).split(/[,/]|\band\b/i));
  return [...new Set(list.map(k => k.trim()).filter(k => k.length >= 2))];
}

function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function auditAts(html, opts = {}) {
  const text = extractVisibleText(html);
  const css = extractStyleText(html);
  const inlineStyles = extractInlineStyles(html);
  const styleBlobs = [css, ...inlineStyles];
  const issues = [];
  let score = 0;

  const add = (severity, message) => issues.push({ severity, message });

  if (text.length >= TEXT_MIN_CHARS) {
    score += WEIGHTS.text;
  } else {
    add('critical', `Very little selectable text (${text.length} chars, expected >= ${TEXT_MIN_CHARS}). The CV may be image-based or rasterized; ATS parsers need a real text layer.`);
  }

  const headingBlob = extractHeadings(html).join(' | ');
  const startsWord = (terms) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join('|')})`, 'u');
  const required = [
    { name: 'Experience', re: startsWord([
      'experience', 'work history', 'employment',
      'experien', 'esperienza',
      'erfahrung', 'berufserfahrung', 'arbeitserfahrung', 'werdegang',
      'ervaring', 'werkervaring', 'loopbaan',
      'doswiadczenie', 'przebieg kariery',
      'deneyim',
      'erhvervserfaring', 'karriereforlob',
      'riwayat karier', 'pengalaman',
      'parcours professionnel',
      'trayectoria', 'trajetoria',
      'percorso professionale',
      '職務経歴', '職歴',
      '경력',
      'опыт работы',
      'досвід роботи',
      'الخبرات', 'التاريخ المهني',
      'करियर',
      '工作经历', '工作經歷',
    ]) },
    { name: 'Education', re: startsWord([
      'education', 'academic',
      'formation', 'formacion', 'formacao',
      'ausbildung', 'bildung', 'studium',
      'istruzione',
      'opleiding',
      'wyksztalcenie',
      'egitim',
      'uddannelse',
      'pendidikan',
      '学歴',
      '학력',
      'образование',
      'освіта',
      'التعليم', 'المؤهلات',
      'शिक्षा',
      '教育背景', '學歷',
    ]) },
    { name: 'Skills', re: startsWord([
      'skills', 'competen', 'proficienc',
      'kenntnisse', 'fachkenntnisse', 'sprachkenntnisse', 'fahigkeiten',
      'habilidades',
      'vaardigheden',
      'umiejetnosci',
      'beceri',
      'kompetenc', 'kernkompetenc',
      'keahlian',
      'スキル',
      '역량', '기술',
      'навыки',
      'навички',
      'مهارات',
      'कौशल',
      '技能', '专业技能', '專業技能',
    ]) },
  ];
  const missing = [];
  for (const s of required) {
    if (s.re.test(headingBlob)) score += 5;
    else missing.push(s.name);
  }
  const bonus = [/summary|profile|objective/, /projects/, /certificat|licenses/]
    .filter(re => re.test(headingBlob)).length;
  score += Math.min(5, bonus * 2);
  if (missing.length) {
    add(missing.length >= 2 ? 'critical' : 'warning',
      `Missing standard section heading(s): ${missing.join(', ')}. ATS parsers key off recognizable headings (Experience, Education, Skills).`);
  }

  const bodyOnlyHtml = html
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');
  const bodyText = extractVisibleText(bodyOnlyHtml);
  const links = linkContacts(html);
  const bodyLinks = linkContacts(bodyOnlyHtml);
  const hasEmail = EMAIL_RE.test(text) || links.email;
  const emailInBody = EMAIL_RE.test(bodyText) || bodyLinks.email;
  const hasPhone = hasPhoneNumber(text) || links.phone;
  if (emailInBody) {
    score += 10;
  } else if (hasEmail) {
    add('critical', 'Contact email appears only inside a semantic <header>/<footer> element; ATS routinely drop those regions, so the address is effectively unreachable. Move contact details into the main document body.');
  } else {
    add('critical', 'No email address found. ATS and recruiters need a parseable contact email in the body of the CV.');
  }
  if (hasPhone) score += 5;
  else add('info', 'No phone number detected (optional, but many ATS intake forms expect one).');

  let layout = WEIGHTS.layout;
  const tableTags = (html.match(/<table\b/gi) || []).length;
  const multiColumn = styleBlobs.some(hasMultiColumn);
  const absPos = (css.match(/position\s*:\s*absolute/gi) || []).length
    + inlineStyles.filter(s => /position\s*:\s*absolute/i.test(s)).length;
  if (tableTags > 0) {
    layout -= 12;
    add('critical', `Found ${tableTags} <table> element(s). Table-based layouts scramble the reading order ATS extractors follow; use a single-column flow.`);
  }
  if (multiColumn) {
    layout -= 8;
    add('warning', 'CSS multi-column layout detected (column-count/columns). Single-column content parses most reliably.');
  }
  if (absPos > 0) {
    layout -= 4;
    add('warning', `Found ${absPos} absolutely-positioned element(s); absolute positioning can break ATS reading order.`);
  }
  score += Math.max(0, layout);

  let imageScore = WEIGHTS.images;
  const imgs = [...stripNonContentRegions(html).matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const contentImgs = imgs.filter(tag => !/class\s*=\s*(?:"[^"]*\bcv-photo\b[^"]*"|'[^']*\bcv-photo\b[^']*')/i.test(tag));
  if (contentImgs.length > 0 && text.length < TEXT_LOW_WITH_IMG) {
    imageScore = 0;
    add('critical', `Found ${contentImgs.length} content image(s) with little surrounding text (${text.length} chars). Text baked into images is invisible to ATS.`);
  } else if (contentImgs.length > 0) {
    imageScore -= 5;
    add('warning', `Found ${contentImgs.length} non-photo image(s). Ensure no CV text (skills, headings, contact) is baked into images — ATS cannot read image text.`);
  }
  score += Math.max(0, imageScore);

  const families = new Set();
  for (const blob of styleBlobs) {
    for (const m of blob.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
      for (const fam of parseFontFamilies(m[1])) {
        if (!GENERIC_FAMILIES.has(fam)) families.add(fam);
      }
    }
  }
  const unsafeFonts = [...families].filter(f => !ATS_SAFE_FONTS.has(f));
  if (unsafeFonts.length === 0) {
    score += WEIGHTS.fonts;
  } else {
    score += Math.max(0, WEIGHTS.fonts - unsafeFonts.length * 3);
    add('warning', `Non-standard font(s): ${unsafeFonts.map(describeFontName).join(', ')}. Prefer widely-supported, embeddable fonts (Arial, Helvetica, Calibri, Times New Roman, Georgia) for reliable ATS text extraction.`);
  }

  if (/<meta[^>]*charset\s*=\s*["']?\s*utf-8/i.test(html)) {
    score += WEIGHTS.charset;
  } else {
    add('warning', 'No <meta charset="utf-8"> declared. Declare UTF-8 so accented characters and symbols survive ATS text extraction.');
  }

  const hiddenSignals = [];
  if (styleBlobs.some(s => /display\s*:\s*none/i.test(s))) hiddenSignals.push('display:none');
  if (styleBlobs.some(s => /visibility\s*:\s*hidden/i.test(s))) hiddenSignals.push('visibility:hidden');
  if (styleBlobs.some(s => /font-size\s*:\s*0(?:px|pt|em|rem|%)?\b/i.test(s))) hiddenSignals.push('font-size:0');
  const whiteDeclaration = /^\s*(?:-webkit-text-fill-)?color\s*:\s*(?:#fff(?:fff)?\b|white\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i;
  if (inlineStyles.some(s => cssDeclarations(s).some(d => whiteDeclaration.test(d)))) {
    hiddenSignals.push('white-on-white text');
  }
  if (hiddenSignals.length === 0) {
    score += WEIGHTS.hidden;
  } else {
    add('warning', `Possible hidden text / keyword stuffing (${hiddenSignals.join(', ')}). Hidden keywords are penalised by modern ATS and by recruiters who read the extracted text.`);
  }

  let keywordCoverage = null;
  const keywords = normalizeKeywords(opts.keywords, opts.role);
  if (keywords.length) {
    const haystack = text.toLowerCase();
    const found = keywords.filter(k => haystack.includes(k.toLowerCase()));
    const missingKeywords = keywords.filter(k => !haystack.includes(k.toLowerCase()));
    keywordCoverage = {
      total: keywords.length,
      found: found.length,
      percent: Math.round((found.length / keywords.length) * 100),
      missing: missingKeywords,
    };
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: gradeFor(score), issues, keywordCoverage };
}

function isPass(result, minScore) {
  return result.score >= minScore && !result.issues.some(i => i.severity === 'critical');
}

export {
  extractVisibleText,
  extractHeadings,
  auditAts,
  gradeFor,
  isPass,
  normalizeKeywords,
  DEFAULT_MIN_SCORE,
};

function buildCleanHtml(overrides = {}) {
  const {
    font = "'Liberation Sans', Arial, sans-serif",
    email = '<a href="mailto:jane@example.com">jane@example.com</a>',
    charset = '<meta charset="UTF-8">',
    experience = '<div class="section"><div class="section-title">Work Experience</div>\n    <p>Staff Engineer, Acme Corp (2020-present). Built and operated the core payments platform,\n    reducing incident rates and improving deployment cadence across multiple engineering teams.</p></div>',
    education = '<div class="section"><div class="section-title">Education</div><p>B.S. Computer Science, State University, 2018. Graduated with honors.</p></div>',
    skills = '<div class="section"><div class="section-title">Skills</div><p>Python, Kubernetes, Docker, PostgreSQL, distributed systems, CI/CD pipelines.</p></div>',
    extraBody = '',
  } = overrides;
  return `<!DOCTYPE html><html lang="en"><head>${charset}
<style>body{font-family:${font};font-size:11px;} .section-title{font-weight:700;text-transform:uppercase;}</style>
</head><body>
  <div class="header">
    <h1>Jane Smith</h1>
    <div class="contact-row">${email} | +1 415 555 0100 | San Francisco, CA</div>
  </div>
  <div class="section"><div class="section-title">Professional Summary</div>
    <p>Senior backend engineer with a decade of experience designing reliable, high-throughput
    distributed systems. Led platform teams delivering resilient services on Kubernetes, with a
    focus on observability, cost efficiency, and clean, well-tested Python codebases used daily
    across the organization.</p></div>
  ${experience}
  <div class="section"><div class="section-title">Projects</div>
    <p>Open-source tracing toolkit adopted by several teams for latency debugging.</p></div>
  ${education}
  ${skills}
  <div class="section"><div class="section-title">Certifications</div>
    <p>Certified Kubernetes Administrator (CNCF), 2022.</p></div>
  ${extraBody}
</body></html>`;
}

function runSelfTest() {
  let passed = 0, failed = 0;
  const check = (label, cond) => {
    if (cond) { passed++; } else { failed++; console.log(`  FAIL: ${label}`); }
  };
  const hasIssue = (issues, substr) => issues.some(i => i.message.toLowerCase().includes(substr.toLowerCase()));
  const hasCritical = issues => issues.some(i => i.severity === 'critical');

  const clean = auditAts(buildCleanHtml());
  check('clean CV scores A (>=90)', clean.score >= 90 && clean.grade === 'A');
  check('clean CV has no critical issues', !hasCritical(clean.issues));
  check('clean CV passes the default gate', isPass(clean, DEFAULT_MIN_SCORE));

  const noSections = auditAts(buildCleanHtml({ education: '', skills: '' }));
  check('missing Education+Skills is flagged', hasIssue(noSections.issues, 'Education') && hasIssue(noSections.issues, 'Skills'));
  check('missing two required sections is critical', hasCritical(noSections.issues));

  {
    const localized = {
      fr: ['Expérience professionnelle', 'Formation', 'Compétences'],
      de: ['Berufserfahrung', 'Ausbildung', 'Kenntnisse'],
      es: ['Experiencia profesional', 'Formación', 'Competencias'],
      it: ['Esperienza professionale', 'Istruzione', 'Competenze'],
      pt: ['Experiência profissional', 'Formação', 'Habilidades'],
      nl: ['Werkervaring', 'Opleiding', 'Vaardigheden'],
      pl: ['Doświadczenie zawodowe', 'Wykształcenie', 'Umiejętności'],
      tr: ['İş deneyimi', 'Eğitim', 'Beceriler'],
      da: ['Erhvervserfaring', 'Uddannelse', 'Kompetencer'],
      id: ['Pengalaman kerja', 'Pendidikan', 'Keahlian'],
      ja: ['職務経歴', '学歴', 'スキル'],
      ko: ['경력', '학력', '역량'],
      ru: ['Опыт работы', 'Образование', 'Навыки'],
      ua: ['Досвід роботи', 'Освіта', 'Навички'],
      ar: ['الخبرات المهنية', 'التعليم', 'مهارات'],
      hi: ['करियर इतिहास', 'शिक्षा', 'कौशल'],
      zh: ['工作经历', '教育背景', '技能'],
      'zh-TW': ['工作經歷', '學歷', '專業技能'],
    };
    const failing = Object.entries(localized)
      .filter(([, [exp, edu, skl]]) => {
        const cv = auditAts(buildCleanHtml({
          experience: `<div class="section"><div class="section-title">${exp}</div><p>Senior Engineer, Acme, 2019 - 2024.</p></div>`,
          education: `<div class="section"><div class="section-title">${edu}</div><p>B.S. Computer Science, State University, 2018. Graduated with honors.</p></div>`,
          skills: `<div class="section"><div class="section-title">${skl}</div><p>Python, Kubernetes, Docker, PostgreSQL, distributed systems, CI/CD pipelines.</p></div>`,
        }));
        return hasIssue(cv.issues, 'missing standard section');
      })
      .map(([lang]) => lang);
    check(`every localized mode's CV headings are recognized (${Object.keys(localized).length} languages)`,
      failing.length === 0);
  }

  const entityHeading = auditAts(buildCleanHtml({
    education: '<div class="section"><div class="section-title">&Eacute;ducation</div><p>B.S. Computer Science, State University, 2018. Graduated with honors.</p></div>',
  }));
  check('an HTML-entity heading is decoded before matching', !hasIssue(entityHeading.issues, 'missing standard section'));

  for (const heading of ['Personal Information', 'Informations personnelles', 'Información personal']) {
    const noEdu = auditAts(buildCleanHtml({ education: `<div class="section"><div class="section-title">${heading}</div><p>Based in San Francisco.</p></div>` }));
    check(`"${heading}" does not pass for Education`, hasIssue(noEdu.issues, 'missing standard section'));
  }
  for (const heading of ['Berufserfahrung', 'Werkervaring', 'Erhvervserfaring']) {
    const compound = auditAts(buildCleanHtml({ experience: `<div class="section"><div class="section-title">${heading}</div><p>Senior Engineer, Acme, 2019 - 2024.</p></div>` }));
    check(`compound heading "${heading}" is recognized for Experience`, !hasIssue(compound.issues, 'missing standard section'));
  }

  check('decodeEntities does not double-unescape', decodeEntities('&amp;lt;') === '&lt;');
  check('decodeEntities reads decimal and hex forms', decodeEntities('&#233;&#xe9;&#XE9;') === 'ééé');
  check('decodeEntities leaves an unknown entity alone', decodeEntities('&nosuch; &#xZZ; R&D') === '&nosuch; &#xZZ; R&D');

  const tableCv = auditAts(
    '<html><head><meta charset="utf-8"></head><body><table><tr><td>' +
    'Experience</td><td>Education</td></tr><tr><td>Skills: Python, Kubernetes and a long ' +
    'description of responsibilities to provide enough selectable text for the parser to read ' +
    'without tripping the low-text image heuristic here.</td><td>jane@example.com</td></tr></table></body></html>'
  );
  check('table layout is flagged', hasIssue(tableCv.issues, '<table>'));
  check('table layout is critical', hasCritical(tableCv.issues));

  const imgCv = auditAts('<html><head><meta charset="utf-8"></head><body><img src="resume.png"><p>Resume</p></body></html>');
  check('content image with low text is flagged', hasIssue(imgCv.issues, 'image'));
  check('content image with low text is critical', hasCritical(imgCv.issues));

  const documentedImg = auditAts(buildCleanHtml({
    extraBody: '<style>/* with no candidate.photo no <img> is emitted */</style>' +
      '<!-- the photo slot emits an <img src="me.jpg"> when opted in -->',
  }));
  check('an <img> inside a comment or <style> is not counted', !hasIssue(documentedImg.issues, 'image'));

  const realImg = auditAts(buildCleanHtml({ extraBody: '<img src="chart.png">' }));
  check('a rendered <img> is still counted', hasIssue(realImg.issues, 'non-photo image'));

  const badFont = auditAts(buildCleanHtml({ font: "'Comic Sans MS', cursive" }));
  check('non-standard font is flagged', hasIssue(badFont.issues, 'comic sans ms'));

  const varFont = auditAts(buildCleanHtml({ font: 'var(--font-family), Arial, sans-serif' }));
  check('a var() reference is not reported as a font', !hasIssue(varFont.issues, 'non-standard font'));

  const varFallback = auditAts(buildCleanHtml({ font: "var(--font-family, 'Comic Sans MS'), sans-serif" }));
  check('a font in a var() fallback is still flagged', hasIssue(varFallback.issues, 'comic sans ms'));

  const varNonAscii = auditAts(buildCleanHtml({ font: 'var(--字体, Arial), var(--police-caractères), sans-serif' }));
  check('a non-ASCII custom-property name is consumed whole', !hasIssue(varNonAscii.issues, 'non-standard font'));

  const varEscaped = auditAts(buildCleanHtml({ font: 'var(--a\\,b), Arial, sans-serif' }));
  check('an escaped character in a custom-property name is consumed', !hasIssue(varEscaped.issues, 'non-standard font'));

  const varNbsp = auditAts(buildCleanHtml({ font: 'var(--font family), Arial, sans-serif' }));
  check('U+00A0 inside a custom-property name is not a separator', !hasIssue(varNbsp.issues, 'non-standard font'));

  const varSpaced = auditAts(buildCleanHtml({ font: 'var( --font-family ), Arial, sans-serif' }));
  check('CSS whitespace around a custom-property name is skipped', !hasIssue(varSpaced.issues, 'non-standard font'));

  const nbspFont = auditAts(buildCleanHtml({ font: "' Arial', sans-serif" }));
  check('a leading U+00A0 does not trim a family onto the safe list', hasIssue(nbspFont.issues, 'non-standard font'));

  check('an invisible character in a flagged font is shown as an escape', hasIssue(nbspFont.issues, '\\u00a0arial'));

  const paddedFont = auditAts(buildCleanHtml({ font: "'  Arial  ', sans-serif" }));
  check('CSS whitespace around a family name is still trimmed', !hasIssue(paddedFont.issues, 'non-standard font'));

  const nbspUnsafe = auditAts(buildCleanHtml({ font: "' Comic Sans MS', sans-serif" }));
  check('a flagged font keeps its real name', hasIssue(nbspUnsafe.issues, '\\u00a0comic sans ms'));

  const astralFont = auditAts(buildCleanHtml({ font: "'\u{E0001}Arial', sans-serif" }));
  check('a format character above the BMP is escaped in braces', hasIssue(astralFont.issues, '\\u{e0001}arial'));

  check('a BMP character keeps the bare four-digit escape', hasIssue(nbspFont.issues, '\\u00a0arial'));

  const cjkFallbacks = auditAts(buildCleanHtml({
    font: "var(--font-family), 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', " +
      "'Noto Sans KR', 'Nanum Gothic', 'PingFang TC', 'Microsoft JhengHei', " +
      "'Noto Sans CJK TC', 'Noto Sans TC', 'Source Han Sans TC', sans-serif",
  }));
  check('Korean/Traditional Chinese fallbacks are not flagged', !hasIssue(cjkFallbacks.issues, 'non-standard font'));

  const noEmail = auditAts(buildCleanHtml({ email: 'San Francisco' }));
  check('missing email is flagged', hasIssue(noEmail.issues, 'no email'));
  check('missing email is critical', hasCritical(noEmail.issues));

  const hidden = auditAts(buildCleanHtml({ extraBody: '<span style="color:#ffffff">python kubernetes aws rust golang</span>' }));
  check('hidden white text is flagged', hasIssue(hidden.issues, 'hidden text'));

  const hiddenSingleQuote = auditAts(buildCleanHtml({ extraBody: "<span style='color:#ffffff'>python rust golang aws terraform</span>" }));
  check('single-quoted white text is flagged', hasIssue(hiddenSingleQuote.issues, 'hidden text'));

  for (const [label, style] of [
    ['white background-color with dark text', 'background-color:#fff; color:#111'],
    ['named white background-color with dark text', 'background-color:white;color:#222'],
    ['white border-color with dark text', 'border-color:#fff; color:#000'],
  ]) {
    const visible = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">Senior engineer</span>` }));
    check(`${label} is not flagged as hidden text`, !hasIssue(visible.issues, 'hidden text'));
  }
  for (const [label, style] of [
    ['bare color:#fff', 'color:#fff'],
    ['color:#ffffff after another declaration', 'font-weight:bold;color:#ffffff'],
    ['color:white after a space', 'font-weight:bold; color:white'],
    ['color:rgb(255,255,255)', 'color:rgb(255, 255, 255)'],
  ]) {
    const stuffed = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">python kubernetes aws rust golang</span>` }));
    check(`${label} is still flagged as hidden text`, hasIssue(stuffed.issues, 'hidden text'));
  }
  for (const [label, style] of [
    ['-webkit-text-fill-color:#fff over dark color', '-webkit-text-fill-color:#fff;color:#111'],
    ['-webkit-text-fill-color:white after another declaration', 'font-weight:bold;-webkit-text-fill-color:white;color:#111'],
    ['color:#fff after a comment following a declaration', 'background:red;/**/color:#fff'],
    ['color:#fff after a leading comment', '/**/color:#fff'],
  ]) {
    const stuffed = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">python kubernetes aws rust golang</span>` }));
    check(`${label} is flagged as hidden text`, hasIssue(stuffed.issues, 'hidden text'));
  }
  const commentedBackground = auditAts(buildCleanHtml({ extraBody: '<span style="background-color:/**/#fff;color:#111">Senior engineer</span>' }));
  check('white background-color with an inner comment is not flagged as hidden text', !hasIssue(commentedBackground.issues, 'hidden text'));
  const splitIdent = auditAts(buildCleanHtml({ extraBody: '<span style="col/**/or:#fff">Senior engineer</span>' }));
  check('a comment splitting the property name is not flagged as hidden text', !hasIssue(splitIdent.issues, 'hidden text'));
  const quotedMarkers = auditAts(buildCleanHtml({ extraBody: `<span style="font-family:'/*';color:#fff;font-family:'*/'">python kubernetes aws rust golang</span>` }));
  check('comment markers inside quoted values do not hide a real white declaration', hasIssue(quotedMarkers.issues, 'hidden text'));
  const quotedFake = auditAts(buildCleanHtml({ extraBody: `<span style="font-family:';color/**/:#fff';color:#111">Senior engineer</span>` }));
  check('a white declaration inside a quoted value is not flagged as hidden text', !hasIssue(quotedFake.issues, 'hidden text'));
  const manyComments = `<span style=";${'/**/'.repeat(30)}colour:#fff">Senior engineer</span>`;
  const auditStarted = performance.now();
  auditAts(buildCleanHtml({ extraBody: manyComments }));
  check('a long run of comments does not backtrack catastrophically', performance.now() - auditStarted < 1000);
  const manyParens = `<span style="${'('.repeat(400000)}">Senior engineer</span>`;
  const parensStarted = performance.now();
  auditAts(buildCleanHtml({ extraBody: manyParens }));
  check('a long run of open parentheses stays linear', performance.now() - parensStarted < 1000);
  const unterminated = `<span style="${';/*'.repeat(33334)}colour:#fff">Senior engineer</span>`;
  const unterminatedStarted = performance.now();
  auditAts(buildCleanHtml({ extraBody: unterminated }));
  check('a long run of unterminated comments stays linear', performance.now() - unterminatedStarted < 1000);
  for (const [label, style] of [
    ['inside a quoted value', `--x:'/*;color:#fff';color:#111`],
    ['inside a comment', 'color:#111;/*;color:#fff*/'],
  ]) {
    const inert = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">Senior engineer</span>` }));
    check(`white text ${label} is not flagged as hidden text`, !hasIssue(inert.issues, 'hidden text'));
  }
  for (const [label, style] of [
    ['after an unterminated string', `font-family:'abc;color:#fff`],
    ['after an escaped semicolon', 'a:b\\;color:#fff'],
  ]) {
    const swallowed = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">Senior engineer</span>` }));
    check(`white text ${label} is not flagged as hidden text`, !hasIssue(swallowed.issues, 'hidden text'));
  }
  for (const [label, nl] of [['LF', '\n'], ['CR', '\r'], ['FF', '\f'], ['CRLF', '\r\n']]) {
    const broken = auditAts(buildCleanHtml({ extraBody: `<span style="font-family:'x${nl};color:white">python kubernetes aws rust golang</span>` }));
    check(`white text after a string broken by ${label} is flagged as hidden text`, hasIssue(broken.issues, 'hidden text'));
  }
  for (const [label, nl] of [['LF', '\n'], ['CR', '\r'], ['FF', '\f'], ['CRLF', '\r\n']]) {
    const continued = auditAts(buildCleanHtml({ extraBody: `<span style="font-family:'x\\${nl}';color:white">python kubernetes aws rust golang</span>` }));
    check(`white text after a string continued over an escaped ${label} is flagged as hidden text`, hasIssue(continued.issues, 'hidden text'));
  }
  const attrQuote = style => (style.includes('"') ? "'" : '"');
  for (const [label, style] of [
    ['a double quote in an unquoted url()', 'background:url(foo";x);color:white'],
    ['a single quote in an unquoted url()', "background:url(foo';x);color:white"],
    ['an uppercase URL() with a quote in it', 'background:URL(foo";x);color:white'],
    ['an escaped paren inside an unquoted url()', 'background:url(a\\);b";x);color:white'],
    ['a stray open paren in an unquoted url()', 'background:url(a(b";x);color:white'],
  ]) {
    const badUrl = auditAts(buildCleanHtml({ extraBody: `<span style=${attrQuote(style)}${style}${attrQuote(style)}>python kubernetes aws rust golang</span>` }));
    check(`white text after ${label} is flagged as hidden text`, hasIssue(badUrl.issues, 'hidden text'));
  }
  for (const [label, style] of [
    ['inside an unquoted url()', 'background:url(data:x;color:white)'],
    ['inside a quoted url()', `background:url("data:x;color:white")`],
    ['inside an unterminated unquoted url()', 'background:url(foo;color:white'],
    ['after a function whose name only ends in url', 'background:myurl(foo";x);color:white'],
  ]) {
    const inertUrl = auditAts(buildCleanHtml({ extraBody: `<span style=${attrQuote(style)}${style}${attrQuote(style)}>Senior engineer</span>` }));
    check(`white text ${label} is not flagged as hidden text`, !hasIssue(inertUrl.issues, 'hidden text'));
  }
  const spacedQuoted = auditAts(buildCleanHtml({ extraBody: `<span style="background:url(  'a)b'  );color:white">python kubernetes aws rust golang</span>` }));
  check('white text after a quoted url() argument with leading space is flagged as hidden text', hasIssue(spacedQuoted.issues, 'hidden text'));
  for (const [label, style] of [
    ['inside url()', 'background:url(data:x;color:white)'],
    ['inside a function', 'background:foo(abc;color:white)'],
    ['inside brackets', 'grid-template-areas:[a;color:white]'],
  ]) {
    const nested = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">Senior engineer</span>` }));
    check(`white text ${label} is not flagged as hidden text`, !hasIssue(nested.issues, 'hidden text'));
  }
  for (const [label, style] of [
    ['a comment before the colon', 'color/**/:#fff'],
    ['a comment after the colon', 'color:/**/#fff'],
  ]) {
    const commented = auditAts(buildCleanHtml({ extraBody: `<span style="${style}">python kubernetes aws rust golang</span>` }));
    check(`white text with ${label} is still flagged as hidden text`, hasIssue(commented.issues, 'hidden text'));
  }

  const inlineFont = auditAts(buildCleanHtml({ extraBody: '<p style="font-family:\'Comic Sans MS\'">extra line</p>' }));
  check('inline non-standard font is flagged', hasIssue(inlineFont.issues, 'comic sans ms'));

  const yearRangeOnly = auditAts(
    '<html><head><meta charset="utf-8"></head><body>' +
    '<div class="section-title">Work Experience</div><div class="section-title">Education</div>' +
    '<div class="section-title">Skills</div>' +
    '<p>Reach me at jane@example.com. Employed 2019 - 2024 building reliable, high-throughput ' +
    'distributed systems on Kubernetes, with clean, well-tested Python services used daily across ' +
    'the whole organization and its many engineering teams.</p></body></html>'
  );
  check('a bare year range is not counted as a phone', hasIssue(yearRangeOnly.issues, 'no phone number'));
  check('a real phone number is detected', !hasIssue(auditAts(buildCleanHtml()).issues, 'no phone number'));

  const headerOnlyEmail = auditAts(
    '<html><head><meta charset="utf-8"></head><body>' +
    '<header><div>jane@example.com | +1 415 555 0100</div></header>' +
    '<div class="section-title">Work Experience</div>' +
    '<div class="section-title">Education</div><div class="section-title">Skills</div>' +
    '<p>Built and operated reliable, high-throughput distributed systems on Kubernetes with ' +
    'clean, well-tested Python services used daily across many engineering teams, focusing on ' +
    'observability, cost efficiency, and resilient delivery pipelines shipped safely to ' +
    'production several times per day for years.</p></body></html>'
  );
  check('email only in a semantic <header> is critical', hasCritical(headerOnlyEmail.issues) && hasIssue(headerOnlyEmail.issues, '<header>'));
  check('email only in a semantic <header> fails the gate', !isPass(headerOnlyEmail, DEFAULT_MIN_SCORE));

  const buriedContact = auditAts(
    '<html><head><meta charset="utf-8"></head><body>' +
    '<!-- <a href="mailto:ghost@example.com">x</a> --><script>var t = "tel:+15551234567";</script>' +
    '<div class="section-title">Work Experience</div><div class="section-title">Education</div>' +
    '<div class="section-title">Skills</div>' +
    '<p>Built and operated reliable, high-throughput distributed systems on Kubernetes with clean, ' +
    'well-tested Python services used daily across many engineering teams for years and years now.</p>' +
    '</body></html>'
  );
  check('mailto/tel in a comment or script is not a reachable email', hasIssue(buriedContact.issues, 'no email'));

  const mailtoHrefOnly = auditAts(buildCleanHtml({ email: '<a href="mailto:jane@example.com">Email me</a>' }));
  check('mailto: href with non-email link text still counts', !hasIssue(mailtoHrefOnly.issues, 'no email'));

  const twoDigitCols = auditAts(buildCleanHtml({ extraBody: '<style>.grid{column-count:10;}</style>' }));
  check('two-digit column-count is flagged', hasIssue(twoDigitCols.issues, 'multi-column'));
  const inlineCols = auditAts(buildCleanHtml({ extraBody: '<div style="columns: 2">a b</div>' }));
  check('inline columns shorthand is flagged', hasIssue(inlineCols.issues, 'multi-column'));

  const withKeywords = auditAts(buildCleanHtml(), { keywords: 'python, kubernetes, rust' });
  check('keyword coverage computed when supplied', withKeywords.keywordCoverage !== null);
  check('keyword coverage percent is correct (2/3)', withKeywords.keywordCoverage.percent === 67);
  check('missing keyword is listed', withKeywords.keywordCoverage.missing.includes('rust'));
  check('supplying keywords does not change the score', withKeywords.score === clean.score);
  check('no keyword coverage without --keywords/--role', clean.keywordCoverage === null);

  console.log(`\nverify-ats self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function printHuman(result, file, minScore) {
  const pass = isPass(result, minScore);
  console.log(`ATS check: ${file}`);
  console.log(`Score: ${result.score}/100 (${result.grade})   Threshold: ${minScore}`);
  if (result.issues.length) {
    console.log('\nIssues:');
    for (const i of result.issues) console.log(`  [${i.severity}] ${i.message}`);
  }
  if (result.keywordCoverage) {
    const k = result.keywordCoverage;
    console.log(`\nKeyword coverage: ${k.found}/${k.total} (${k.percent}%)`);
    if (k.missing.length) console.log(`  Missing: ${k.missing.join(', ')}`);
  }
  console.log(`\nATS check ${pass ? 'passed' : 'failed'}: ${file}`);
  if (!pass) {
    console.log('Fix the critical/warning items above, or lower the bar with --min-score if you accept the risk.');
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    runSelfTest();
  } else {
    let targetArg = '';
    let keywords = '';
    let role = '';
    let minScore = DEFAULT_MIN_SCORE;
    let asJson = false;

    const missingValue = (t) => t === undefined || t.startsWith('-');

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--keywords') {
        if (missingValue(args[i + 1])) { console.error('ERROR: --keywords requires a comma-separated list'); process.exit(1); }
        keywords = args[++i];
      } else if (arg === '--role') {
        if (missingValue(args[i + 1])) { console.error('ERROR: --role requires a value'); process.exit(1); }
        role = args[++i];
      } else if (arg === '--min-score') {
        if (!args[i + 1]) { console.error('ERROR: --min-score requires a number'); process.exit(1); }
        minScore = Number(args[++i]);
        if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
          console.error('ERROR: --min-score must be a number between 0 and 100');
          process.exit(1);
        }
      } else if (arg === '--json') {
        asJson = true;
      } else if (arg === '--help' || arg === '-h') {
      } else if (arg.startsWith('--')) {
        console.error(`ERROR: unknown option: ${arg}`);
        process.exit(1);
      } else if (!targetArg) {
        targetArg = arg;
      } else {
        console.error(`ERROR: unexpected extra positional argument: ${arg}`);
        process.exit(1);
      }
    }

    const helpRequested = args.includes('--help') || args.includes('-h');
    if (!targetArg || helpRequested) {
      console.log(`Usage: node verify-ats.mjs <generated-cv.html> [--keywords "a,b,c"] [--role "..."] [--min-score N] [--json]

Scores a generated CV's HTML for ATS parseability (0-100 + letter grade) and lists
concrete, fixable issues. Deterministic, read-only. Exits 0 when score >= --min-score
(default ${DEFAULT_MIN_SCORE}) and no critical issue is present, else 1.

Keyword coverage (--keywords / --role) is advisory and never changes the score.`);
      process.exit(helpRequested ? 0 : 1);
    }

    const targetPath = isAbsolute(targetArg) ? targetArg : join(process.cwd(), targetArg);
    let html;
    try {
      if (!statSync(targetPath).isFile()) throw new Error('not a regular file');
      html = readFileSync(targetPath, 'utf-8');
    } catch (err) {
      console.error(`ERROR: cannot read target file: ${targetArg} (${err.code || err.message})`);
      process.exit(1);
    }
    const result = auditAts(html, { keywords, role });
    const pass = isPass(result, minScore);
    const file = basename(targetPath);

    if (asJson) {
      console.log(JSON.stringify({ file, pass, minScore, ...result }, null, 2));
    } else {
      printHuman(result, file, minScore);
    }
    process.exitCode = pass ? 0 : 1;
  }
}
