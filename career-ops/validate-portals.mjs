#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { barePrefixDomainKeywords } from './title-keywords.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  return hasText(value) || typeof value === 'number' || typeof value === 'boolean';
}

const AMAZON_FACETS = new Set([
  'normalized_country_code', 'normalized_state_name', 'normalized_city_name', 'normalized_location',
  'location', 'category', 'business_category', 'job_function_id', 'schedule_type_id',
  'employee_class', 'is_manager', 'is_intern',
]);
const AMAZON_NON_FILTERS = new Set(['sort', 'result_limit', 'offset', 'facets', 'loc_query']);

const PROVIDER_BLOCK_FILTERS = {
  amazon: (block) => Object.entries(block).some(([key, value]) => {
    if (key.endsWith('[]')) return hasValue(value);
    if (AMAZON_NON_FILTERS.has(key)) return false;
    if (AMAZON_FACETS.has(key)) return Array.isArray(value) && value.some(hasValue);
    return hasValue(value);
  }),
  ibm: (block) => hasText(block.country)
    || (Array.isArray(block.categories) && block.categories.some(hasText)),
  phenom: (block) => (hasText(block.country) && block.country !== 'global')
    || (isObject(block.selectedFields) && Object.values(block.selectedFields).some(hasValue)),
};

function add(list, path, message) {
  list.push({ path, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    add(errors, path, 'must be a string URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    add(errors, path, `invalid URL: ${value}`);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    add(errors, path, `unsupported URL protocol: ${parsed.protocol}`);
  }
}

function validateKeywordList(value, path, errors) {
  if (value === undefined || value === null) return;
  const arr = Array.isArray(value) ? value : [value];
  for (const [idx, item] of arr.entries()) {
    if (typeof item !== 'string') {
      add(errors, `${path}[${idx}]`, 'keyword must be a string');
      continue;
    }
    if (item.trim() === '') {
      add(errors, `${path}[${idx}]`, 'keyword must not be empty');
    }
  }
}

function validateParser(parser, path, errors) {
  if (parser === undefined || parser === null) return;
  if (!isObject(parser)) {
    add(errors, path, 'parser must be an object');
    return;
  }
  if (typeof parser.command !== 'string' || parser.command.trim() === '') {
    add(errors, `${path}.command`, 'parser.command must be a non-empty string');
  }
  if (parser.script !== undefined && (typeof parser.script !== 'string' || parser.script.trim() === '')) {
    add(errors, `${path}.script`, 'parser.script must be a non-empty string when set');
  }
  if (parser.args !== undefined && !Array.isArray(parser.args)) {
    add(errors, `${path}.args`, 'parser.args must be an array when set');
  }
  if (parser.timeout_ms !== undefined && (!Number.isFinite(Number(parser.timeout_ms)) || Number(parser.timeout_ms) <= 0)) {
    add(errors, `${path}.timeout_ms`, 'parser.timeout_ms must be a positive number when set');
  }
  if (parser.max_buffer_bytes !== undefined && (!Number.isFinite(Number(parser.max_buffer_bytes)) || Number(parser.max_buffer_bytes) <= 0)) {
    add(errors, `${path}.max_buffer_bytes`, 'parser.max_buffer_bytes must be a positive number when set');
  }
}

async function loadProviderIds() {
  const ids = new Set();
  if (existsSync(PROVIDERS_DIR)) {
    const files = readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
      if (mod.default?.id) ids.add(mod.default.id);
    }
  }

  try {
    const { discoverPlugins, pluginRoots, resolveSuccessorIds } = await import('./plugins/_engine.mjs');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    for (const manifest of manifests) {
      if (manifest.hooks.includes('provider')) ids.add(manifest.id);
    }
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return ids;
}

const TITLE_FILTER_FIELDS = ['positive', 'negative', 'seniority_boost'];
const FIELD_FILTER_FIELDS = ['positive', 'negative'];

export async function validatePortalsConfig(config, { providerIds = new Set() } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(config)) {
    add(errors, '<root>', 'portals config must be a YAML object');
    return { errors, warnings };
  }

  if (config.title_filter !== undefined) {
    if (!isObject(config.title_filter)) {
      add(errors, 'title_filter', 'title_filter must be an object');
    } else {
      validateKeywordList(config.title_filter.positive, 'title_filter.positive', errors);
      validateKeywordList(config.title_filter.negative, 'title_filter.negative', errors);
      validateKeywordList(config.title_filter.seniority_boost, 'title_filter.seniority_boost', errors);
    }
  }

  if (config.title_filter_full !== undefined) {
    if (!isObject(config.title_filter_full)) {
      add(errors, 'title_filter_full', 'title_filter_full must be an object');
    } else {
      for (const key of Object.keys(config.title_filter_full)) {
        if (!TITLE_FILTER_FIELDS.includes(key)) {
          add(errors, `title_filter_full.${key}`, `unknown title_filter_full field - expected one of ${TITLE_FILTER_FIELDS.join(', ')}`);
        }
      }
      validateKeywordList(config.title_filter_full.positive, 'title_filter_full.positive', errors);
      validateKeywordList(config.title_filter_full.negative, 'title_filter_full.negative', errors);
      validateKeywordList(config.title_filter_full.seniority_boost, 'title_filter_full.seniority_boost', errors);
    }
  }

  if (config.domain_filter !== undefined) {
    if (!Array.isArray(config.domain_filter)) {
      add(errors, 'domain_filter', 'domain_filter must be a list of keywords');
    } else {
      validateKeywordList(config.domain_filter, 'domain_filter', errors);
      for (const idx of barePrefixDomainKeywords(config.domain_filter)) {
        add(errors, `domain_filter[${idx}]`, 'a word:/stem: prefix needs a term after it');
      }
    }
  }

  if (config.field_filters !== undefined) {
    if (!isObject(config.field_filters)) {
      add(errors, 'field_filters', 'field_filters must be an object keyed by field name');
    } else {
      for (const [field, block] of Object.entries(config.field_filters)) {
        if (field === 'title') {
          add(errors, 'field_filters.title', 'field_filters.title is not read - filter_on: title uses the top-level title_filter');
          continue;
        }
        if (!isObject(block)) {
          add(errors, `field_filters.${field}`, `field_filters.${field} must be an object`);
          continue;
        }
        for (const key of Object.keys(block)) {
          if (!FIELD_FILTER_FIELDS.includes(key)) {
            add(errors, `field_filters.${field}.${key}`, `unknown field_filters field - expected one of ${FIELD_FILTER_FIELDS.join(', ')}`);
          }
        }
        let keywordCount = 0;
        let malformedList = false;
        for (const key of FIELD_FILTER_FIELDS) {
          const list = block[key];
          if (list === undefined || list === null) continue;
          if (!Array.isArray(list)) {
            add(errors, `field_filters.${field}.${key}`, 'must be a list of strings - a bare string is ignored');
            malformedList = true;
            continue;
          }
          validateKeywordList(list, `field_filters.${field}.${key}`, errors);
          keywordCount += list.length;
        }
        if (keywordCount === 0 && !malformedList) {
          add(errors, `field_filters.${field}`, 'no keyword in positive or negative - it would match every posting');
        }
      }
    }
  }

  if (config.location_filter !== undefined) {
    if (!isObject(config.location_filter)) {
      add(errors, 'location_filter', 'location_filter must be an object');
    } else {
      validateKeywordList(config.location_filter.always_allow, 'location_filter.always_allow', errors);
      validateKeywordList(config.location_filter.allow, 'location_filter.allow', errors);
      validateKeywordList(config.location_filter.block, 'location_filter.block', errors);
      validateKeywordList(config.location_filter.block_hard, 'location_filter.block_hard', errors);
      if (config.location_filter.strict !== undefined && typeof config.location_filter.strict !== 'boolean') {
        add(errors, 'location_filter.strict', 'must be a boolean when set');
      }
    }
  }

  if (config.content_filter !== undefined) {
    if (!isObject(config.content_filter)) {
      add(errors, 'content_filter', 'content_filter must be an object');
    } else {
      validateKeywordList(config.content_filter.positive, 'content_filter.positive', errors);
      validateKeywordList(config.content_filter.negative, 'content_filter.negative', errors);
      if (config.content_filter.by_title_keyword !== undefined) {
        if (!isObject(config.content_filter.by_title_keyword)) {
          add(errors, 'content_filter.by_title_keyword', 'by_title_keyword must be an object keyed by title_filter.positive keyword');
        } else {
          const titlePositive = new Set(
            (Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [])
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(config.content_filter.by_title_keyword)) {
            const path = `content_filter.by_title_keyword.${kw}`;
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, path, `"${kw}" does not match any title_filter.positive keyword and will never apply`);
            }
            if (!isObject(rule)) {
              add(errors, path, 'must be an object with positive/negative keyword lists');
              continue;
            }
            validateKeywordList(rule.positive, `${path}.positive`, errors);
            validateKeywordList(rule.negative, `${path}.negative`, errors);
          }
        }
      }
    }
  }

  if (config.visa_filter !== undefined) {
    if (!isObject(config.visa_filter)) {
      add(errors, 'visa_filter', 'visa_filter must be an object');
    } else {
      if (config.visa_filter.enabled !== undefined && typeof config.visa_filter.enabled !== 'boolean') {
        add(errors, 'visa_filter.enabled', 'must be a boolean when set');
      }
      if (config.visa_filter.require_mention !== undefined && typeof config.visa_filter.require_mention !== 'boolean') {
        add(errors, 'visa_filter.require_mention', 'must be a boolean when set');
      }
      validateKeywordList(config.visa_filter.positive, 'visa_filter.positive', errors);
      validateKeywordList(config.visa_filter.negative, 'visa_filter.negative', errors);
    }
  }

  if (config.search_queries !== undefined && !Array.isArray(config.search_queries)) {
    add(errors, 'search_queries', 'search_queries must be an array when set');
  }

  const seenEnabledNames = new Map();
  const validateEntryList = (list, key, noun) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      add(errors, key, `${key} must be an array when set`);
      return;
    }
    for (const [idx, entry] of list.entries()) {
      const base = `${key}[${idx}]`;
      if (!isObject(entry)) {
        add(errors, base, `${noun} entry must be an object`);
        continue;
      }
      if (entry.enabled === false) continue;

      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        add(errors, `${base}.name`, `enabled ${noun} must have a non-empty string name`);
      } else {
        const normalized = normalizeName(entry.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled ${noun} name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(entry.careers_url, `${base}.careers_url`, errors);
      validateUrl(entry.api, `${base}.api`, errors);

      if (entry.provider !== undefined) {
        if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(entry.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${entry.provider}"`);
        }
      }

      const blockFilters = typeof entry.provider === 'string' && Object.hasOwn(PROVIDER_BLOCK_FILTERS, entry.provider)
        ? PROVIDER_BLOCK_FILTERS[entry.provider]
        : null;
      if (blockFilters && entry[entry.provider] !== undefined) {
        const block = entry[entry.provider];
        if (!isObject(block) || !blockFilters(block)) {
          add(
            warnings,
            `${base}.${entry.provider}`,
            `${entry.provider} block sets no filter, so the scan reads the provider's entire board — add a location or keyword filter`
          );
        }
      }

      if (entry.filter_on !== undefined) {
        const declared = Array.isArray(entry.filter_on) ? entry.filter_on : [entry.filter_on];
        if (declared.length === 0) {
          add(errors, `${base}.filter_on`, 'filter_on must not be an empty list - omit the key to gate on title');
        }
        for (const field of declared) {
          if (typeof field !== 'string' || field.trim() === '') {
            add(errors, `${base}.filter_on`, 'filter_on must be a non-empty string or a list of them');
            continue;
          }
          const name = field.trim();
          const block = isObject(config.field_filters) && Object.hasOwn(config.field_filters, name)
            ? config.field_filters[name]
            : undefined;
          if (name !== 'title' && !isObject(block)) {
            add(errors, `${base}.filter_on`, `filter_on "${name}" has no field_filters.${name} block`);
          }
        }
      }

      validateParser(entry.parser, `${base}.parser`, errors);
    }
  };

  validateEntryList(config.tracked_companies, 'tracked_companies', 'company');
  validateEntryList(config.job_boards, 'job_boards', 'job board');

  return { errors, warnings };
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const providerIds = await loadProviderIds();
  const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
  return validatePortalsConfig(parsed, { providerIds });
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-validate-portals-self-test-'));
  try {
    const file = join(tmp, 'bad.yml');
    writeFileSync(file, `
title_filter:
  positive: ["AI", ""]
tracked_companies:
  - name: "Acme"
    provider: "not-real"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');
    const result = await validateFile(file);
    if (result.errors.length !== 2) {
      throw new Error(`expected 2 errors, got ${result.errors.length}`);
    }
    console.log('validate-portals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  const fileFlag = hasFlag(args, '--file') ? (flagValue(args, '--file') ?? '') : undefined;
  const filePath = fileFlag === undefined ? resolve(DEFAULT_PORTALS_PATH) : (fileFlag ? resolve(fileFlag) : '');
  if (!filePath) {
    console.error('Usage: node validate-portals.mjs [--file portals.yml] [--self-test]');
    process.exit(1);
  }

  let result;
  try {
    result = await validateFile(filePath);
  } catch (err) {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-portals: ${filePath}`);
  for (const warning of result.warnings) console.log(`warning: ${formatIssue(warning)}`);
  for (const error of result.errors) console.log(`error: ${formatIssue(error)}`);
  console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`validate-portals failed: ${err.message}`);
  process.exit(1);
});
