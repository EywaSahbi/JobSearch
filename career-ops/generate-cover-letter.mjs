#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve, join, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { assertFacts, printAdvisoryFacts } from "./verify-cv-facts.mjs";
import { resolveTemplate } from "./cv-templates.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { getCareerOpsRoot } from "./path-resolver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = resolve(getCareerOpsRoot(), "output");

export function safeOutputPath(raw) {
  if (raw == null || String(raw).trim() === "") {
    throw new Error("Refusing to write the cover letter outside output/: (empty path)");
  }
  const trimmed = String(raw).trim();

  const asWritten = resolve(trimmed);
  if (containedInOutput(asWritten)) return asWritten;

  if (isAbsolute(trimmed) || /(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
    throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
  }

  const posix = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  const relativeToRoot = posix === "output" || posix === "output/"
    ? ""
    : posix.startsWith("output/")
      ? posix.slice("output/".length)
      : posix;
  const candidate = resolve(OUTPUT_ROOT, relativeToRoot);
  if (containedInOutput(candidate)) return candidate;

  throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
}

function containedInOutput(absPath) {
  const rel = relative(OUTPUT_ROOT, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function _require(obj, keys, context) {
  for (const key of keys) {
    if (!obj || typeof obj !== "object" || !(key in obj)) {
      throw new Error(`Missing required field: ${context}.${key}`);
    }
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function buildContactLine(candidate) {
  const parts = [];
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  if (candidate.email) {
    const email = escapeHtml(candidate.email);
    parts.push(`<a href="mailto:${email}">${email}</a>`);
  }
  if (candidate.phone) parts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) {
    const display = candidate.linkedin.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">${escapeHtml(display)}</a>`);
  }
  if (candidate.github) {
    const display = candidate.github.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.github))}">${escapeHtml(display)}</a>`);
  }
  return parts.join(" &nbsp;|&nbsp; ");
}

function buildCredentialsBlock(candidate) {
  const credentials = candidate.credentials || [];
  if (!credentials.length) return "";
  return `<div class="credentials">${credentials.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>`;
}

function buildDateline(letter, hasRecipientBlock = false) {
  const parts = hasRecipientBlock
    ? [letter.date]
    : [letter.company, letter.city, letter.date];
  return parts.filter(Boolean).map(escapeHtml).join(" &nbsp;&nbsp; ");
}

function buildRecipientBlock(letter) {
  const r = letter.recipient;
  if (!r || typeof r !== "object") return "";
  const addressLines = Array.isArray(r.address_lines)
    ? r.address_lines
    : r.address
      ? [r.address]
      : [];
  const lines = [r.name, r.title, r.company, ...addressLines]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const components = (v) => {
    const parts = String(v)
      .split(",")
      .map((part) => part.toLowerCase().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (parts.length) {
      const last = parts[parts.length - 1].replace(/\s+\d{5}(?:-\d{4})?$/, "").trim();
      if (last) parts[parts.length - 1] = last;
    }
    return parts;
  };

  const containsRun = (hay, needle) => {
    if (!needle.length || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((n, j) => hay[i + j] === n)) return true;
    }
    return false;
  };

  const headCount = [r.name, r.title, r.company]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean).length;
  for (const [extra, insertAt] of [[letter.company, headCount], [letter.city, null]]) {
    const v = typeof extra === "string" ? extra.trim() : "";
    if (!v) continue;
    const want = components(v);
    if (lines.some((l) => containsRun(components(l), want))) continue;
    if (insertAt === null) lines.push(v);
    else lines.splice(insertAt, 0, v);
  }

  const escaped = lines.map(escapeHtml);
  return `<div class="recipient">\n${escaped.map((l) => `    <div>${l}</div>`).join("\n")}\n  </div>`;
}


function buildAchievementsBlock(achievements) {
  if (!achievements || !achievements.length) return "";
  const items = achievements.map(ach => {
    const lead = escapeHtml((ach.lead || "").replace(/,\s*$/, ""));
    const impact = escapeHtml(ach.impact || "");
    return `    <li><b>${lead},</b> ${impact}</li>`;
  }).join("\n");
  return `<ul class="achievements">\n${items}\n  </ul>`;
}

function buildFootnotesBlock(footnotes) {
  if (!footnotes || !footnotes.length) return "";
  const lines = footnotes.map(fn => {
    if (typeof fn === "object" && fn !== null) {
      const marker = escapeHtml(fn.marker || "");
      const text = escapeHtml(fn.text || "");
      const url = fn.url
        ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>`
        : "";
      return `    <p>${marker} ${text}${url}</p>`;
    }
    return `    <p>${escapeHtml(fn)}</p>`;
  }).join("\n");
  return `<div class="footnotes">\n${lines}\n  </div>`;
}

function buildSignatureBlock(signature, candidateName) {
  if (!signature) return "";
  const isObject = typeof signature === "object" && signature !== null;
  const valediction = isObject ? signature.valediction : signature;
  const name = (isObject ? signature.name : "") || candidateName || "";
  if (!valediction && !name) return "";
  const lines = [valediction, name].filter(Boolean).map(escapeHtml);
  return `<p class="signature">${lines.join("<br>")}</p>`;
}

export function resolveCoverTemplatePath(payload = {}, opts = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const base = resolve(scriptDir, "templates", "cover-letter-template.html");
  try {
    return resolveTemplate("cover", payload.template, { format: "html", fallback: true, ...opts });
  } catch {
    return base;
  }
}

export function buildHtml(payload, templatePath) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const resolvedPath = templatePath || resolveCoverTemplatePath(payload);
  let html = readFileSync(resolvedPath, "utf-8");

  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : "";
  const closingBlock = letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : "";
  const languageClosingBlock = letter.language_closing
    ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>`
    : "";
  const problemsBlock = letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : "";

  const signatureBlock = buildSignatureBlock(letter.signature, candidate.name);

  const recipientBlock = buildRecipientBlock(letter);
  const rendersRecipientBlock = Boolean(recipientBlock) && html.includes("{{RECIPIENT_BLOCK}}");
  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter, rendersRecipientBlock),
    "{{RECIPIENT_BLOCK}}": recipientBlock,
    "{{GREETING_BLOCK}}": greetingBlock,
    "{{OPENING}}": escapeHtml(letter.opening),
    "{{PROFILE_INTRO}}": escapeHtml(letter.profile_intro),
    "{{ACHIEVEMENTS_BLOCK}}": buildAchievementsBlock(letter.achievements),
    "{{PROBLEMS_BLOCK}}": problemsBlock,
    "{{CLOSING_BLOCK}}": closingBlock,
    "{{LANGUAGE_CLOSING_BLOCK}}": languageClosingBlock,
    "{{SIGNATURE_BLOCK}}": signatureBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  const unresolved = new Set();
  const rendered = html.replace(/\{\{[A-Z_]+\}\}/g, (token) => {
    const value = replacements[token];
    if (value == null) {
      unresolved.add(token);
      return token;
    }
    return value;
  });

  if (unresolved.size) {
    throw new Error(`Unresolved placeholders: ${[...unresolved].join(', ')}`);
  }
  return rendered;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      payload: { type: "string" },
      out:     { type: "string" },
      format:  { type: "string" },
      report:  { type: "string" },
      help:    { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (args.help || !args.payload) {
    console.log(`
Usage:
  node generate-cover-letter.mjs --payload payload.json [--out output/path.pdf] [--format letter|a4] [--report NNN]

  --payload   Path to the JSON payload file (required)
  --out       Override output path from payload (optional)
  --format    Override output PDF page format (letter|a4). Defaults to
              config/profile.yml page_format, then letter.
  --report    Link the PDF to a tracker report number in data/pdf-index.tsv
`);
    process.exit(args.help ? 0 : 1);
  }

  const payloadPath = resolve(args.payload);
  if (!existsSync(payloadPath)) {
    console.error(`ERROR: payload file not found: ${payloadPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));

  if (args.out) {
    payload.output_path = args.out;
  }

  if (!payload.output_path) {
    const company = (payload.letter?.company || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const role    = (payload.letter?.role_title || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    payload.output_path = join(OUTPUT_ROOT, `${company}-${role}-cover.pdf`);
  } else {
    try {
      payload.output_path = safeOutputPath(payload.output_path);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });

  try {
    const html = buildHtml(payload);
    const factCheck = assertFacts(html, { label: "cover letter" });
    if (factCheck.configMissing) {
      console.error("No config/cv-facts.json — forbidden/advisory phrase checks did not run.");
    }
    if (factCheck.verdict === "warn") {
      console.error(`CV fact check warning: cover letter`);
      for (const phrase of factCheck.warnings) {
        console.error(`  - advisory phrase: ${phrase}`);
      }
      printAdvisoryFacts(factCheck.advisoryFacts, console.error);
    }
    const { renderHtmlToPdf } = await import("./generate-pdf.mjs");
    const outputPath = resolve(payload.output_path);
    await renderHtmlToPdf(html, outputPath, {
      format: args.format,
      reportNum: args.report,
      kind: 'cover',
      inputPath: payloadPath,
    });
    console.log(`\nCover letter PDF: ${payload.output_path}`);
  } catch (err) {
    console.error("ERROR generating cover letter PDF:");
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
