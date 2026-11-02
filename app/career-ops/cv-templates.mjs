#!/usr/bin/env node

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  parseMeta, PARTIAL_SECTIONS, declaredSections, checkDeclaredSections,
} from './lib/template-manifest.mjs';

export { parseMeta, PARTIAL_SECTIONS, declaredSections, checkDeclaredSections };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = resolve(__dirname, 'templates');
const DEFAULT_PROFILE_PATH =
  process.env.CAREER_OPS_PROFILE || resolve(getCareerOpsRoot(), 'config', 'profile.yml');

export const KINDS = {
  cv: {
    prefix: 'cv-template',
    profileKey: ['cv', 'template'],
    required: ['NAME', 'EXPERIENCE', 'EDUCATION'],
  },
  cover: {
    prefix: 'cover-letter-template',
    profileKey: ['cover_letter', 'template'],
    required: ['NAME', 'ROLE_TITLE', 'OPENING'],
  },
};

export function prettify(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function kebab(display) {
  return String(display)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VALID_FORMATS = new Set(['html', 'tex']);
function assertFormat(format) {
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Unsupported template format: ${format} (expected html or tex)`);
  }
}

function parseFilename(prefix, file) {
  const m = file.match(new RegExp(`^${prefix}(?:\\.([a-z0-9-]+))?\\.(html|tex)$`));
  if (!m) return null;
  return { name: m[1] || 'standard', format: m[2] };
}

function entryFor(parsed, path, pack) {
  const meta = parseMeta(path);
  return {
    name: parsed.name,
    displayName: meta.name || prettify(parsed.name),
    path,
    format: parsed.format,
    meta,
    pack,
  };
}

function discover(kind, { dir, format }) {
  const cfg = KINDS[kind];
  const found = new Map();
  if (!existsSync(dir)) return found;

  const claim = (parsed, path, pack) => {
    if (parsed.format !== format) return;
    const prior = found.get(parsed.name);
    if (prior) assertNoCollision(parsed.name, prior.path, path, dir);
    found.set(parsed.name, entryFor(parsed, path, pack));
  };

  const top = readdirSync(dir, { withFileTypes: true });

  for (const d of top) {
    const parsed = parseFilename(cfg.prefix, d.name);
    if (parsed) claim(parsed, resolve(dir, d.name), null);
  }

  for (const d of top) {
    const packDir = resolve(dir, d.name);
    if (!d.isDirectory()) {
      if (!d.isSymbolicLink()) continue;
      try {
        if (!statSync(packDir).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    let inner;
    try {
      inner = readdirSync(packDir);
    } catch {
      continue;
    }
    for (const file of inner) {
      const parsed = parseFilename(cfg.prefix, file);
      if (parsed) claim(parsed, resolve(packDir, file), d.name);
    }
  }

  return found;
}

function assertNoCollision(name, a, b, dir) {
  const rel = (p) => p.slice(dir.length + 1) || p;
  const [x, y] = [rel(a), rel(b)].sort();
  throw new Error(
    `Template name "${name}" is claimed by two files: ${x} and ${y}. `
      + `A name must resolve to one template — rename one, or remove the one you no longer use.`
  );
}

export function listTemplates(kind, { dir = DEFAULT_TEMPLATES_DIR, format = 'html' } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  assertFormat(format);
  return [...discover(kind, { dir, format }).values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function validateTemplate(path, kind) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  const text = readFileSync(path, 'utf-8');
  const missing = cfg.required.filter((ph) => !text.includes(`{{${ph}}}`));
  return { ok: missing.length === 0, missing };
}

const DEFAULT_ATS_RULES_PATH = resolve(__dirname, 'templates', 'ats-rules.yml');

export function loadAtsRules(path = DEFAULT_ATS_RULES_PATH) {
  const doc = yaml.load(readFileSync(path, 'utf-8')) || {};
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new Error(
      `ATS rules file defines no rules: ${path}. `
        + 'An empty rule set checks nothing and would report a clean pass.'
    );
  }
  const seen = new Set();
  for (const [i, rule] of doc.rules.entries()) {
    const at = `${path} rule ${i}`;
    if (!rule || typeof rule !== 'object') throw new Error(`${at}: each rule must be a mapping`);
    if (!rule.id) throw new Error(`${at}: needs an id`);
    if (seen.has(rule.id)) throw new Error(`${at}: duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    if (!rule.rule) throw new Error(`${at} (${rule.id}): needs a human-readable rule name`);
    if (rule.severity !== 'warning') {
      throw new Error(`${at} (${rule.id}): severity must be "warning"; atsLint is advisory and never blocks a render`);
    }
    if (!Array.isArray(rule.source) || rule.source.length === 0) {
      throw new Error(`${at} (${rule.id}): needs at least one source quote`);
    }
    if (!rule.must_not_flag) {
      throw new Error(`${at} (${rule.id}): needs must_not_flag, the half that decides whether the rule is worth having`);
    }
    if (rule.detect === null) {
      if (!rule.unimplemented_because) {
        throw new Error(`${at} (${rule.id}): a null detector must carry unimplemented_because`);
      }
    } else if (!Object.hasOwn(ATS_DETECTORS, rule.detect)) {
      throw new Error(
        `${at} (${rule.id}): detect must name a registered detector `
          + `(${Object.keys(ATS_DETECTORS).join(', ')}), or be null with unimplemented_because; `
          + `got ${JSON.stringify(rule.detect)}`
      );
    }
  }

  return {
    sourceDoc: doc.source_doc || null,
    rules: doc.rules,
    cannotCatch: Array.isArray(doc.cannot_catch) ? doc.cannot_catch : [],
  };
}

function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ');
}

function textOf(fragment) {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function innerHtml(html, tag, from) {
  const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
  scan.lastIndex = from;
  let depth = 1;
  for (let m; (m = scan.exec(html));) {
    if (m[2]) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

function detectNestedTable(html) {
  let depth = 0;
  for (const m of stripNonContent(html).matchAll(/<(\/?)table\b/gi)) {
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (++depth >= 2) return ['a <table> is nested inside another <table>'];
  }
  return [];
}

const HIDDEN_SIGNALS = [
  [/display\s*:\s*none/i, 'display:none'],
  [/visibility\s*:\s*hidden/i, 'visibility:hidden'],
  [/font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)/i, 'font-size:0'],
  [/(?:^|;)\s*color\s*:\s*(?:#fff(?:fff)?\b|white\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i, 'white text'],
];

function detectHiddenText(html) {
  const out = [];
  for (const m of stripNonContent(html).matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const decl = m[1] ?? m[2] ?? m[3];
    for (const [re, label] of HIDDEN_SIGNALS) {
      if (re.test(decl)) out.push(`inline style hides text (${label}): style="${decl.trim().slice(0, 80)}"`);
    }
  }
  return out;
}

function isPlaceholderOnly(text) {
  return !text.replace(/\{\{[^}]*\}\}/g, '').trim();
}

function documentLanguage(html) {
  const open = stripNonContent(html).match(/<html\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
  if (!open) return null;

  const attr = /([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = attr.exec(open[1])) !== null) {
    if (m[1].toLowerCase() !== 'lang') continue;
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim().toLowerCase();
    if (!value || isPlaceholderOnly(value)) return null;
    return value.split('-')[0];
  }
  return null;
}

function detectStandardSectionHeaders(html, rule) {
  const accepted = new Set((rule.headers || []).map((h) => h.toLowerCase()));
  if (accepted.size === 0) return [];
  const body = stripNonContent(html);
  const headings = [...new Set([
    ...[...body.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\sclass\s*=\s*(?:"[^"]*\bsection-title\b[^"]*"|'[^']*\bsection-title\b[^']*'|section-title(?=[\s>]))[^>]*>/gi)]
      .map((m) => innerHtml(body, m[1], m.index + m[0].length)),
    ...[...body.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => m[1]),
  ].map(textOf))];

  const out = [];
  for (const heading of headings) {
    if (!heading) continue;
    if (isPlaceholderOnly(heading)) continue;
    if (accepted.has(heading.toLowerCase())) continue;
    out.push(`non-standard section heading: "${heading.slice(0, 60)}"`);
  }
  return out;
}

export const ATS_DETECTORS = {
  'nested-table': detectNestedTable,
  'hidden-text': detectHiddenText,
  'standard-section-headers': detectStandardSectionHeaders,
};

export function atsLint(path, kind, opts = {}) {
  const result = { ok: true, path, kind, findings: [], skipped: [], cannotCatch: [], error: null };
  try {
    const { rules, cannotCatch } = loadAtsRules(opts.rulesPath || DEFAULT_ATS_RULES_PATH);
    result.cannotCatch = cannotCatch;
    const html = readFileSync(path, 'utf-8');
    for (const rule of rules) {
      if (Array.isArray(rule.kinds) && !rule.kinds.includes(kind)) continue;

      if (rule.id === 'standard-section-headers') {
        const lang = documentLanguage(html);
        if (lang && lang !== 'en') {
          result.skipped.push({
            id: rule.id,
            rule: rule.rule,
            reason: `document language is "${lang}"; the accepted-header list is English only`,
          });
          continue;
        }
      }

      const detector = rule.detect ? ATS_DETECTORS[rule.detect] : null;
      if (!detector) {
        result.skipped.push({
          id: rule.id,
          rule: rule.rule,
          reason: rule.detect
            ? `no detector registered for "${rule.detect}"`
            : rule.unimplemented_because || 'no detector yet',
        });
        continue;
      }
      for (const detail of detector(html, rule)) {
        result.findings.push({
          id: rule.id,
          rule: rule.rule,
          severity: rule.severity || 'warning',
          detail,
          source: rule.source || [],
        });
      }
    }
  } catch (err) {
    result.error = err?.message || String(err);
  }
  result.ok = result.findings.length === 0 && !result.error;
  return result;
}

export function loadProfileDefault(kind, { profilePath = DEFAULT_PROFILE_PATH, strict = false } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  if (!existsSync(profilePath)) return null;
  let doc;
  try {
    doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch (err) {
    if (strict) {
      throw new Error(
        `Failed to parse profile YAML at ${profilePath}. Fix the YAML syntax and retry the update. ${err?.message || err}`,
        { cause: err },
      );
    }
    return null;
  }
  let node = doc;
  for (const key of cfg.profileKey) node = node?.[key];
  return typeof node === 'string' && node.trim() ? node.trim() : null;
}

export function resolveTemplate(kind, name, opts = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  const {
    dir = DEFAULT_TEMPLATES_DIR,
    format = 'html',
    profilePath = DEFAULT_PROFILE_PATH,
    fallback = false,
  } = opts;
  assertFormat(format);

  const explicit = Boolean(name && String(name).trim());
  let chosen = kebab(explicit ? name : loadProfileDefault(kind, { profilePath }) || 'standard');
  const fileFor = (n) => (n === 'standard' ? `${cfg.prefix}.${format}` : `${cfg.prefix}.${n}.${format}`);

  const found = discover(kind, { dir, format });

  let entry = found.get(chosen);
  if (!entry && fallback && chosen !== 'standard') {
    chosen = 'standard';
    entry = found.get(chosen);
  }
  if (!entry) {
    throw new Error(`Template not found for kind=${kind} name=${chosen} (${fileFor(chosen)})`);
  }
  const path = entry.path;
  if (format === 'html') {
    const where = entry.pack ? `${entry.pack}/${fileFor(chosen)}` : fileFor(chosen);
    const v = validateTemplate(path, kind);
    if (!v.ok) {
      throw new Error(
        `Template ${where} missing required placeholders: ${v.missing.map((m) => `{{${m}}}`).join(', ')}`
      );
    }
    let sections;
    try {
      sections = checkDeclaredSections(path);
    } catch (err) {
      throw new Error(`Template ${where}: ${err.message}`);
    }
    if (sections.missing.length) {
      throw new Error(
        `Template ${where} declares sections it does not ship: `
          + sections.missing.map((n) => `sections/${n}.html`).join(', ')
          + '. A declared section must have a partial — add the file, or drop it from the manifest\'s "sections" list.'
      );
    }
  }
  return path;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const kind = argv[1];
  const flags = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
  );
  const positionals = argv.slice(2).filter((a) => !a.startsWith('--'));
  const format = flags.format || 'html';
  try {
    if (cmd === 'list') {
      const items = listTemplates(kind, { format }).map(({ name, displayName }) => ({ name, displayName }));
      process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    } else if (cmd === 'resolve') {
      const name = positionals[0];
      process.stdout.write(resolveTemplate(kind, name, { format, fallback: Boolean(flags.fallback) }) + '\n');
    } else if (cmd === 'lint') {
      if (format !== 'html') {
        throw new Error(`lint reads HTML templates only; --format=${format} would report "no findings" without checking anything`);
      }
      const name = positionals[0];
      process.stdout.write(JSON.stringify(atsLint(resolveTemplate(kind, name, { format, fallback: Boolean(flags.fallback) }), kind), null, 2) + '\n');
    } else {
      process.stderr.write('Usage: node cv-templates.mjs <list|resolve|lint> <cv|cover> [name] [--format=html|tex] [--fallback]\n');
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
