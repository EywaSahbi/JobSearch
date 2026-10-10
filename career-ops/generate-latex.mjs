#!/usr/bin/env node

import { readFile, writeFile, stat, copyFile, rm } from 'fs/promises';
import { resolve, basename, dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const MIN_SECTIONS = 4;

const REQUIRED_COMMANDS = [
  '\\\\resumeSubheading',
  '\\\\resumeItem',
  '\\\\resumeProjectHeading',
];

const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

const CJK_PACKAGE_RE = /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:xeCJK|ctex)\b[^}]*\}|\\documentclass(?:\[[^\]]*\])?\{ctex(?:art|rep|book)?\}/;

export function resolveLatexEngine() {
  for (const candidate of ['tectonic', 'pdflatex']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch { }
  }
  return null;
}

export function validateLatexContent(content, compileOnly, engine = null) {
  const issues = [];
  let resumeItemCount = 0;
  let subheadingCount = 0;
  let projectHeadingCount = 0;

  if (!content.includes('\\begin{document}')) {
    issues.push('Missing \\begin{document}');
  }
  if (!content.includes('\\end{document}')) {
    issues.push('Missing \\end{document}');
  }

  if (compileOnly) {
    return {
      issues,
      counts: { resumeItems: 0, subheadings: 0, projectHeadings: 0 },
    };
  }

  const sectionCount = (content.match(/\\section\{/g) || []).length;
  if (sectionCount < MIN_SECTIONS) {
    issues.push(`Expected at least ${MIN_SECTIONS} \\section{} blocks (Education, Work Experience, Projects, Skills — or localized equivalents), found ${sectionCount}`);
  }

  if (CJK_RE.test(content)) {
    const hasCjkPackage = CJK_PACKAGE_RE.test(content);
    if (engine === 'tectonic' && hasCjkPackage) {
    } else if (engine === 'tectonic') {
      issues.push('CJK characters detected but no CJK package (xeCJK/ctex) is loaded. Generate from the CJK-aware template instead: `node build-cv-latex.mjs <input.json> <output.tex> --template=cjk` (templates/cv-template.cjk.tex), or use `pdf` mode (HTML to PDF, which renders CJK) for these CVs.');
    } else {
      issues.push('CJK characters detected. This CJK-aware LaTeX path needs a XeTeX-based engine (fontspec/xeCJK) — pdfLaTeX cannot compile it. Install tectonic (brew install tectonic) and regenerate from the CJK-aware template (`--template=cjk`), or use `pdf` mode (HTML to PDF, which renders CJK) for these CVs.');
    }
  }

  for (const cmd of REQUIRED_COMMANDS) {
    if (!new RegExp(cmd).test(content)) {
      issues.push(`Missing command: ${cmd}`);
    }
  }

  const unresolvedMatch = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolvedMatch) {
    issues.push(`Unresolved placeholders: ${[...new Set(unresolvedMatch)].join(', ')}`);
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (/\\resumeItem\{/.test(line)) resumeItemCount++;
    if (/\\resumeSubheading(?!Continue)/.test(line)) subheadingCount++;
    if (/\\resumeProjectHeading/.test(line)) projectHeadingCount++;
  }

  if (!content.includes('\\pdfgentounicode=1')) {
    issues.push('Missing \\pdfgentounicode=1 (ATS compatibility)');
  }

  return {
    issues,
    counts: {
      resumeItems: resumeItemCount,
      subheadings: subheadingCount,
      projectHeadings: projectHeadingCount,
    },
  };
}

export async function compileLatexFile(absPath, content, outputPath, compileOnly) {
  const engine = resolveLatexEngine();
  const { issues, counts } = validateLatexContent(content, compileOnly, engine);
  const fileInfo = await stat(absPath);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    file: basename(absPath),
    path: absPath,
    sizeKB: parseFloat(sizeKB),
    counts,
    issues,
    valid: issues.length === 0,
    compileOnly,
  };

  if (issues.length > 0) {
    return report;
  }

  const texDir = dirname(absPath);
  const texBase = basename(absPath, '.tex');
  const defaultPdf = join(texDir, `${texBase}.pdf`);
  const targetPdf = outputPath ? resolve(outputPath) : defaultPdf;

  const targetDir = dirname(targetPdf);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  if (!engine) {
    report.compiled = false;
    report.compileError = 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.';
    return report;
  }

  report.engine = engine;

  let compilePath = absPath;
  if (engine === 'tectonic') {
    const patched = content
      .replace(/\\pdfgentounicode\s*=\s*\d+[^\n]*\n?/g, '')
      .replace(/\\input\{glyphtounicode\}[^\n]*\n?/g, '');
    compilePath = join(texDir, `${texBase}._tectonic.tex`);
    await writeFile(compilePath, patched, 'utf-8');
  }

  try {
    if (engine === 'tectonic') {
      execFileSync('tectonic', ['--outdir', texDir, compilePath], {
        cwd: texDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } else {
      const pdflatexArgs = [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${texDir}`,
        absPath,
      ];
      execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', timeout: 120_000 });
      execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', timeout: 120_000 });
    }

    report.compiled = true;
  } catch (err) {
    const logPath = join(texDir, `${texBase}.log`);
    let latexError = err.message;
    try {
      const log = await readFile(logPath, 'utf-8');
      const errorLines = log.split('\n').filter(l => l.startsWith('!'));
      if (errorLines.length > 0) {
        latexError = errorLines.join('\n');
      }
    } catch { }

    report.compiled = false;
    report.compileError = latexError;
  }

  if (report.compiled) {
    const compileBase = basename(compilePath, '.tex');
    const compiledPdf = join(texDir, `${compileBase}.pdf`);

    try {
      await copyFile(compiledPdf, targetPdf);
      if (resolve(compiledPdf) !== resolve(targetPdf)) {
        await rm(compiledPdf).catch(() => {});
      }

      const pdfStat = await stat(targetPdf);
      report.pdf = {
        path: targetPdf,
        sizeKB: parseFloat((pdfStat.size / 1024).toFixed(1)),
      };
    } catch (err) {
      report.postCompileError = `Failed to finalize PDF: ${err.message}`;
    }

    const auxExts = ['.aux', '.log', '.out', '.fls', '.fdb_latexmk', '.synctex.gz'];
    for (const ext of auxExts) {
      await rm(join(texDir, `${compileBase}${ext}`)).catch(() => {});
    }
    if (engine === 'tectonic') {
      await rm(compilePath).catch(() => {});
    }
  }

  return report;
}

const KNOWN_FLAGS = ['--compile-only', '--help', '-h'];

const USAGE = `Usage:
  node generate-latex.mjs <input.tex> [output.pdf]                 # validate career-ops template structure, then compile
  node generate-latex.mjs <input.tex> [output.pdf] --compile-only  # skip template validation; compile any user-owned .tex (latex-tex mode)
  node generate-latex.mjs --help|-h                                # print this usage block and exit

Requires tectonic (preferred) or pdflatex on PATH.`;

async function main() {
  const rawArgs = process.argv.slice(2);

  validateFlags(rawArgs, KNOWN_FLAGS, USAGE);

  const compileOnly = rawArgs.includes('--compile-only');
  const args = rawArgs.filter(a => a !== '--compile-only');
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath) {
    console.error(USAGE);
    process.exit(1);
  }

  const absPath = resolve(inputPath);
  let content;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`Error reading ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const report = await compileLatexFile(absPath, content, outputPath || null, compileOnly);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.compiled ? 0 : (report.valid ? 1 : 1));
}

if (isMainModule(import.meta.url)) {
  main();
}
