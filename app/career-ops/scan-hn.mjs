#!/usr/bin/env node

try {
  const { config } = await import('dotenv');
  config(); 
} catch (e) {}

import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';

import hnProvider from './providers/hackernews.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const KNOWN_FLAGS = ['--help', '-h'];
const USAGE = `Usage:
  node scan-hn.mjs                  # scan the latest "Ask HN: Who is hiring?" thread

Fetches the newest hiring thread from Hacker News and keeps the postings that
match hn_hiring.keywords in portals.yml (default: "Software Engineer"). With
GEMINI_API_KEY set, Gemini extracts each posting instead of the keyword match.
New offers are appended to data/pipeline.md and to the scan history.

Flags:
  --help, -h                        # show this help and exit`;

function loadKeywords() {
  const defaultKeywords = ["Software Engineer"];
  let configObj = {};
  if (existsSync(PORTALS_PATH)) {
    try {
      configObj = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    } catch (e) {}
  }
  return configObj.hn_hiring?.keywords || defaultKeywords;
}

export async function extractWithAI(rawText, model) {
  const prompt = `--- BEGIN UNTRUSTED DATA ---\n${rawText.substring(0, 2000)}\n--- END UNTRUSTED DATA ---`;
  const result = await model.generateContent(prompt);
  try {
    const response = result.response.text();
    const clean = response.replace(/```yaml|```/g, '').trim();

    let parsed;
    try {
      parsed = yaml.load(clean);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;
    return {
      company: (parsed.company || parsed.COMPANY || '').trim(),
      title: (parsed.title || parsed.TITLE || '').trim(),
      location: (parsed.location || parsed.LOCATION || 'Remote/Unknown').trim()
    };
  } catch {
    return null;
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const myKeywords = loadKeywords();
  const { seen } = loadSeenUrls();

  console.log(`🔍 Fetching latest HN Hiring data...`);
  
  const ctx = { fetchJson: async (url) => (await fetch(url)).json() };
  const rawJobs = await hnProvider.fetch({ name: 'HN' }, ctx);

  const newOffers = [];
  let aiCalls = 0;
  let aiFailures = 0;
  let firstAiError = '';

  if (apiKey) {
    console.log(`✨ AI Key detected. Processing with Gemini...`);
    const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: `Extract job data. Match: [${myKeywords.join(', ')}]. Format: YAML (company, title, location).`,
    });

    for (const job of rawJobs) {
      if (seen.has(job.url)) continue;
      
      aiCalls++;
      let extracted;
      try {
        extracted = await extractWithAI(job.title + " " + (job.text || ""), model);
      } catch (err) {
        aiFailures++;
        if (!firstAiError) firstAiError = `${modelName}: ${err?.message || err}`;
        seen.add(job.url);
        continue;
      }
      if (extracted && extracted.company && extracted.title) {
        newOffers.push({ ...job, ...extracted, source: 'hn-hiring', postedAt: Date.now() });
        console.log(`  ✅ AI Match: ${extracted.company}`);
      }
      seen.add(job.url);
    }
  } else {
    console.log(`⚠️ No AI key. Using keyword filtering mode...`);
    for (const job of rawJobs) {
      if (seen.has(job.url)) continue;

      const matches = myKeywords.some(k => job.title.toLowerCase().includes(k.toLowerCase()));
      if (matches) {
        newOffers.push({ ...job, source: 'hn-hiring', postedAt: Date.now() });
        console.log(`  ✅ Match: ${job.company}`);
      }
      seen.add(job.url);
    }
  }

  if (newOffers.length > 0) {
    await appendToPipeline(newOffers);
    await appendToScanHistory(newOffers, localToday(), 'added');
  }

  printScanSummaryHeader('HN Scan', localToday());
  console.log(`Postings fetched:   ${rawJobs.length}`);
  console.log(`New offers:         ${newOffers.length}`);
  if (aiFailures > 0) {
    console.log(`AI errors:          ${aiFailures} of ${aiCalls}`);
    console.warn(`\n⚠️  ${aiFailures} of ${aiCalls} Gemini extractions failed, so those postings were not checked. First error: ${firstAiError}`);
    if (aiFailures === aiCalls) process.exitCode = 1;
  }
  if (newOffers.length > 0) console.log(`\n🎉 Success: ${newOffers.length} offers added.`);
}

if (isMainModule(import.meta.url)) {
  validateFlags(process.argv.slice(2), KNOWN_FLAGS, USAGE);
  main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
}