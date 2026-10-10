#!/usr/bin/env node

import { chromium } from 'playwright';
import { writeFile, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { captureSlug, reportPrefix } from './jd-capture.mjs';
import { rejectPrivateOrInvalid, validateUrlSecurity } from './liveness-browser.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { detectNonContentMarker } from './check-jd-archive.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const JDS_DIR = join(DATA_ROOT, 'jds');
const PIPELINE_PATH = join(DATA_ROOT, 'data', 'pipeline.md');

const KNOWN_FLAGS = ['--company', '--role', '--report', '--pipeline', '--dry-run', '--help', '-h'];
const VALUE_FLAGS = ['--company', '--role', '--report'];

const NON_CONTENT_PAGE_MAX_CHARS = 600;

const HELP_TEXT = `
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Job Posting Archiver                     ║
╚══════════════════════════════════════════════════════════════════╝

  Save a live job posting as PDF before it disappears.

  USAGE
    node archive-posting.mjs <url>
    node archive-posting.mjs <url> --company=Anthropic --role=senior-ai-engineer
    node archive-posting.mjs --pipeline     Archive all pending URLs in data/pipeline.md
    node archive-posting.mjs --dry-run <url>

  OPTIONS
    --company <name>   Override auto-detected company name
    --role <title>     Override auto-detected role title
    --report <num>     Key the capture to a report/tracker number (recommended)
    --pipeline         Archive all pending (- [ ]) entries in data/pipeline.md
    --dry-run          Preview filename without saving
    --help             Show this help

  OUTPUT
    jds/YYYY-MM-DD_company-slug_role-slug.pdf
    jds/NNN-YYYY-MM-DD_company-slug_role-slug.pdf     with --report

  WHY --report
    Without it, a capture is only findable by rebuilding its filename from
    today's date and the scraped company and role, so it stops resolving the
    next day. outcome.mjs looks captures up by report number.

  PIPELINE REFERENCE (paste into pipeline.md or reports/)
    local:jds/{filename}

  EXAMPLES
    node archive-posting.mjs "https://jobs.ashbyhq.com/anthropic/abc123"
    node archive-posting.mjs "https://boards.greenhouse.io/openai/jobs/456" --company=OpenAI
    node archive-posting.mjs "https://jobs.lever.co/acme/xyz" --report=42
    node archive-posting.mjs --pipeline
    npm run archive -- "https://jobs.lever.co/elevenlabs/abc"
`;

let targetUrl = null;
let overrideCompany = null;
let overrideRole = null;
let pipelineMode = false;
let dryRun = false;
let reportNum = null;

function parseCliArgs(args) {
  validateFlags(args, KNOWN_FLAGS, HELP_TEXT, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });

  if (args.length === 0) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pipeline') {
      pipelineMode = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--company=')) {
      overrideCompany = arg.slice('--company='.length).trim();
    } else if (arg === '--company') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        console.error('--company requires a value.');
        process.exit(1);
      }
      overrideCompany = args[++i].trim();
    } else if (arg.startsWith('--role=')) {
      overrideRole = arg.slice('--role='.length).trim();
    } else if (arg === '--role') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        console.error('--role requires a value.');
        process.exit(1);
      }
      overrideRole = args[++i].trim();
    } else if (arg.startsWith('--report=')) {
      reportNum = arg.slice('--report='.length).trim();
    } else if (arg === '--report') {
      reportNum = args[++i]?.trim() ?? '';
    } else if (!arg.startsWith('--') && !targetUrl) {
      targetUrl = arg;
    }
  }

  if (reportNum !== null) {
    if (!/^\d+$/.test(reportNum) || Number(reportNum) <= 0) {
      console.error(`Invalid --report value: "${reportNum}". Expected a positive report number.`);
      process.exit(1);
    }
    if (pipelineMode) {
      console.error('--report applies to a single posting; it cannot be combined with --pipeline.');
      process.exit(1);
    }
  }

  if (!pipelineMode && !targetUrl) {
    console.error('No URL provided. Run with --help for usage.');
    process.exit(1);
  }
}

function today() {
  return localToday();
}

function captureFilename(company, role) {
  const base = `${today()}_${captureSlug(company)}_${captureSlug(role)}.pdf`;
  return reportNum ? `${reportPrefix(reportNum)}-${base}` : base;
}

function parsePageTitle(title) {
  if (!title) return { company: null, role: null };

  const cleaned = title
    .replace(/\s*[|–-]\s*(greenhouse|lever|ashby|workday|linkedin|indeed|wellfound|angellist)\s*$/i, '')
    .trim();

  const atMatch = cleaned.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: atMatch[1].trim(), company: atMatch[2].trim() };

  const pipeMatch = cleaned.match(/^([^|–]+?)\s*[|–]\s*(.+)$/);
  if (pipeMatch) {
    const left = pipeMatch[1].trim();
    const right = pipeMatch[2].trim();
    const roleKeywords = /engineer|manager|director|analyst|scientist|designer|developer|lead|head|vp|president|officer|specialist|architect/i;
    if (roleKeywords.test(right)) return { company: left, role: right };
    if (roleKeywords.test(left)) return { role: left, company: right };
    return { company: left, role: right };
  }

  const dashMatch = cleaned.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) return { role: dashMatch[1].trim(), company: dashMatch[2].trim() };

  return { company: null, role: cleaned };
}

function extractCompanyFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (hostname === 'boards.greenhouse.io') return parts[0] || null;
    if (/^jobs\.(eu\.)?lever\.co$/.test(hostname)) return parts[0] || null;
    if (hostname === 'jobs.ashbyhq.com') return parts[0] || null;
    if (hostname === 'app.dover.io') return parts[0] || null;
    return null;
  } catch {
    return null;
  }
}

async function extractPipelineEntries() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error('data/pipeline.md not found. Add URLs there first.');
    process.exit(1);
  }

  const content = await readFile(PIPELINE_PATH, 'utf-8');
  const entries = [];

  for (const line of content.split('\n')) {
    if (!line.startsWith('- [ ]')) continue;

    const urlMatch = line.match(/https?:\/\/[^\s|)]+/);
    if (!urlMatch) continue;

    const url = urlMatch[0];
    const parts = line.split('|').map(s => s.trim());
    const company = parts[1] || null;
    const role = parts[2] || null;

    entries.push({ url, company, role });
  }

  return entries;
}

export async function installEgressGuard(context) {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();

    const verdict = rejectPrivateOrInvalid(requestUrl);
    if (verdict) {
      console.warn(`   Blocked request to restricted destination: ${requestUrl} (${verdict.reason})`);
      return route.abort('blockedbyclient');
    }

    try {
      await validateUrlSecurity(requestUrl);
      return route.continue();
    } catch (err) {
      console.warn(`   Blocked request to restricted destination (DNS): ${requestUrl} - ${err.message}`);
      return route.abort('blockedbyclient');
    }
  });
}

export async function archiveUrl(browser, url, { company: companyHint, role: roleHint } = {}) {
  console.log(`\n🔗  ${url}`);

  const preGuard = rejectPrivateOrInvalid(url);
  if (preGuard) {
    throw new Error(`refusing to archive restricted destination: ${preGuard.reason}`);
  }

  const context = await browser.newContext();
  await installEgressGuard(context);
  const page = await context.newPage();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const httpStatus = response?.status() ?? 0;

    const landedUrl = page.url();
    const postGuard = rejectPrivateOrInvalid(landedUrl);
    if (postGuard) {
      throw new Error(`refusing to archive restricted destination after redirect: ${postGuard.reason}`);
    }

    await page.waitForTimeout(2000);

    const pageTitle = await page.title();
    const h1Text = await page.$eval('h1', el => el.innerText.trim()).catch(() => '');
    const urlCompany = extractCompanyFromUrl(url);

    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    if (!bodyText.trim()) {
      throw new Error('refusing to archive: page has no visible text');
    }
    const nonContentMarker = bodyText.length <= NON_CONTENT_PAGE_MAX_CHARS
      ? detectNonContentMarker(bodyText)
      : null;
    if (nonContentMarker) {
      throw new Error(`refusing to archive: page ${nonContentMarker.reason}`);
    }

    const detected = parsePageTitle(pageTitle);
    const resolvedCompany = overrideCompany || companyHint || detected.company || urlCompany || 'unknown';
    const resolvedRole = overrideRole || roleHint || detected.role || h1Text || 'job';

    const company = resolvedCompany.replace(/^job\s+application\s+for\s+/i, '').trim();
    const role = resolvedRole.replace(/^job\s+application\s+for\s+/i, '').trim();

    console.log(`   Company: ${company}`);
    console.log(`   Role:    ${role}`);
    if (httpStatus === 404) {
      throw new Error('refusing to archive: HTTP 404');
    }
    if (httpStatus && httpStatus >= 400) {
      console.log(`HTTP ${httpStatus} — page may be closed, archiving anyway`);
    }

    const filename = captureFilename(company, role);
    const outputPath = join(JDS_DIR, filename);
    const reference = `local:jds/${filename}`;

    console.log(`   Output:  jds/${filename}`);

    mkdirSync(JDS_DIR, { recursive: true });

    const pdfBuffer = await page.pdf({
      format: 'a4',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      preferCSSPageSize: false,
    });

    await writeFile(outputPath, pdfBuffer);

    const sizeKb = (pdfBuffer.length / 1024).toFixed(1);
    console.log(`Saved (${sizeKb} KB)`);
    console.log(`Reference: ${reference}`);

    return { filename, reference, url, size: pdfBuffer.length };

  } finally {
    await context.close();
  }
}

async function main() {
  let targets;
  if (pipelineMode) {
    const entries = await extractPipelineEntries();
    if (entries.length === 0) {
      console.log('No pending (- [ ]) URLs found in data/pipeline.md.');
      return;
    }
    targets = entries;
  } else {
    targets = [{ url: targetUrl, company: null, role: null }];
  }

  if (dryRun) console.log('🔍  Dry-run mode — no files will be saved.\n');

  console.log(`Archiving ${targets.length} posting(s) to jds/`);

  const results = [];
  let failed = 0;

  if (dryRun) {
    for (const { url, company, role } of targets) {
      const urlCompany = extractCompanyFromUrl(url);
      const resolvedCompany = overrideCompany || company || urlCompany || 'unknown';
      const resolvedRole = overrideRole || role || 'job';
      const filename = captureFilename(resolvedCompany, resolvedRole);
      const reference = `local:jds/${filename}`;
      console.log(`\n🔗  ${url}`);
      console.log(`   Company: ${resolvedCompany}`);
      console.log(`   Role:    ${resolvedRole}`);
      console.log(`   Output:  jds/${filename}`);
      console.log('   (dry-run — not saved)');
      results.push({ url, filename, reference, skipped: true });
    }
  } else {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const { url, company, role } of targets) {
        try {
          const result = await archiveUrl(browser, url, { company, role });
          results.push(result);
        } catch (err) {
          console.error(`   ❌  Failed: ${err.message.split('\n')[0]}`);
          results.push({ url, error: err.message });
          failed++;
        }
      }
    } finally {
      await browser.close();
    }
  }

  const saved = results.filter(r => !r.error && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log('\n' + '─'.repeat(62));
  if (dryRun) {
    console.log(`  Dry-run: ${skipped} file(s) would be saved to jds/`);
  } else {
    console.log(`  Archived: ${saved} saved  ${failed} failed`);
  }

  const references = results.filter(r => r.reference);
  if (references.length > 0) {
    console.log('\n  References (paste into pipeline.md or a report header):');
    for (const r of references) {
      console.log(`    ${r.reference}`);
    }
  }
  console.log('─'.repeat(62) + '\n');

  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  parseCliArgs(process.argv.slice(2));
  main().catch(err => {
    console.error('❌  Fatal:', err.message);
    process.exit(1);
  });
}
