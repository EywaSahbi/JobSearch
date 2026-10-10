#!/usr/bin/env node

import { chromium } from 'playwright';
import { resolve, dirname, extname } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function detectMimeType(imagePath) {
  const ext = extname(imagePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

export function parseArgs(args) {
  let inputPath = '';
  let outputPath = '';
  let force = false;
  let help = false;

  for (const arg of args) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (help) return { inputPath, outputPath, force, help, error: null };
  if (!inputPath || !outputPath) {
    return { inputPath, outputPath, force, help, error: 'Missing <image-path> and/or <output-path>.' };
  }
  return { inputPath, outputPath, force, help, error: null };
}

function usage() {
  console.log('Usage: node img-to-pdf.mjs <image-path> <output-path> [--force]');
  console.log('');
  console.log('Converts a single screenshot/image into a single-page PDF (Playwright/Chromium),');
  console.log('for ATS upload fields that require a PDF specifically. Zero new dependencies —');
  console.log('reuses the playwright dependency already used by generate-pdf.mjs.');
  console.log('');
  console.log('  --force   overwrite <output-path> if it already exists');
  console.log('');
  console.log('MVP scope: one image in, one PDF page out. Multi-image/multi-page is not supported.');
}

export async function convertImageToPdf(inputPath, outputPath) {
  const mimeType = detectMimeType(inputPath);
  if (!mimeType) {
    throw new Error(`Unsupported image type: ${extname(inputPath) || '(no extension)'}. Supported: ${Object.keys(MIME_TYPES).join(', ')}`);
  }

  const buffer = await readFile(inputPath);
  const base64 = buffer.toString('base64');
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; }
  html, body { margin: 0; padding: 0; }
  img { display: block; }
</style>
</head>
<body>
<img id="career-ops-img" src="data:${mimeType};base64,${base64}">
</body>
</html>`;

  await mkdir(dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    try {
      await page.waitForFunction(() => {
        const img = document.getElementById('career-ops-img');
        return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
      }, { timeout: 10000 });
    } catch (err) {
      throw new Error(`Image failed to decode within 10s (unreadable or corrupt file?): ${inputPath}`);
    }

    const { width, height } = await page.evaluate(() => {
      const img = document.getElementById('career-ops-img');
      return { width: img.naturalWidth, height: img.naturalHeight };
    });

    const widthIn = width / 96;
    const heightIn = height / 96;

    const pdfBuffer = await page.pdf({
      width: `${widthIn}in`,
      height: `${heightIn}in`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
    });

    await writeFile(outputPath, pdfBuffer);

    return { outputPath, size: pdfBuffer.length, width, height };
  } finally {
    await browser.close();
  }
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); }
  };

  assert(detectMimeType('screenshot.png') === 'image/png', 'png detected');
  assert(detectMimeType('a/b/c.JPG') === 'image/jpeg', 'uppercase JPG detected');
  assert(detectMimeType('x.jpeg') === 'image/jpeg', 'jpeg detected');
  assert(detectMimeType('x.gif') === 'image/gif', 'gif detected');
  assert(detectMimeType('x.webp') === 'image/webp', 'webp detected');
  assert(detectMimeType('x.bmp') === 'image/bmp', 'bmp detected');
  assert(detectMimeType('x.svg') === 'image/svg+xml', 'svg detected');
  assert(detectMimeType('x.pdf') === null, 'unsupported extension -> null');
  assert(detectMimeType('noext') === null, 'no extension -> null');

  const a1 = parseArgs(['in.png', 'out.pdf']);
  assert(a1.inputPath === 'in.png' && a1.outputPath === 'out.pdf' && a1.force === false && a1.error === null, 'basic positional args');

  const a2 = parseArgs(['in.png', 'out.pdf', '--force']);
  assert(a2.force === true && a2.error === null, '--force flag parsed');

  const a3 = parseArgs(['--force', 'in.png', 'out.pdf']);
  assert(a3.inputPath === 'in.png' && a3.outputPath === 'out.pdf' && a3.force === true, '--force before positionals still parses correctly');

  const a4 = parseArgs(['in.png']);
  assert(a4.error !== null, 'missing output-path -> error');

  const a5 = parseArgs([]);
  assert(a5.error !== null, 'no args -> error');

  const a6 = parseArgs(['--help']);
  assert(a6.help === true && a6.error === null, '--help short-circuits missing-arg validation');

  console.log('img-to-pdf self-test OK (mime detection + arg parsing)');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    selfTest();
    return;
  }

  const parsed = parseArgs(args);

  if (parsed.help) {
    usage();
    return;
  }

  if (parsed.error) {
    console.error(`❌ ${parsed.error}`);
    usage();
    process.exit(1);
  }

  const inputPath = resolve(parsed.inputPath);
  const outputPath = resolve(parsed.outputPath);

  if (!existsSync(inputPath)) {
    console.error(`❌ Image not found: ${inputPath}`);
    process.exit(1);
  }

  if (existsSync(outputPath) && !parsed.force) {
    console.error(`❌ Output already exists: ${outputPath}`);
    console.error('   Pass --force to overwrite it.');
    process.exit(1);
  }

  console.log(`🖼️  Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);

  try {
    const result = await convertImageToPdf(inputPath, outputPath);
    console.log(`✅ PDF generated: ${result.outputPath}`);
    console.log(`📐 Page size: ${result.width}x${result.height}px`);
    console.log(`📦 Size: ${(result.size / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error(`❌ Conversion failed: ${err.message}`);
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main();
}
