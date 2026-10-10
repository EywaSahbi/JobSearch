#!/usr/bin/env node

import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { escapeLatex, sanitizeUrl } from './lib/latex-escape.mjs';
import { resolveTemplate } from './cv-templates.mjs';
import { stripEmptySections } from './cv-sections-core.mjs';
import { hasRequiredFields, hasText, validatePayload } from './lib/cv-payload-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'cv-template.tex');
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

const MARKDOWN_BOLD_RE = /\*\*([^*]+?)\*\*/g;

function escapeLatexBullet(text) {
  return escapeLatex(text).replace(MARKDOWN_BOLD_RE, (_, inner) => `\\textbf{${inner}}`);
}

function buildEducation(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!hasRequiredFields(e, 'education', 'tex')) continue;
    let block = `    \\resumeSubheading\n      {${escapeLatex(e.institution)}}{${escapeLatex(e.location)}}\n      {${escapeLatex(e.degree)}}{${escapeLatex(e.dates)}}`;
    if (Array.isArray(e.coursework) && e.coursework.length > 0) {
      const courses = e.coursework.map(c => escapeLatexBullet(c)).join(', ');
      block += `\n        \\resumeItemListStart\n            \\resumeItem{\\textbf{Coursework:} ${courses}}\n        \\resumeItemListEnd`;
    }
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

function buildExperience(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!hasRequiredFields(e, 'experience', 'tex')) continue;
    const bullets = Array.isArray(e.bullets) ? e.bullets.map(b => `            \\resumeItem{${escapeLatexBullet(b)}}`).join('\n') : '';
    blocks.push(`    \\resumeSubheading\n      {${escapeLatex(e.company)}}{${escapeLatex(e.dates)}}\n      {${escapeLatex(e.role)}}{${escapeLatex(e.location)}}\n      \\resumeItemListStart\n${bullets}\n      \\resumeItemListEnd`);
  }
  return blocks.join('\n\n');
}

function buildProjects(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!hasRequiredFields(e, 'projects', 'tex')) continue;
    const context = e.context ? ` \\emph{$|$ ${escapeLatex(e.context)}}` : '';
    const url = sanitizeUrl(e.url);
    const nameFormatted = url
      ? `\\href{${escapeLatex(url, 'url')}}{\\textbf{${escapeLatex(e.name)}}}`
      : `\\textbf{${escapeLatex(e.name)}}`;
    const bullets = Array.isArray(e.bullets) ? e.bullets.map(b => `            \\resumeItem{${escapeLatexBullet(b)}}`).join('\n') : '';
    blocks.push(`    \\resumeProjectHeading\n      {${nameFormatted}${context}}{${escapeLatex(e.dates || '')}}\n      \\resumeItemListStart\n${bullets}\n      \\resumeItemListEnd`);
  }
  return blocks.join('\n\n');
}

function buildAwards(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!hasRequiredFields(e, 'awards', 'tex')) continue;
    const org = e.org ? ` \\emph{$|$ ${escapeLatex(e.org)}}` : '';
    blocks.push(`    \\resumeProjectHeading\n      {\\textbf{${escapeLatex(e.title)}}${org}}{${escapeLatex(e.year)}}`);
  }
  return blocks.join('\n\n');
}

function buildSkills(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  return categories.map(c => {
    if (!hasRequiredFields(c, 'skills', 'tex')) return '';
    const items = Array.isArray(c.items) ? c.items.join(', ') : (c.items || '');
    const prefix = hasText(c.category) ? `\\textbf{${escapeLatex(c.category)}}{: }` : '';
    return `        ${prefix}{${escapeLatex(items)}} \\\\`;
  }).filter(Boolean).join('\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.error('Usage:');
    console.error('  node build-cv-latex.mjs <input.json> <output.tex>');
    console.error('  node build-cv-latex.mjs --test');
    process.exit(1);
  }

  if (args.includes('--test')) {
    await runSelfTest();
    return;
  }

  const [inputPath, outputPath] = args;

  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-latex.mjs <input.json> <output.tex>');
    process.exit(1);
  }

  const absInput = resolve(inputPath);
  const absOutput = resolve(outputPath);
  const outDir = dirname(absOutput);

  if (!existsSync(absInput)) {
    console.error(`Input file not found: ${absInput}`);
    process.exit(1);
  }

  let payload;
  try {
    const raw = await readFile(absInput, 'utf-8');
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse input JSON: ${err.message}`);
    process.exit(1);
  }

  const { errors, warnings } = validatePayload(payload, 'tex');
  if (errors.length) {
    console.error('Invalid CV payload:');
    for (const message of errors) console.error(`  - ${message}`);
    console.error(JSON.stringify({ valid: false, errors, warnings }, null, 2));
    process.exit(1);
  }
  for (const message of warnings) console.error(`Warning: ${message}`);

  const texName = (process.argv.find((a) => a.startsWith('--template=')) || '').split('=')[1];
  let TEMPLATE_PATH_RESOLVED;
  try {
    TEMPLATE_PATH_RESOLVED = resolveTemplate('cv', texName, { format: 'tex', fallback: true });
  } catch {
    TEMPLATE_PATH_RESOLVED = TEMPLATE_PATH;
  }

  if (!existsSync(TEMPLATE_PATH_RESOLVED)) {
    console.error(`Template not found: ${TEMPLATE_PATH_RESOLVED}`);
    process.exit(1);
  }

  let template = await readFile(TEMPLATE_PATH_RESOLVED, 'utf-8');

  template = stripEmptySections(template, payload, 'tex');

  const emailUrl = sanitizeUrl(payload.email?.url || '');
  const emailDisplay = payload.email?.display || emailUrl;
  const linkedinUrl = sanitizeUrl(payload.linkedin?.url || '');
  const linkedinDisplay = payload.linkedin?.display || '';
  const githubUrl = sanitizeUrl(payload.github?.url || '');
  const githubDisplay = payload.github?.display || '';

  const substitutions = {
    NAME: escapeLatex(payload.name || ''),
    CONTACT_LINE: escapeLatex(payload.contact_line || ''),
    EMAIL_URL: emailUrl,
    EMAIL_DISPLAY: escapeLatex(emailDisplay),
    LINKEDIN_URL: linkedinUrl,
    LINKEDIN_DISPLAY: escapeLatex(linkedinDisplay),
    GITHUB_URL: githubUrl,
    GITHUB_DISPLAY: escapeLatex(githubDisplay),
    EDUCATION: buildEducation(payload.education),
    EXPERIENCE: buildExperience(payload.experience),
    PROJECTS: buildProjects(payload.projects),
    AWARDS: buildAwards(payload.awards),
    SKILLS: buildSkills(payload.skills),
  };

  for (const [key, value] of Object.entries(substitutions)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  const unresolved = template.match(PLACEHOLDER_RE);
  if (unresolved) {
    console.error(`Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
    process.exit(1);
  }

  if (!existsSync(outDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(outDir, { recursive: true });
  }

  await writeFile(absOutput, template, 'utf-8');

  const fileInfo = await stat(absOutput);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat(sizeKB),
    counts: {
      educationEntries: (payload.education || []).length,
      experienceEntries: (payload.experience || []).length,
      projectEntries: (payload.projects || []).length,
      awardEntries: (payload.awards || []).length,
      skillCategories: (payload.skills || []).length,
      totalBullets: (() => {
        const ex = Array.isArray(payload.experience) ? payload.experience.flatMap(e => Array.isArray(e?.bullets) ? e.bullets : []) : [];
        const pr = Array.isArray(payload.projects) ? payload.projects.flatMap(p => Array.isArray(p?.bullets) ? p.bullets : []) : [];
        return ex.length + pr.length;
      })(),
    },
    warnings,
    valid: true,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

async function runSelfTest() {
  const sample = {
    name: 'Test Candidate',
    contact_line: 'City, State | +1 234 567 8900',
    email: { url: 'test@example.com', display: 'test@example.com' },
    linkedin: { url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' },
    github: { url: 'https://github.com/test', display: 'github.com/test' },
    education: [{
      institution: 'Test University',
      location: 'City, State',
      degree: 'Bachelor of Science in Testing',
      dates: '2020 - 2024',
      coursework: ['Data Structures', 'Algorithms', 'Machine Learning'],
    }],
    experience: [{
      company: 'Test Corp',
      role: 'Test Engineer',
      location: 'Remote',
      dates: 'June 2024 - Present',
      bullets: [
        'Built automated testing pipelines with CI/CD integration',
        'Reduced regression test time by 60% through parallel execution',
      ],
    }],
    projects: [{
      name: 'Test Project',
      context: 'Python, FastAPI, Docker',
      dates: '2024',
      bullets: [
        'Built a REST API with automated test coverage exceeding 90%',
      ],
    }],
    awards: [
      { title: 'Gold Medal, International Olympiad in Informatics', org: 'IOI', year: '2023' },
      { title: "Dean's List", org: 'Test University', year: '2022' },
    ],
    skills: [
      { category: 'Languages', items: 'Python, JavaScript, TypeScript' },
      { category: 'Frameworks', items: 'FastAPI, React, PyTorch' },
    ],
  };

  const htmlStyleEducation = [{
    title: 'Bachelor of Science in Computer Science',
    org: 'Test University',
    year: '2024',
    description: 'Coursework: Data Structures.',
  }];
  const wrongKeys = validatePayload({ ...sample, education: htmlStyleEducation }, 'tex');
  if (wrongKeys.errors.length === 0) {
    console.error('Self-test failed: education entry using the HTML key names was accepted');
    process.exit(1);
  }
  if (!wrongKeys.errors[0].includes('education[0]')
      || !wrongKeys.errors[0].includes('institution')
      || !wrongKeys.errors[0].includes('title')) {
    console.error(`Self-test failed: unhelpful error for wrong education keys: ${wrongKeys.errors[0]}`);
    process.exit(1);
  }
  if (buildEducation(htmlStyleEducation) !== '') {
    console.error('Self-test failed: buildEducation emitted a block for an entry with no institution/degree');
    process.exit(1);
  }

  const clean = validatePayload(sample, 'tex');
  if (clean.errors.length || clean.warnings.length) {
    console.error(`Self-test failed: valid sample payload reported ${JSON.stringify(clean)}`);
    process.exit(1);
  }

  for (const badRoot of [[], null, 'x']) {
    if (validatePayload(badRoot, 'tex').errors.length === 0) {
      console.error(`Self-test failed: payload root ${JSON.stringify(badRoot)} was accepted`);
      process.exit(1);
    }
  }

  for (const items of ['Python, JavaScript', ['FastAPI', 'React']]) {
    const ok = validatePayload({ ...sample, skills: [{ category: 'L', items }] }, 'tex');
    if (ok.errors.length) {
      console.error(`Self-test failed: valid skills items ${JSON.stringify(items)} rejected`);
      process.exit(1);
    }
  }
  for (const items of [[], ['  '], '', {}, null]) {
    if (validatePayload({ ...sample, skills: [{ category: 'L', items }] }, 'tex').errors.length === 0) {
      console.error(`Self-test failed: unrenderable skills items ${JSON.stringify(items)} accepted`);
      process.exit(1);
    }
  }
  if (buildSkills([{ label: 'Languages', values: ['JS'] }]) !== '') {
    console.error('Self-test failed: buildSkills emitted markup for an unrenderable entry');
    process.exit(1);
  }

  const typoSection = validatePayload({ ...sample, educations: sample.education }, 'tex');
  if (!typoSection.warnings.some(w => w.includes('educations')) || typoSection.errors.length !== 0) {
    console.error(`Self-test failed: mistyped section name not reported: ${JSON.stringify(typoSection)}`);
    process.exit(1);
  }
  if (validatePayload(sample, 'tex').warnings.length !== 0) {
    console.error('Self-test failed: valid sample warned about its own root keys');
    process.exit(1);
  }

  if (validatePayload({ ...sample, skills: [{ category: 'L', items: ['JS', {}] }] }, 'tex').errors.length === 0) {
    console.error('Self-test failed: skills items array with a non-text element was accepted');
    process.exit(1);
  }

  const noCategory = buildSkills([{ items: 'Docker, K8s' }]);
  if (noCategory.includes('textbf{}') || noCategory.includes('{: }')) {
    console.error(`Self-test failed: category-less skills line renders an empty prefix: ${noCategory}`);
    process.exit(1);
  }
  if (!noCategory.includes('Docker, K8s')) {
    console.error('Self-test failed: category-less skills line lost its items');
    process.exit(1);
  }

  const certWarnings = validatePayload({ ...sample, certifications: [{ title: 'CKA' }] }, 'tex').warnings
    .filter(w => w.startsWith('certifications:'));
  if (certWarnings.length !== 1) {
    console.error(`Self-test failed: expected exactly 1 certifications warning, got ${certWarnings.length}: ${JSON.stringify(certWarnings)}`);
    process.exit(1);
  }
  if (!certWarnings[0].includes('has no certifications section')) {
    console.error(`Self-test failed: the wrong certifications warning survived: ${certWarnings[0]}`);
    process.exit(1);
  }
  if (!validatePayload({ ...sample, educations: { institution: 'U' } }, 'tex').warnings.some(w => w.includes('educations'))) {
    console.error('Self-test failed: object-valued unknown root key was not reported');
    process.exit(1);
  }

  for (const scalar of [2026, 0, true, false, 'hi']) {
    if (!validatePayload({ ...sample, summary: scalar }, 'tex').warnings.some(w => w.startsWith('summary:'))) {
      console.error(`Self-test failed: scalar unsupported section ${JSON.stringify(scalar)} was not reported`);
      process.exit(1);
    }
  }
  for (const empty of [null, undefined, '', '   ']) {
    if (validatePayload({ ...sample, summary: empty }, 'tex').warnings.some(w => w.startsWith('summary:'))) {
      console.error(`Self-test failed: empty unsupported section ${JSON.stringify(empty)} warned`);
      process.exit(1);
    }
  }

  for (const [section, bad] of [
    ['education', [{ school: 'Test University', qualification: 'BSc' }]],
    ['experience', [{ employer: 'Acme', title: 'Engineer' }]],
    ['projects', [{ project_name: 'Thing' }]],
    ['awards', [{ award: 'Gold Medal' }]],
  ]) {
    if (validatePayload({ ...sample, [section]: bad }, 'tex').errors.length === 0) {
      console.error(`Self-test failed: ${section} entry with wrong key names was accepted`);
      process.exit(1);
    }
  }

  for (const badInstitution of [{}, [], 0, true, null]) {
    const bad = [{ institution: badInstitution, degree: 'BSc' }];
    if (validatePayload({ ...sample, education: bad }, 'tex').errors.length === 0) {
      console.error(`Self-test failed: education institution ${JSON.stringify(badInstitution)} was accepted as text`);
      process.exit(1);
    }
  }

  const certWarn = validatePayload({ ...sample, certifications: [{ title: 'CKA' }] }, 'tex');
  if (certWarn.errors.length !== 0
      || !certWarn.warnings.some(w => w.includes('certifications'))) {
    console.error(`Self-test failed: certifications passed to the tex builder did not warn: ${JSON.stringify(certWarn)}`);
    process.exit(1);
  }

  const testOutput = join(tmpdir(), 'build-cv-latex-test.tex');
  const raw = JSON.stringify(sample, null, 2);
  const tmpInput = join(tmpdir(), 'build-cv-latex-test-input.json');
  await writeFile(tmpInput, raw, 'utf-8');

  const absInput = resolve(tmpInput);
  const absOutput = resolve(testOutput);

  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Self-test failed: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  let template = await readFile(TEMPLATE_PATH, 'utf-8');

  const emailUrl = sanitizeUrl(sample.email?.url || '');
  const emailDisplay = sample.email?.display || emailUrl;
  const linkedinUrl = sanitizeUrl(sample.linkedin?.url || '');
  const linkedinDisplay = sample.linkedin?.display || '';
  const githubUrl = sanitizeUrl(sample.github?.url || '');
  const githubDisplay = sample.github?.display || '';

  const substitutions = {
    NAME: escapeLatex(sample.name),
    CONTACT_LINE: escapeLatex(sample.contact_line),
    EMAIL_URL: emailUrl,
    EMAIL_DISPLAY: escapeLatex(emailDisplay),
    LINKEDIN_URL: linkedinUrl,
    LINKEDIN_DISPLAY: escapeLatex(linkedinDisplay),
    GITHUB_URL: githubUrl,
    GITHUB_DISPLAY: escapeLatex(githubDisplay),
    EDUCATION: buildEducation(sample.education),
    EXPERIENCE: buildExperience(sample.experience),
    PROJECTS: buildProjects(sample.projects),
    AWARDS: buildAwards(sample.awards),
    SKILLS: buildSkills(sample.skills),
  };

  for (const [key, value] of Object.entries(substitutions)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  const unresolved = template.match(PLACEHOLDER_RE);
  if (unresolved) {
    console.error(`Self-test failed: unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
    process.exit(1);
  }

  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(outDir, { recursive: true });
  }

  await writeFile(absOutput, template, 'utf-8');

  const fileInfo = await stat(absOutput);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    status: 'self-test-passed',
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat(sizeKB),
    counts: {
      educationEntries: sample.education.length,
      experienceEntries: sample.experience.length,
      projectEntries: sample.projects.length,
      awardEntries: sample.awards.length,
      skillCategories: sample.skills.length,
      totalBullets: (() => {
        const ex = Array.isArray(sample.experience) ? sample.experience.flatMap(e => Array.isArray(e?.bullets) ? e.bullets : []) : [];
        const pr = Array.isArray(sample.projects) ? sample.projects.flatMap(p => Array.isArray(p?.bullets) ? p.bullets : []) : [];
        return ex.length + pr.length;
      })(),
    },
  };

  console.log(JSON.stringify(report, null, 2));

  await import('fs/promises').then(fs =>
    Promise.all([
      fs.rm(tmpInput).catch(() => {}),
      fs.rm(testOutput).catch(() => {}),
    ])
  );

  process.exit(0);
}

main();
