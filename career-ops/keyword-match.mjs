#!/usr/bin/env node

import { readFileSync, existsSync, statSync  } from 'fs';
import { join, isAbsolute, basename } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

export const SYNONYMS = [
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['kubernetes', 'k8s'],
  ['machine learning', 'ml'],
  ['ci/cd', 'cicd'],
  ['infrastructure as code', 'iac'],
  ['natural language processing', 'nlp'],
  ['large language model', 'large language models', 'llm'],
  ['amazon web services', 'aws'],
  ['google cloud platform', 'gcp'],
  ['postgresql', 'postgres'],
];

export function normalizeText(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function countOccurrences(term, text) {
  const t = normalizeText(term);
  if (!t) return 0;
  const hay = normalizeText(text);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g');
  const matches = hay.match(re);
  return matches ? matches.length : 0;
}

export function variantForms(term) {
  const t = normalizeText(term);
  const forms = new Set([t]);
  if (t.length < 3) return [...forms];
  if (!t.endsWith('s')) forms.add(t + 's');
  else if (t.length > 3) forms.add(t.slice(0, -1));
  return [...forms];
}

export function expandTerms(keyword) {
  const k = normalizeText(keyword);
  const forms = variantForms(k);
  const terms = new Set(forms);
  for (const group of SYNONYMS) {
    if (!forms.some((form) => group.includes(form))) continue;
    for (const member of group) {
      if (member === k) continue;
      for (const v of variantForms(member)) terms.add(v);
    }
  }
  return [...terms];
}

export function keywordCount(keyword, text) {
  let total = 0;
  for (const term of expandTerms(keyword)) total += countOccurrences(term, text);
  return total;
}

export function analyzeCoverage(keywords, cvText) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of keywords || []) {
    const k = String(raw).trim();
    if (!k) continue;
    const key = normalizeText(k);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(k);
  }

  const present = [];
  const thin = [];
  const missing = [];
  for (const k of cleaned) {
    const count = keywordCount(k, cvText || '');
    if (count === 0) {
      missing.push(k);
    } else {
      present.push(k);
      if (count === 1) thin.push(k);
    }
  }

  const total = cleaned.length;
  const presentCount = present.length;
  const coveragePct = total === 0 ? 0 : Math.round((presentCount / total) * 100);
  return { total, presentCount, coveragePct, present, thin, missing };
}

export const KEYWORDS_HEADINGS = [
  'Keywords extracted',
  'Extracted Keywords',
  'Udtrukne nøgleord',
  'Extrahierte Keywords',
  'Palabras clave extraídas',
  'Mots-cles extraits',
  'निकाले गए Keywords',
  'Kata kunci terekstraksi',
  'Parole chiave estratte',
  '추출한 키워드',
  'Geextraheerde trefwoorden',
  'Wyekstrahowane słowa kluczowe',
  'Keywords extraídas',
  'Извлечённые ключевые слова',
  'Çıkarılan Anahtar Kelimeler',
  'Витягнуті ключові слова',
  'ATS 关键词提取',
  'ATS 關鍵字擷取',
];

function headingKey(title) {
  return normalizeText(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const KEYWORDS_HEADING_KEYS = KEYWORDS_HEADINGS.map(headingKey);

function isKeywordsHeading(line) {
  const m = /^##\s+(\S.*)$/.exec(line);
  if (!m) return false;
  const title = headingKey(m[1]);
  return KEYWORDS_HEADING_KEYS.some((key) =>
    title.startsWith(key) && !/^[\p{L}\p{N}]/u.test(title.slice(key.length)));
}

export function extractKeywords(reportText) {
  const lines = String(reportText || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isKeywordsHeading(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^##\s+/.test(line)) break;
    if (!line) continue;
    if (/^\(.*\)$/.test(line)) continue;
    const body = line.replace(/^[-*]\s+/, '');
    for (const part of body.split(',')) {
      const kw = part.trim().replace(/\.+$/, '').trim();
      if (kw) out.push(kw);
    }
  }
  return out;
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatCoverageMarkdown(result, sourceLabel) {
  const { coveragePct, presentCount, total, present, thin, missing } = result;
  const out = [
    '## Keyword Coverage',
    '',
    `**ATS coverage: ${coveragePct}%** (${presentCount}/${total} keywords present)`,
    '',
  ];
  if (sourceLabel) out.push(`_Scanned: ${sourceLabel}._`, '');
  out.push(`**Present (${present.length}):** ${present.join(', ') || '—'}`, '');
  if (thin.length) {
    out.push(`**Thin — mentioned once, consider reinforcing (${thin.length}):** ${thin.join(', ')}`, '');
  }
  out.push(
    `**Missing (${missing.length}):** ${missing.join(', ') || '—'}`,
    '',
    '> Diagnostic only. Add a missing keyword **only** if it reflects real ' +
      'experience — reformulated from your background, never fabricated.',
    '',
  );
  return out.join('\n');
}

function runSelfTest() {
  const cv = [
    'Senior engineer. Built Python services with FastAPI. Python remains my primary language.',
    'Deployed on k8s. Owned CI/CD pipelines. Wrote C++ modules and some JavaScript.',
    'Strong in machine  learning and PostgreSQL. Set up observability once.',
  ].join('\n');
  const keywords = ['Python', 'FastAPI', 'Kubernetes', 'CI/CD', 'C++',
    'Machine Learning', 'Postgres', 'observability', 'Java', 'gRPC'];
  const r = analyzeCoverage(keywords, cv);

  const failures = [];
  if (!r.present.includes('Python')) failures.push('exact hit (Python)');
  if (r.thin.includes('Python')) failures.push('Python (count 2) must not be thin');
  if (!r.present.includes('Kubernetes')) failures.push('synonym k8s->Kubernetes');
  if (!r.present.includes('Machine Learning')) failures.push('case/space variant');
  if (!r.present.includes('C++')) failures.push('symbol keyword C++');
  if (!r.present.includes('CI/CD')) failures.push('symbol keyword CI/CD');
  if (!r.present.includes('Postgres')) failures.push('synonym postgresql->Postgres');
  if (r.present.includes('Java')) failures.push('word boundary (Java matched JavaScript)');
  if (!r.missing.includes('Java')) failures.push('Java should be missing');
  if (!r.missing.includes('gRPC')) failures.push('gRPC should be missing');
  if (!r.thin.includes('observability')) failures.push('observability should be thin');
  if (r.coveragePct !== 80) failures.push(`coverage % = ${r.coveragePct} (expected 80)`);
  if (variantForms('aws').includes('aw')) failures.push('variantForms truncated acronym aws->aw');
  if (htmlToText('<style>.x{}</style><p>Python &amp; <b>gRPC</b></p>') !== 'Python & gRPC') {
    failures.push('htmlToText strip/decode');
  }

  if (failures.length) {
    console.error(`keyword-match self-test FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('keyword-match self-test OK');
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    runSelfTest();
  } else {
    let jsonMode = false;
    let cvArg = null;
    let reportArg = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];

      if (a === '--json') {
        jsonMode = true;
      } 
      else if (a === '--cv') {
        const next = args[i + 1];

        if (!next || next.startsWith('--')) {
          console.error('Missing value for --cv');
          process.exit(1);
        }

        cvArg = next;
        i++;
      } 
      else if (a.startsWith('--')) {
        console.error(`Unknown option: ${a}`);
        process.exit(1);
      }
      else if (reportArg === null) {
        reportArg = a;
      }
      else {
        console.error(`Unexpected argument: ${a}`);
        process.exit(1);
      }
    }

    if (!reportArg) {
      console.error('Usage: node keyword-match.mjs <report-file> [--cv <path>] [--json]');
      process.exit(1);
    }

    const reportPath = isAbsolute(reportArg) ? reportArg : join(process.cwd(), reportArg);

    if (!existsSync(reportPath) || !statSync(reportPath).isFile()) {
      console.error(`Report not found: ${reportArg}`);
      process.exit(1);
    }

    let reportText;
    try {
      reportText = readFileSync(reportPath, 'utf-8');
    } catch {
      console.error(`Unable to read report: ${reportArg}`);
      process.exit(1);
    }

    const keywords = extractKeywords(reportText);

    if (keywords.length === 0) {
      console.error('No "## Keywords extracted" block found (or it is empty).');
      process.exit(1);
    }

    const cvPath = cvArg
      ? (isAbsolute(cvArg) ? cvArg : join(process.cwd(), cvArg))
      : join(getCareerOpsRoot(), 'cv.md');

    if (!existsSync(cvPath) || !statSync(cvPath).isFile()) {
      console.error(`CV not found: ${cvPath}. Pass --cv <path> to point at your CV.`);
      process.exit(1);
    }

    let rawCv;
    try {
      rawCv = readFileSync(cvPath, 'utf-8');
    } catch {
      console.error(`Unable to read CV: ${cvPath}`);
      process.exit(1);
    }
    const cvText = /\.html?$/i.test(cvPath) ? htmlToText(rawCv) : rawCv;
    const sourceLabel = cvArg ? basename(cvPath) : 'cv.md (base CV, before per-role tailoring)';

    const result = analyzeCoverage(keywords, cvText);
    console.log(jsonMode ? JSON.stringify(result, null, 2) : formatCoverageMarkdown(result, sourceLabel));
  }
}
