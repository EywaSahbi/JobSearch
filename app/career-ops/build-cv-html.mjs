#!/usr/bin/env node

import { readFile, writeFile, stat, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, basename, join, extname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { stripEmptySections } from './cv-sections-core.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { hasRequiredFields, validatePayload } from './lib/cv-payload-schema.mjs';
import { PAGE_WIDTHS, resolvePageFormat } from './lib/page-format.mjs';
import { PARTIAL_SECTIONS, declaredSections, parseMeta } from './lib/template-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'cv-template.html');
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;
const CONTACT_ROW_RE = /<div class="contact-row">[\s\S]*?<\/div>/;

const PROFILE_PATH = resolve(DATA_ROOT, 'config', 'profile.yml');
const PHOTO_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const PHOTO_STYLES = new Set(['rounded', 'circle', 'square']);
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i;

const DEFAULT_SECTION_TITLES = {
  summary: 'Professional Summary',
  competencies: 'Core Competencies',
  experience: 'Work Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
  awards: 'Awards & Honors',
  interests: 'Interests',
  skills: 'Skills',
};

function escapeHtml(text) {
  if (text === null || text === undefined || typeof text === 'object') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';
  const allowedSchemes = ['mailto:', 'tel:', 'http:', 'https:'];
  const lower = url.toLowerCase();
  const hasScheme = allowedSchemes.some(s => lower.startsWith(s));
  if (!hasScheme) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      return '';
    }
    if (url.includes('@') && !url.includes('/')) {
      url = 'mailto:' + url;
    } else {
      url = 'https://' + url;
    }
  }
  return escapeHtml(url);
}

function sanitizeImageSrc(src) {
  if (typeof src !== 'string') return '';
  const value = src.trim();
  if (IMAGE_DATA_URL_RE.test(value)) return escapeHtml(value);
  if (/^https?:\/\//i.test(value)) return sanitizeUrl(value);
  return '';
}

async function prepareCandidatePhoto(candidate) {
  const c = candidate && typeof candidate === 'object' ? { ...candidate } : {};
  const photo = typeof c.photo === 'string' ? c.photo.trim() : '';
  const style = c.photo_style || c.photoStyle || 'rounded';

  if (!PHOTO_STYLES.has(style)) {
    throw new Error(`Unsupported profile photo style: ${style} (expected rounded, circle, or square)`);
  }
  c.photo_style = style;
  if (!photo) {
    c.photo = '';
    return c;
  }

  if (photo.startsWith('data:')) {
    if (!IMAGE_DATA_URL_RE.test(photo)) {
      throw new Error('Unsupported profile photo data URL (expected base64 PNG, JPEG, WebP, or GIF)');
    }
    c.photo = photo;
    return c;
  }

  if (/^https?:\/\//i.test(photo)) {
    c.photo = photo;
    return c;
  }

  if (/^[a-z][a-z0-9+.-]+:/i.test(photo)) {
    throw new Error(`Unsupported profile photo URL scheme: ${photo.split(':', 1)[0]}`);
  }

  const photoPath = isAbsolute(photo) ? photo : resolve(__dirname, photo);
  const mime = PHOTO_MIME_BY_EXT.get(extname(photoPath).toLowerCase());
  if (!mime) {
    throw new Error(`Unsupported profile photo format: ${photo} (expected PNG, JPEG, WebP, or GIF)`);
  }

  let bytes;
  try {
    bytes = await readFile(photoPath);
  } catch (err) {
    throw new Error(`Profile photo not found or unreadable: ${photo} (${err.code || err.message})`);
  }
  if (bytes.length === 0) {
    throw new Error(`Profile photo is empty: ${photo}`);
  }
  c.photo = `data:${mime};base64,${bytes.toString('base64')}`;
  return c;
}

function joinItems(items) {
  if (Array.isArray(items)) return items.join(', ');
  return typeof items === 'string' ? items : '';
}

function parsePartial(source) {
  const entryZoneMatch = /<!--ENTRY-->([\s\S]*?)<!--\/ENTRY-->/.exec(source);
  if (!entryZoneMatch) {
    throw new Error('Malformed partial: missing <!--ENTRY-->...<!--/ENTRY--> tags');
  }
  const entryZone = entryZoneMatch[1];

  const blockRe = /<!--([A-Z][A-Z0-9_]+)-->([\s\S]*?)<!--\/\1-->/g;
  const blocks = new Map();
  const definitionStrings = [];
  const definitions = new Map();
  let m;
  while ((m = blockRe.exec(entryZone)) !== null) {
    const name = m[1];
    const content = m[2];
    if (name === 'ENTRY') continue;
    definitionStrings.push(m[0]);
    definitions.set(name, content);
  }

  const EMPTY_SUFFIX = '_EMPTY';
  for (const [name, content] of definitions) {
    if (name.endsWith(EMPTY_SUFFIX)) continue;
    const existing = blocks.get(name) || { present: '', absent: '' };
    blocks.set(name, { ...existing, present: content });
  }
  for (const [name, content] of definitions) {
    if (!name.endsWith(EMPTY_SUFFIX)) continue;
    const stem = name.slice(0, -EMPTY_SUFFIX.length);
    const base = definitions.has(`${stem}_BLOCK`) ? `${stem}_BLOCK` : stem;
    const existing = blocks.get(base) || { present: '', absent: '' };
    blocks.set(base, { ...existing, absent: content });
  }

  let entryTemplate = entryZone;
  for (const def of definitionStrings) {
    entryTemplate = entryTemplate.split(def).join('');
  }
  entryTemplate = entryTemplate.trim();

  return { entryTemplate, blocks };
}

function fillEntry(entryTemplate, blocks, fields, blockValues) {
  let out = entryTemplate;

  if (blockValues) {
    for (const [name, { value, present }] of blockValues) {
      const block = blocks.get(name);
      if (!block) continue;
      const scalarKey = name.endsWith('_BLOCK') ? name.slice(0, -6) : name;
      const markup = present 
        ? block.present.replace(new RegExp(`\\{\\{(${name}|${scalarKey})\\}\\}`, 'g'), () => value) 
        : block.absent;
      out = out.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), () => markup);
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  return out;
}

function loadSectionPartials(templatePath) {
  const sectionsDir = join(dirname(templatePath), 'sections');
  let declared;
  try {
    declared = declaredSections(parseMeta(templatePath));
  } catch (err) {
    throw new Error(`Template ${templatePath}: ${err.message}`);
  }
  const owned = declared || new Set();
  const partials = new Map();
  const problems = [];

  for (const name of PARTIAL_SECTIONS) {
    const partialPath = join(sectionsDir, `${name}.html`);
    const rel = `sections/${name}.html`;
    if (!existsSync(partialPath)) {
      if (owned.has(name)) problems.push(`${rel} is declared but does not exist`);
      continue;
    }
    let parsed;
    try {
      parsed = parsePartial(readFileSync(partialPath, 'utf-8'));
    } catch (err) {
      if (owned.has(name)) problems.push(`${rel} is declared but malformed: ${err.message}`);
      continue;
    }
    if (owned.has(name) && !parsed.entryTemplate) {
      problems.push(`${rel} is declared but its ENTRY zone is empty`);
      continue;
    }
    partials.set(name, parsed);
  }

  if (problems.length) {
    throw new Error(
      `Template ${templatePath} declares sections it cannot render:\n`
        + problems.map((p) => `  - ${p}`).join('\n')
        + '\nA declared section must ship a partial that parses — fix the file, or drop it from the manifest\'s "sections" list.'
    );
  }
  return partials;
}

function buildCompetencies(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries
      .filter(Boolean)
      .map(tag => `<span class="competency-tag">${escapeHtml(String(tag))}</span>`)
      .join('\n      ');
  }
  const { entryTemplate, blocks } = partial;
  return entries
    .filter(Boolean)
    .map(tag => fillEntry(entryTemplate, blocks, { TAG: escapeHtml(String(tag)) }, null))
    .join('\n      ');
}

function buildExperience(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries.filter(e => hasRequiredFields(e, 'experience', 'html')).map(e => {
      const bullets = Array.isArray(e.bullets)
        ? e.bullets.filter(Boolean).map(b => `        <li>${escapeHtml(b)}</li>`).join('\n')
        : '';
      const location = e.location
        ? `\n    <div class="job-location">${escapeHtml(e.location)}</div>`
        : '';
      const context = e.context
        ? `\n    <div class="job-context">${escapeHtml(e.context)}</div>`
        : '';
      return `<div class="job">
    <div class="job-header">
      <span class="job-company">${escapeHtml(e.company)}</span>
      <span class="job-period">${escapeHtml(e.dates || e.period || '')}</span>
    </div>
    <div class="job-role">${escapeHtml(e.role)}</div>${context}${location}
    <ul>
${bullets}
    </ul>
  </div>`;
    }).join('\n  ');
  }

  const { entryTemplate, blocks } = partial;
  return entries.filter(e => hasRequiredFields(e, 'experience', 'html')).map(e => {
    const bullets = Array.isArray(e.bullets)
      ? e.bullets.filter(Boolean).map(b => `<li>${escapeHtml(b)}</li>`).join('\n    ')
      : '';
    const blockValues = new Map([
      ['LOCATION_BLOCK', { value: escapeHtml(e.location || ''), present: Boolean(e.location) }],
      ['CONTEXT_BLOCK', { value: escapeHtml(e.context || ''), present: Boolean(e.context) }],
    ]);
    return fillEntry(entryTemplate, blocks, {
      COMPANY: escapeHtml(e.company || ''),
      PERIOD: escapeHtml(e.dates || e.period || ''),
      ROLE: escapeHtml(e.role || ''),
      LOCATION: escapeHtml(e.location || ''),
      CONTEXT: escapeHtml(e.context || ''),
      BULLETS: bullets,
    }, blockValues);
  }).join('\n  ');
}

function buildProjects(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries.filter(e => hasRequiredFields(e, 'projects', 'html')).map(e => {
      const badge = e.badge
        ? `<span class="project-badge">${escapeHtml(e.badge)}</span>`
        : '';
      const nameText = escapeHtml(e.name || '');
      const url = sanitizeUrl(e.url);
      const nameHtml = url
        ? `<a href="${url}">${nameText}</a>`
        : nameText;
      const descText = e.description
        || (Array.isArray(e.bullets) ? e.bullets.filter(Boolean).join(' ') : '');
      const desc = descText
        ? `\n    <div class="project-desc">${escapeHtml(descText)}</div>`
        : '';
      const tech = e.tech
        ? `\n    <div class="project-tech">${escapeHtml(e.tech)}</div>`
        : '';
      return `<div class="project">
    <div class="project-title">${nameHtml}${badge}</div>${desc}${tech}
  </div>`;
    }).join('\n  ');
  }

  const { entryTemplate, blocks } = partial;
  return entries.filter(e => hasRequiredFields(e, 'projects', 'html')).map(e => {
    const descText = e.description
      || (Array.isArray(e.bullets) ? e.bullets.filter(Boolean).join(' ') : '');
    const blockValues = new Map([
      ['BADGE_BLOCK', { value: escapeHtml(e.badge || ''), present: Boolean(e.badge) }],
      ['DESC_BLOCK',  { value: escapeHtml(descText),      present: Boolean(descText) }],
      ['TECH_BLOCK',  { value: escapeHtml(e.tech || ''),  present: Boolean(e.tech) }],
    ]);
    const nameText = escapeHtml(e.name || '');
    const url = sanitizeUrl(e.url);
    const nameHtml = url
      ? `<a href="${url}">${nameText}</a>`
      : nameText;
    let entryBlocks = blocks;
    const multi = !e.description && Array.isArray(e.bullets)
      ? e.bullets.filter(Boolean) : [];
    const descBlock = blocks.get('DESC_BLOCK');
    if (multi.length > 1 && descBlock) {
      const literalBraces = (t) => escapeHtml(t).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
      const present = multi
        .map(b => descBlock.present.replace(/\{\{(DESC_BLOCK|DESC)\}\}/g, () => literalBraces(b)))
        .join('\n  ');
      entryBlocks = new Map(blocks);
      entryBlocks.set('DESC_BLOCK', { ...descBlock, present });
    }
    return fillEntry(entryTemplate, entryBlocks, {
      NAME:  nameHtml,
      BADGE: escapeHtml(e.badge || ''),
      DESC:  escapeHtml(descText),
      TECH:  escapeHtml(e.tech || ''),
    }, blockValues);
  }).join('\n  ');
}

function buildEducation(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries.filter(e => hasRequiredFields(e, 'education', 'html')).map(e => {
      const org = e.org
        ? ` <span class="edu-org">${escapeHtml(e.org)}</span>`
        : '';
      const location = e.location
        ? `\n    <div class="edu-location">${escapeHtml(e.location)}</div>`
        : '';
      const desc = e.description
        ? `\n    <div class="edu-desc">${escapeHtml(e.description)}</div>`
        : '';
      return `<div class="edu-item">
    <div class="edu-header">
      <div class="edu-title">${escapeHtml(e.title)}${org}</div>
      <div class="edu-year">${escapeHtml(e.year || '')}</div>
    </div>${location}${desc}
  </div>`;
    }).join('\n  ');
  }

  const { entryTemplate, blocks } = partial;
  return entries.filter(e => hasRequiredFields(e, 'education', 'html')).map(e => {
    const blockValues = new Map([
      ['ORG_BLOCK',      { value: escapeHtml(e.org || ''),         present: Boolean(e.org) }],
      ['LOCATION_BLOCK', { value: escapeHtml(e.location || ''),    present: Boolean(e.location) }],
      ['DESC_BLOCK',     { value: escapeHtml(e.description || ''), present: Boolean(e.description) }],
    ]);
    return fillEntry(entryTemplate, blocks, {
      TITLE:    escapeHtml(e.title || ''),
      ORG:      escapeHtml(e.org || ''),
      LOCATION: escapeHtml(e.location || ''),
      YEAR:     escapeHtml(e.year || ''),
      DESC:     escapeHtml(e.description || ''),
    }, blockValues);
  }).join('\n  ');
}

function buildCertifications(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries.filter(e => hasRequiredFields(e, 'certifications', 'html')).map(e => {
      const org = e.org ? `<span class="cert-org">${escapeHtml(e.org)}</span>` : '<span class="cert-org"></span>';
      const year = e.year ? `<span class="cert-year">${escapeHtml(e.year)}</span>` : '<span class="cert-year"></span>';
      return `<div class="cert-item">
      <span class="cert-title">${escapeHtml(e.title)}</span>
      ${org}
      ${year}
    </div>`;
    }).join('\n    ');
  }

  const { entryTemplate, blocks } = partial;
  return entries.filter(e => hasRequiredFields(e, 'certifications', 'html')).map(e => {
    const blockValues = new Map([
      ['ORG_BLOCK',  { value: escapeHtml(e.org || ''),  present: Boolean(e.org) }],
      ['YEAR_BLOCK', { value: escapeHtml(e.year || ''), present: Boolean(e.year) }],
    ]);
    return fillEntry(entryTemplate, blocks, {
      TITLE: escapeHtml(e.title || ''),
      ORG:   escapeHtml(e.org || ''),
      YEAR:  escapeHtml(e.year || ''),
    }, blockValues);
  }).join('\n    ');
}

function buildAwards(entries, partial) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  if (!partial) {
    return entries.filter(e => hasRequiredFields(e, 'awards', 'html')).map(e => {
      const org = e.org ? `<span class="award-org">${escapeHtml(e.org)}</span>` : '<span class="award-org"></span>';
      const year = e.year ? `<span class="award-year">${escapeHtml(e.year)}</span>` : '<span class="award-year"></span>';
      return `<div class="award-item">
      <span class="award-title">${escapeHtml(e.title)}</span>
      ${org}
      ${year}
    </div>`;
    }).join('\n    ');
  }

  const { entryTemplate, blocks } = partial;
  return entries.filter(e => hasRequiredFields(e, 'awards', 'html')).map(e => {
    const blockValues = new Map([
      ['ORG_BLOCK',  { value: escapeHtml(e.org || ''),  present: Boolean(e.org) }],
      ['YEAR_BLOCK', { value: escapeHtml(e.year || ''), present: Boolean(e.year) }],
    ]);
    return fillEntry(entryTemplate, blocks, {
      TITLE: escapeHtml(e.title || ''),
      ORG:   escapeHtml(e.org || ''),
      YEAR:  escapeHtml(e.year || ''),
    }, blockValues);
  }).join('\n    ');
}

function buildInterests(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .filter(Boolean)
    .map(String)
    .map((item, idx) => (idx === 0 ? item : item.charAt(0).toLowerCase() + item.slice(1)))
    .map(item => escapeHtml(item))
    .join(', ');
}

function buildSkills(categories, partial) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  if (!partial) {
    const kept = categories.filter(c => hasRequiredFields(c, 'skills', 'html'));
    if (kept.length === 0) return '';
    const items = kept.map(c => {
      const cat = c.category
        ? `<span class="skill-category">${escapeHtml(c.category)}:</span> `
        : '';
      return `    <div class="skill-item">${cat}${escapeHtml(joinItems(c.items))}</div>`;
    }).join('\n');
    return `<div class="skills-grid">\n${items}\n  </div>`;
  }

  const { entryTemplate, blocks } = partial;
  const kept = categories.filter(c => hasRequiredFields(c, 'skills', 'html'));
  if (kept.length === 0) return '';
  const items = kept.map(c => {
    const blockValues = new Map([
      ['CATEGORY_BLOCK', { value: escapeHtml(c.category || ''), present: Boolean(c.category) }],
    ]);
    return fillEntry(entryTemplate, blocks, {
      CATEGORY:    escapeHtml(c.category || ''),
      ITEMS_TEXT:  escapeHtml(joinItems(c.items)),
    }, blockValues);
  }).join('\n');
  return `<div class="skills-grid">\n${items}\n  </div>`;
}

function buildContactRow(candidate) {
  const c = candidate || {};
  const items = [];
  if (c.phone) {
    const tel = sanitizeUrl('tel:' + String(c.phone).replace(/\s+/g, ''));
    items.push(`<a href="${tel}">${escapeHtml(c.phone)}</a>`);
  }
  if (c.email) {
    items.push(`<a href="${sanitizeUrl('mailto:' + c.email)}">${escapeHtml(c.email)}</a>`);
  }
  if (c.linkedin && c.linkedin.url) {
    items.push(`<a href="${sanitizeUrl(c.linkedin.url)}">${escapeHtml(c.linkedin.display || c.linkedin.url)}</a>`);
  }
  if (c.github && c.github.url) {
    const githubHref = sanitizeUrl(c.github.url);
    if (githubHref) {
      items.push(`<a href="${githubHref}">${escapeHtml(c.github.display || c.github.url)}</a>`);
    }
  }
  if (c.portfolio && c.portfolio.url) {
    items.push(`<a href="${sanitizeUrl(c.portfolio.url)}">${escapeHtml(c.portfolio.display || c.portfolio.url)}</a>`);
  }
  if (c.location) {
    items.push(`<span>${escapeHtml(c.location)}</span>`);
  }
  return `<div class="contact-row">\n      ${items.join('\n      ')}\n    </div>`;
}

function buildPhoto(candidate, name) {
  const photo = candidate && candidate.photo;
  if (!photo) return '';
  const style = PHOTO_STYLES.has(candidate.photo_style) ? candidate.photo_style : 'rounded';
  return `<img class="cv-photo cv-photo--${style}" src="${sanitizeImageSrc(photo)}" alt="${escapeHtml(name || '')}">`;
}

function buildTitle(candidate) {
  const title = candidate && candidate.title != null ? String(candidate.title).trim() : '';
  return title ? `<div class="header-title">${escapeHtml(title)}</div>` : '';
}

function renderReport(payload, partials) {
  const sectionTitles = { ...DEFAULT_SECTION_TITLES, ...(payload.sections || {}) };
  const candidate = payload.candidate || {};
  const pageWidth = PAGE_WIDTHS[resolvePageFormat(payload.page_format, { profilePath: PROFILE_PATH })];

  const substitutions = {
    LANG: escapeHtml(payload.lang || 'en'),
    PAGE_WIDTH: pageWidth,
    NAME: escapeHtml(candidate.name || ''),
    SECTION_SUMMARY: escapeHtml(sectionTitles.summary),
    SUMMARY_TEXT: escapeHtml(payload.summary || ''),
    SECTION_COMPETENCIES: escapeHtml(sectionTitles.competencies),
    COMPETENCIES: buildCompetencies(payload.competencies, partials.get('competencies')),
    SECTION_EXPERIENCE: escapeHtml(sectionTitles.experience),
    EXPERIENCE: buildExperience(payload.experience, partials.get('experience')),
    SECTION_PROJECTS: escapeHtml(sectionTitles.projects),
    PROJECTS: buildProjects(payload.projects, partials.get('projects')),
    SECTION_EDUCATION: escapeHtml(sectionTitles.education),
    EDUCATION: buildEducation(payload.education, partials.get('education')),
    SECTION_CERTIFICATIONS: escapeHtml(sectionTitles.certifications),
    CERTIFICATIONS: buildCertifications(payload.certifications, partials.get('certifications')),
    SECTION_AWARDS: escapeHtml(sectionTitles.awards),
    AWARDS: buildAwards(payload.awards, partials.get('awards')),
    SECTION_INTERESTS: escapeHtml(sectionTitles.interests),
    INTERESTS: buildInterests(payload.interests),
    SECTION_SKILLS: escapeHtml(sectionTitles.skills),
    SKILLS: buildSkills(payload.skills, partials.get('skills')),
    CONSENT: escapeHtml((payload.consent || '').trim()),
  };
  return { substitutions, candidate };
}

function renderHtml(template, payload, templatePath) {
  const partials = templatePath ? loadSectionPartials(templatePath) : new Map();

  const { substitutions, candidate } = renderReport(payload, partials);

  let html = template.replace(CONTACT_ROW_RE, () => buildContactRow(candidate));
  html = html.replace(/\{\{PHOTO\}\}/g, () => buildPhoto(candidate, candidate.name));
  const titleBlock = buildTitle(candidate);
  html = html.replace(/\n([ \t]*)\{\{TITLE_BLOCK\}\}/g, (_, indent) => (titleBlock ? `\n${indent}${titleBlock}` : ''));

  html = stripEmptySections(html, payload, 'html');

  for (const [key, value] of Object.entries(substitutions)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  const unresolved = html.match(PLACEHOLDER_RE);
  if (unresolved) {
    throw new Error(`Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  }
  return html;
}

function countBullets(payload) {
  const ex = Array.isArray(payload.experience)
    ? payload.experience.flatMap(e => (Array.isArray(e?.bullets) ? e.bullets : []))
    : [];
  return ex.length;
}

async function writeAndReport(html, absOutput, payload, extra = {}) {
  const { warnings = [], ...rest } = extra;
  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  await writeFile(absOutput, html, 'utf-8');

  const fileInfo = await stat(absOutput);
  const report = {
    ...rest,
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat((fileInfo.size / 1024).toFixed(1)),
    counts: {
      competencies: (payload.competencies || []).length,
      experienceEntries: (payload.experience || []).length,
      projectEntries: (payload.projects || []).length,
      educationEntries: (payload.education || []).length,
      certificationEntries: (payload.certifications || []).length,
      awardEntries: (payload.awards || []).length,
      skillCategories: (payload.skills || []).length,
      totalBullets: countBullets(payload),
    },
    warnings,
    valid: true,
  };
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.error('Usage:');
    console.error('  node build-cv-html.mjs <input.json> <output.html> [template.html]');
    console.error('  node build-cv-html.mjs --preview <input.json> [template.html]');
    console.error('  node build-cv-html.mjs --test');
    console.error('');
    console.error('  [template.html] defaults to templates/cv-template.html. Pass the path');
    console.error('  printed by `node cv-templates.mjs resolve cv` to use a selected template.');
    console.error('');
    console.error('  Section partials (#2183):');
    console.error('  If a sections/ directory exists alongside the template file,');
    console.error('  the builder loads per-section HTML partial files from it');
    console.error('  (e.g. sections/experience.html). Partials control the DOM');
    console.error('  structure, tag names, and class names for each section.');
    console.error('  When no partial file is found the built-in builder is used —');
    console.error('  unless the template manifest declares the section (#3852):');
    console.error('  `sections: all` or `sections: experience, education` in the');
    console.error('  <!-- career-ops-template --> block makes a missing or malformed');
    console.error('  partial fail the build instead of falling back.');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  if (args.includes('--test')) {
    await runSelfTest();
    return;
  }

  const preview = args[0] === '--preview';
  const [inputPath, outputPath, templateArg] = preview
    ? [args[1], resolve(DATA_ROOT, 'output', 'cv-preview.html'), args[2]]
    : args;
  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-html.mjs <input.json> <output.html> [template.html]');
    process.exit(1);
  }

  const absInput = resolve(inputPath);
  const absOutput = resolve(outputPath);
  const templatePath = templateArg ? resolve(templateArg) : TEMPLATE_PATH;

  if (!existsSync(absInput)) {
    console.error(`Input file not found: ${absInput}`);
    process.exit(1);
  }
  if (!existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(absInput, 'utf-8'));
    payload.candidate = await prepareCandidatePhoto(payload.candidate);
  } catch (err) {
    console.error(`Failed to prepare CV input: ${err.message}`);
    process.exit(1);
  }

  const { errors, warnings } = validatePayload(payload, 'html');
  if (errors.length) {
    console.error('Invalid CV payload:');
    for (const message of errors) console.error(`  - ${message}`);
    console.error(JSON.stringify({ valid: false, errors, warnings }, null, 2));
    process.exit(1);
  }
  for (const message of warnings) console.error(`Warning: ${message}`);

  const template = await readFile(templatePath, 'utf-8');

  let html;
  try {
    html = renderHtml(template, payload, templatePath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  await writeAndReport(html, absOutput, payload, preview ? { status: 'preview-ready', warnings } : { warnings });
  process.exit(0);
}

async function runSelfTest() {
  const sample = {
    lang: 'en',
    page_format: 'letter',
    candidate: {
      name: 'Test Candidate',
      phone: '+1 234 567 8900',
      email: 'test@example.com',
      linkedin: { url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' },
      github: { url: 'https://github.com/test', display: 'github.com/test' },
      portfolio: { url: 'https://test.example.com', display: 'test.example.com' },
      location: 'City, State',
    },
    summary: 'Backend engineer with a focus on R&D and cost-efficient "north star" systems.',
    competencies: ['Cloud Architecture', 'RESTful API Design', 'Kubernetes & Docker'],
    experience: [{
      company: 'Test Corp',
      role: 'Test Engineer',
      location: 'Remote',
      context: 'Seed-stage startup; joined as employee #7.',
      dates: 'June 2024 - Present',
      bullets: [
        'Built automated testing pipelines with CI/CD integration',
        'Reduced regression test time by 60% through parallel execution',
      ],
    }],
    projects: [{
      name: 'Test Project',
      badge: 'Open Source',
      tech: 'Python, FastAPI, Docker',
      description: 'Built a REST API with automated test coverage exceeding 90%.',
    }],
    education: [{
      title: 'Bachelor of Science in Computer Science',
      org: 'Test University',
      location: 'City, State',
      year: '2024',
      description: 'Coursework: Data Structures, Algorithms, Machine Learning.',
    }],
    certifications: [{ title: 'Certified Kubernetes Administrator', org: 'CNCF', year: '2025' }],
    awards: [{ title: 'Gold Medal, International Olympiad in Informatics', org: 'IOI', year: '2023' }],
    skills: [
      { category: 'Languages', items: 'Python, JavaScript, TypeScript' },
      { category: 'Frameworks', items: ['FastAPI', 'React', 'PyTorch'] },
    ],
    interests: ['Reading sci-fi & fantasy', 'Hiking', 'Chess'],
  };

  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Self-test failed: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  const template = await readFile(TEMPLATE_PATH, 'utf-8');

  let html;
  try {
    html = renderHtml(template, sample, TEMPLATE_PATH);
  } catch (err) {
    console.error(`Self-test failed: ${err.message}`);
    process.exit(1);
  }

  if (!html.includes('Kubernetes &amp; Docker')) {
    console.error('Self-test failed: HTML escaping did not apply to competency text');
    process.exit(1);
  }
  if (/Kubernetes & Docker/.test(html)) {
    console.error('Self-test failed: found an unescaped ampersand in output');
    process.exit(1);
  }

  if (!html.includes('Reading sci-fi &amp; fantasy, hiking, chess')) {
    console.error('Self-test failed: Interests did not render as an escaped, comma-joined, sentence-cased line');
    process.exit(1);
  }

  if (!html.includes('href="https://github.com/test"')) {
    console.error('Self-test failed: github contact link missing from output');
    process.exit(1);
  }

  const { github, ...candidateWithoutGithub } = sample.candidate;
  const htmlWithoutGithub = renderHtml(template, { ...sample, candidate: candidateWithoutGithub });
  const countSeparators = (h) => {
    const row = h.match(/<div class="contact-row">([\s\S]*?)<\/div>/);
    return row ? (row[1].match(/<\/a>|<\/span>/g) || []).length : 0;
  };
  if (htmlWithoutGithub.includes('github.com/test')) {
    console.error('Self-test failed: github contact link rendered when candidate.github is absent');
    process.exit(1);
  }
  if (countSeparators(htmlWithoutGithub) !== countSeparators(html) - 1) {
    console.error('Self-test failed: omitting candidate.github left a dangling separator in the contact row');
    process.exit(1);
  }

  const htmlWithRejectedGithub = renderHtml(template, {
    ...sample,
    candidate: { ...sample.candidate, github: { url: 'javascript:alert(1)', display: 'github.com/test' } },
  });
  if (htmlWithRejectedGithub.includes('href=""') || htmlWithRejectedGithub.includes('github.com/test')) {
    console.error('Self-test failed: rejected github URL still rendered a contact item');
    process.exit(1);
  }
  if (countSeparators(htmlWithRejectedGithub) !== countSeparators(html) - 1) {
    console.error('Self-test failed: rejected github URL left a dangling separator in the contact row');
    process.exit(1);
  }

  if (!html.includes('class="job"')) {
    console.error('Self-test failed: experience section is missing .job class — partial may be broken');
    process.exit(1);
  }
  if (!html.includes('class="competency-tag"')) {
    console.error('Self-test failed: competencies section is missing .competency-tag class');
    process.exit(1);
  }
  if (!html.includes('class="project"')) {
    console.error('Self-test failed: projects section is missing .project class');
    process.exit(1);
  }
  if (!html.includes('class="edu-item"')) {
    console.error('Self-test failed: education section is missing .edu-item class');
    process.exit(1);
  }
  if (!html.includes('class="cert-item"')) {
    console.error('Self-test failed: certifications section is missing .cert-item class');
    process.exit(1);
  }
  if (!html.includes('class="award-item"')) {
    console.error('Self-test failed: awards section is missing .award-item class');
    process.exit(1);
  }
  if (!html.includes('class="skills-grid"')) {
    console.error('Self-test failed: skills section is missing .skills-grid wrapper');
    process.exit(1);
  }

  if (!html.includes('Test Corp') || !html.includes('Test Engineer')) {
    console.error('Self-test failed: experience entry fields not found in output');
    process.exit(1);
  }

  if (!html.includes('class="job-location"')) {
    console.error('Self-test failed: job-location block not rendered when location is present');
    process.exit(1);
  }
  if (!html.includes('class="job-context"') || !html.includes('Seed-stage startup; joined as employee #7.')) {
    console.error('Self-test failed: job-context block not rendered when context is present');
    process.exit(1);
  }
  const contextDiv = '<div class="job-context">Seed-stage startup; joined as employee #7.</div>';
  for (const [path, out] of [['partial', html], ['built-in', buildExperience(sample.experience)]]) {
    const [role, context, location] = ['class="job-role"', contextDiv, 'class="job-location"'].map(s => out.indexOf(s));
    if (role === -1 || !(role < context && context < location)) {
      console.error(`Self-test failed: ${path} builder did not render job-context between the role and the location`);
      process.exit(1);
    }
  }
  if (!html.includes('class="edu-location"')) {
    console.error('Self-test failed: edu-location block not rendered when education location is present');
    process.exit(1);
  }

  const multiBulletHtml = renderHtml(template, {
    ...sample,
    projects: [{ name: 'Multi', bullets: ['First bullet', 'Second bullet', 'Third bullet'] }],
  }, TEMPLATE_PATH);
  let literalHtml;
  try {
    literalHtml = renderHtml(template, {
      ...sample,
      projects: [{ name: 'Literal', bullets: ['Uses {{DESC}} syntax', 'Also {{DESC_BLOCK}} here'] }],
    }, TEMPLATE_PATH);
  } catch (err) {
    console.error(`Self-test failed: literal placeholder text in a project bullet: ${err.message}`);
    process.exit(1);
  }
  if (!literalHtml.includes('&#123;&#123;DESC&#125;&#125;') || !literalHtml.includes('&#123;&#123;DESC_BLOCK&#125;&#125;')) {
    console.error('Self-test failed: literal placeholders in project bullets were not preserved');
    process.exit(1);
  }
  if ((multiBulletHtml.match(/class="project-desc"/g) || []).length !== 3) {
    console.error('Self-test failed: project bullets did not render one block per bullet');
    process.exit(1);
  }
  if ((html.match(/class="project-desc"/g) || []).length !== 1) {
    console.error('Self-test failed: project description should render as a single block');
    process.exit(1);
  }

  const noLocSample = {
    ...sample,
    experience: [{ company: 'Acme', role: 'Engineer', dates: '2023', bullets: [] }],
    education: [{ title: 'BSc', org: 'Test University', year: '2024' }],
    projects: [],
  };
  let noLocHtml;
  try {
    noLocHtml = renderHtml(template, noLocSample, TEMPLATE_PATH);
  } catch (err) {
    console.error(`Self-test failed (no-location variant): ${err.message}`);
    process.exit(1);
  }
  if (noLocHtml.includes('class="job-location"')) {
    console.error('Self-test failed: job-location block rendered when location is absent');
    process.exit(1);
  }
  if (noLocHtml.includes('class="job-context"') || buildExperience(noLocSample.experience).includes('class="job-context"')) {
    console.error('Self-test failed: job-context block rendered when context is absent');
    process.exit(1);
  }
  if (noLocHtml.includes('class="edu-location"')) {
    console.error('Self-test failed: edu-location block rendered when education location is absent');
    process.exit(1);
  }

  const noOrgCert = {
    ...sample,
    certifications: [{ title: 'No Org Cert' }, { title: 'With Org', org: 'CNCF', year: '2025' }],
    projects: [],
  };
  let certHtml;
  try {
    certHtml = renderHtml(template, noOrgCert, TEMPLATE_PATH);
  } catch (err) {
    console.error(`Self-test failed (cert variant): ${err.message}`);
    process.exit(1);
  }
  const orgCount = (certHtml.match(/class="cert-org"/g) || []).length;
  if (orgCount !== 2) {
    console.error('Self-test failed: cert-org empty-block not emitted for table alignment');
    process.exit(1);
  }

  const wrongKeyEducation = [{
    institution: 'Test University',
    degree: 'Bachelor of Science in Computer Science',
    dates: '2024',
    detail: 'Coursework: Data Structures.',
  }];
  const wrongKeys = validatePayload({ ...sample, education: wrongKeyEducation }, 'html');
  if (wrongKeys.errors.length === 0) {
    console.error('Self-test failed: education entry with wrong key names was accepted');
    process.exit(1);
  }
  if (!wrongKeys.errors[0].includes('education[0]')
      || !wrongKeys.errors[0].includes('title')
      || !wrongKeys.errors[0].includes('institution')) {
    console.error(`Self-test failed: unhelpful error for wrong education keys: ${wrongKeys.errors[0]}`);
    process.exit(1);
  }
  if (buildEducation(wrongKeyEducation) !== '') {
    console.error('Self-test failed: buildEducation emitted a block for an entry with no title');
    process.exit(1);
  }

  const clean = validatePayload(sample, 'html');
  if (clean.errors.length || clean.warnings.length) {
    console.error(`Self-test failed: valid sample payload reported ${JSON.stringify(clean)}`);
    process.exit(1);
  }

  const extraKey = validatePayload({
    ...sample,
    certifications: [{ title: 'CKA', org: 'CNCF', year: '2025', credential_id: 'X-1' }],
  }, 'html');
  if (extraKey.errors.length !== 0 || extraKey.warnings.length !== 1
      || !extraKey.warnings[0].includes('credential_id')) {
    console.error(`Self-test failed: unrecognised optional key not warned about: ${JSON.stringify(extraKey)}`);
    process.exit(1);
  }

  for (const badRoot of [[], null, 'x', 42]) {
    if (validatePayload(badRoot, 'html').errors.length === 0) {
      console.error(`Self-test failed: payload root ${JSON.stringify(badRoot)} was accepted`);
      process.exit(1);
    }
  }

  for (const items of ['Python, JavaScript', ['FastAPI', 'React']]) {
    const ok = validatePayload({ ...sample, skills: [{ category: 'L', items }] }, 'html');
    if (ok.errors.length || ok.warnings.length) {
      console.error(`Self-test failed: valid skills items ${JSON.stringify(items)} rejected: ${JSON.stringify(ok)}`);
      process.exit(1);
    }
  }
  for (const items of [[], ['  '], '', {}, null, undefined]) {
    if (validatePayload({ ...sample, skills: [{ category: 'L', items }] }, 'html').errors.length === 0) {
      console.error(`Self-test failed: unrenderable skills items ${JSON.stringify(items)} accepted`);
      process.exit(1);
    }
  }
  if (validatePayload({ ...sample, skills: [{ label: 'Languages', values: ['JS'] }] }, 'html').errors.length === 0) {
    console.error('Self-test failed: skills entry with wrong key names was accepted');
    process.exit(1);
  }
  if (buildSkills([{ label: 'Languages', values: ['JS'] }]) !== '') {
    console.error('Self-test failed: buildSkills emitted markup for an unrenderable entry');
    process.exit(1);
  }

  const typoSection = validatePayload({ ...sample, educations: sample.education }, 'html');
  if (!typoSection.warnings.some(w => w.includes('educations') && w.includes('education'))) {
    console.error(`Self-test failed: mistyped section name not reported: ${JSON.stringify(typoSection.warnings)}`);
    process.exit(1);
  }
  if (typoSection.errors.length !== 0) {
    console.error('Self-test failed: an unknown root key must warn, not block the build');
    process.exit(1);
  }
  for (const empty of [{ educations: [] }, { educations: '' }]) {
    if (validatePayload({ ...sample, ...empty }, 'html').warnings.some(w => w.includes('educations'))) {
      console.error(`Self-test failed: empty unknown key ${JSON.stringify(empty)} warned`);
      process.exit(1);
    }
  }
  const cleanRoots = validatePayload(sample, 'html');
  if (cleanRoots.warnings.length !== 0) {
    console.error(`Self-test failed: valid sample warned about its own root keys: ${JSON.stringify(cleanRoots.warnings)}`);
    process.exit(1);
  }

  if (validatePayload({ ...sample, skills: [{ category: 'L', items: ['JS', {}] }] }, 'html').errors.length === 0) {
    console.error('Self-test failed: skills items array with a non-text element was accepted');
    process.exit(1);
  }

  const objectSection = validatePayload({ ...sample, educations: { title: 'BSc' } }, 'html');
  if (!objectSection.warnings.some(w => w.includes('educations'))) {
    console.error('Self-test failed: object-valued unknown root key was not reported');
    process.exit(1);
  }
  if (validatePayload({ ...sample, educations: {} }, 'html').warnings.some(w => w.includes('educations'))) {
    console.error('Self-test failed: an empty object unknown key warned');
    process.exit(1);
  }

  for (const scalar of [2026, 0, true, false]) {
    if (!validatePayload({ ...sample, educations: scalar }, 'html').warnings.some(w => w.includes('educations'))) {
      console.error(`Self-test failed: scalar unknown root key ${JSON.stringify(scalar)} was not reported`);
      process.exit(1);
    }
  }
  for (const empty of [null, undefined, '', '   ', [], {}]) {
    if (validatePayload({ ...sample, educations: empty }, 'html').warnings.some(w => w.includes('educations'))) {
      console.error(`Self-test failed: empty unknown root key ${JSON.stringify(empty)} warned`);
      process.exit(1);
    }
  }

  for (const [section, bad] of [
    ['experience', [{ employer: 'Acme', title: 'Engineer' }]],
    ['projects', [{ project_name: 'Thing' }]],
    ['education', [{ org: 'Test University', year: '2024' }]],
    ['certifications', [{ name: 'CKA' }]],
    ['awards', [{ award: 'Gold Medal' }]],
  ]) {
    const result = validatePayload({ ...sample, [section]: bad }, 'html');
    if (result.errors.length === 0) {
      console.error(`Self-test failed: ${section} entry with wrong key names was accepted`);
      process.exit(1);
    }
  }

  if (validatePayload({ ...sample, education: [{ title: '   ', org: 'X' }] }, 'html').errors.length === 0) {
    console.error('Self-test failed: education entry with a blank title was accepted');
    process.exit(1);
  }

  for (const badTitle of [{}, [], 0, true, null]) {
    if (validatePayload({ ...sample, education: [{ title: badTitle, org: 'X' }] }, 'html').errors.length === 0) {
      console.error(`Self-test failed: education title ${JSON.stringify(badTitle)} was accepted as text`);
      process.exit(1);
    }
  }

  const absOutput = resolve(join(tmpdir(), 'build-cv-html-test.html'));
  await writeAndReport(html, absOutput, sample, { status: 'self-test-passed' });

  await import('fs/promises').then(fs => fs.rm(absOutput).catch(() => {}));
  process.exit(0);
}

main();
