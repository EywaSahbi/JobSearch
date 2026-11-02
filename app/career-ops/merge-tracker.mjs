#!/usr/bin/env node

import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync, statSync } from 'fs';
import { join, basename, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { normalizeReportLink as normalizeLink } from './tracker-links.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { parsePdfIndex } from './find.mjs';
import { LEGACY_COLMAP, TSV_REQUIRED_FIELDS, detectColumns, isHeaderRow, resolveScoreStatus, looksLikeTsvHeaderRow, resolveTsvColumns, looksLikeScoreCell, normalizeVia, normalizeTextKey, SEPARATOR_ROW_RE, extractReqNumber, extractCellUrl, parseMarkdownLinks } from './tracker-parse.mjs';
import { atsVendorOf } from './ats-vendor.mjs';
import { LEGAL_SUFFIXES, GENERIC_DESCRIPTORS } from './invite-match.mjs';
import { resolveTrackerPath, resolveWorkspaceRoot, resolvePdfIndexPath, trackerLockDirFor, acquireTrackerLock, writeFileAtomic, normalizeCompany, cell, loadCanonicalStates, findDeadReportLink, rebuildRow } from './tracker-utils.mjs';
import { normalizeUrl, isAggregatorUrl, aggregatorPostingId } from './url-key.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { syncTrackerPdfFlags } from './sync-pdf-flags.mjs';

const MERGE_TRACKER_USAGE = `Usage: node merge-tracker.mjs [options]

Options:
  --dry-run        Preview the merge without writing files
  --verify         Run pipeline verification after a successful merge
  --migrate        Rewrite legacy report links relative to the tracker
  --migrate-via    Add the Via column to a legacy tracker
  --migrate-urls   Render the URL column as markdown links
  --backfill-urls  Add the URL column and populate it from report metadata
  -h, --help       Show this help and exit`;
const MERGE_TRACKER_KNOWN_FLAGS = ['--dry-run', '--verify', '--migrate', '--migrate-via', '--migrate-urls', '--backfill-urls', '--help', '-h'];

const CAREER_OPS_CODE_ROOT = dirname(fileURLToPath(import.meta.url));

function reportNumbersWithStatus(path, wanted) {
  const nums = new Set();
  if (!existsSync(path)) return nums;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('id\t')) continue;
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const status = cols[2];
    const reportNum = cols[5];
    if (status === wanted && reportNum && reportNum !== '-') {
      const n = /^\d+$/.test(reportNum) ? Number(reportNum) : NaN;
      if (Number.isSafeInteger(n) && n > 0) nums.add(n);
    }
  }
  return nums;
}
function loadFailedReportNumbers(path) {
  return reportNumbersWithStatus(path, 'failed');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackerUrlLabel(href) {
  return (atsVendorOf(href) ?? '').replace(/^www\./, '');
}

function isLinkedUrlCell(value) {
  return parseMarkdownLinks(value).some(l => /^<?https?:\/\//i.test(String(l.target).trim()));
}

function urlForCellDestination(href) {
  return href.replace(/\s/g, (ch) => encodeURIComponent(ch));
}

function isLinkableDestination(href) {
  if (href.includes('\\')) return false;
  let depth = 0;
  for (const ch of href) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth-- === 0) return false;
  }
  return depth === 0;
}

function formatUrlCell(raw, previousCell = '') {
  const rawValue = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  const value = cell(rawValue);
  if (!value) return '';
  const href = extractCellUrl(rawValue);

  if (!normalizeUrl(href)) return value;

  if (href.includes('|')) return cell(href);

  if (!isLinkableDestination(href)) return cell(href);

  if (isLinkedUrlCell(value)) return value;

  const destination = urlForCellDestination(href);
  const previous = String(previousCell ?? '').trim();
  if (previous && isLinkedUrlCell(previous)
      && normalizeUrl(extractCellUrl(previous)) === normalizeUrl(href)) return previous;

  const label = trackerUrlLabel(href);
  const rendered = label ? `[${label}](${destination})` : destination;
  if (normalizeUrl(extractCellUrl(rendered)) !== normalizeUrl(href)) return cell(href);
  return rendered;
}

export async function mergeTracker(options = {}) {
  const { appsFile, flags = {}, logger = globalThis.console } = options;
  if (!appsFile) throw new TypeError('mergeTracker: options.appsFile is required');
  const console = logger;

  const APPS_FILE = appsFile;
  const DATA_ROOT = options.dataRoot ?? resolveWorkspaceRoot(APPS_FILE);
  const TRACKER_DIR = dirname(APPS_FILE);
  const ADDITIONS_DIR = options.additionsDir ?? join(DATA_ROOT, 'batch/tracker-additions');
  const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
  const BATCH_STATE_FILE = options.batchStateFile ?? join(DATA_ROOT, 'batch/batch-state.tsv');
  const FAILED_REPORT_NUMBERS = loadFailedReportNumbers(BATCH_STATE_FILE);
  const COMPLETED_REPORT_NUMBERS = reportNumbersWithStatus(BATCH_STATE_FILE, 'completed');
  const DRY_RUN = Boolean(flags.dryRun);
  const VERIFY = Boolean(flags.verify);
  const MIGRATE = Boolean(flags.migrate);
  const MIGRATE_VIA = Boolean(flags.migrateVia);
  const MIGRATE_URLS = Boolean(flags.migrateUrls);
  const BACKFILL_URLS = Boolean(flags.backfillUrls);
  const MERGE_HOLD_MS = options.holdMs || 0;
  const MERGE_READY_IPC = Boolean(options.readyIpc);

  const TRACKER_LOCK_DIR = options.lockDir ?? trackerLockDirFor(APPS_FILE);

  const REPORTS_ROOT = resolveWorkspaceRoot(APPS_FILE);
  const PDF_INDEX_FILE = options.pdfIndexFile ?? join(REPORTS_ROOT, 'data', 'pdf-index.tsv');
  const CHILD_ENV = options.childEnv
    ?? { ...process.env, CAREER_OPS_TRACKER: APPS_FILE, CAREER_OPS_PDF_INDEX: PDF_INDEX_FILE };

  const normalizeReportLink = (reportField) => normalizeLink(reportField, TRACKER_DIR, REPORTS_ROOT);

  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
  mkdirSync(ADDITIONS_DIR, { recursive: true });
  const _CODE_ROOT = dirname(fileURLToPath(import.meta.url));
  const _STATES_FILE = existsSync(join(_CODE_ROOT, 'templates/states.yml'))
    ? join(_CODE_ROOT, 'templates/states.yml')
    : join(_CODE_ROOT, 'states.yml');
  let _canonicalStates = [];
  try {
    _canonicalStates = loadCanonicalStates(_STATES_FILE);
  } catch (err) {
    console.warn(`⚠️  Cannot read canonical states (${err.message}): statuses are merged as written. Restore templates/states.yml, then run node normalize-statuses.mjs`);
  }
  const _aliasMap = Object.fromEntries(
    _canonicalStates.flatMap(s => s.aliases.map(a => [a.toLowerCase(), s.label]))
  );

  function validateStatus(status) {
    const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
    const lower = clean.toLowerCase();

    for (const s of _canonicalStates) {
      if (s.label.toLowerCase() === lower) return s.label;
    }

    if (_aliasMap[lower]) return _aliasMap[lower];

    if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

    if (!_canonicalStates.length && clean) return clean;

    console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
    return 'Evaluated';
  }

  function extractReportNum(reportStr, notesStr = '') {
    const m = String(reportStr ?? '').match(/\[(\d+)\]/);
    if (m) return parseInt(m[1]);
    const n = String(notesStr ?? '').match(/\[(\d+)\]\([^)]*reports\/[^)]+\)/);
    return n ? parseInt(n[1]) : null;
  }

  function resolveReportPath(reportField) {
    const linkMatch = (reportField || '').match(/\]\(([^)]+)\)/);
    if (!linkMatch) return null;
    const reportPath = resolve(REPORTS_ROOT, linkMatch[1].trim().replace(/^(\.\.\/)+/, ''));
    if (!reportPath.startsWith(REPORTS_ROOT + sep)) return null;
    if (!existsSync(reportPath) || !statSync(reportPath).isFile()) return null;
    return reportPath;
  }

  function resolveReportUrl(reportField) {
    const reportPath = resolveReportPath(reportField);
    if (!reportPath) return { url: '', reason: 'no-report' };
    const m = readFileSync(reportPath, 'utf-8').match(/\*\*URL:\*\*[ \t]*(\S+)/);
    if (!m) return { url: '', reason: 'no-url' };
    const raw = m[1].replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
    return normalizeUrl(raw) ? { url: raw, reason: 'ok' } : { url: '', reason: 'no-url' };
  }

  function companiesMatch(a, b) {
    const key = normalizeCompany(String(a));
    if (key !== normalizeCompany(String(b))) return false;
    return key !== '' || String(a).trim() === String(b).trim();
  }

  const CORPORATE_FORM_WORDS = new Set([...LEGAL_SUFFIXES, ...GENERIC_DESCRIPTORS]);

  const MIN_STEM_CHARS = 3;

  function companiesMatchIgnoringCorporateForm(a, b) {
    const ta = normalizeTextKey(a, ' ').split(' ').filter(Boolean);
    const tb = normalizeTextKey(b, ' ').split(' ').filter(Boolean);
    const [stem, full] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (stem.length === 0 || stem.length === full.length) return false;
    if (stem.join('').length < MIN_STEM_CHARS) return false;
    if (stem.some((token, i) => token !== full[i])) return false;
    return full.slice(stem.length).every(token => CORPORATE_FORM_WORDS.has(token));
  }

  function mergeNotes(existingNotes, addition, oldScore, newScore, extraMarker = '') {
    const prevRaw = String(existingNotes ?? '').trim();
    const prev = ['—', '-', 'N/A'].includes(prevRaw)
      ? ''
      : prevRaw.replace(/\s*\.\s*$/, '');
    const incoming = String(addition.notes ?? '').trim();
    const marker = extraMarker
      ? `Re-eval ${addition.date} (${oldScore}→${newScore}) — ${extraMarker}`
      : `Re-eval ${addition.date} (${oldScore}→${newScore})`;
    const clause = (s) => s.replace(/\.+$/, '').trim();
    const incomingClause = clause(incoming);
    const isRepeat = incoming !== '' && prev.split(/\.\s+/).map(clause)
      .some(c => c === incomingClause || c.endsWith(`: ${incomingClause}`));
    const tail = incoming && !isRepeat ? `${marker}: ${incoming}` : marker;
    return prev ? `${prev}. ${tail}` : tail;
  }

  function parseScore(s) {
    const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function isUnscoreable(s) {
    return ['—', '-', 'N/A'].includes(String(s).replace(/\*\*/g, '').trim());
  }

  function loadPdfIndex() {
    return existsSync(PDF_INDEX_FILE)
      ? parsePdfIndex(readFileSync(PDF_INDEX_FILE, 'utf-8'))
      : new Map();
  }

  function syncPdfFlags(existingApps, appLines, pdfIndex) {
    let changed = 0;
    if (pdfIndex.size === 0) return changed;

    for (const app of existingApps) {
      const reportNum = extractReportNum(app.report, app.notes);
      if (!reportNum || !pdfIndex.has(String(reportNum)) || app.pdf !== '❌') continue;

      const lineIdx = appLines.indexOf(app.raw);
      if (lineIdx < 0) continue;

      console.log(`${DRY_RUN ? '🔄 PDF sync (dry-run)' : '🔄 PDF sync'}: #${app.num} ${app.company} — report ${reportNum} now has a generated PDF`);
      if (!DRY_RUN) {
        const updatedLine = buildRow({ ...app, pdf: '✅' });
        appLines[lineIdx] = updatedLine;
        app.pdf = '✅';
        app.raw = updatedLine;
      }
      changed++;
    }

    return changed;
  }

  let COLMAP = LEGACY_COLMAP;

  let HEADER_WIDTH = null;

  function appendTrailingTableCell(line, value = '', separator = false) {
    const eol = line.endsWith('\r') ? '\r' : '';
    const body = eol ? line.slice(0, -1) : line;
    const match = body.match(/^(.*\|)([ \t]*)$/);
    if (!match) return null;
    const cellText = separator ? '-----' : value ? ` ${value} ` : ' ';
    return `${match[1]}${cellText}|${match[2]}${eol}`;
  }

  function addMissingUrlColumn(lines) {
    const headerIdx = lines.findIndex(line => isHeaderRow(line));
    if (headerIdx < 0) return { added: false, reason: 'no recognizable header row' };

    const currentMap = detectColumns(lines);
    if (currentMap?.url != null) return { added: false };

    const separatorIdx = headerIdx + 1;
    if (!SEPARATOR_ROW_RE.test(lines[separatorIdx] || '')) {
      return { added: false, reason: 'no separator row directly after the tracker header' };
    }

    const expectedCellCount = lines[headerIdx].split('|').length;
    if (lines[separatorIdx].split('|').length !== expectedCellCount) {
      return { added: false, reason: `table separator row ${separatorIdx + 1} has the wrong number of cells` };
    }

    const widenedHeader = appendTrailingTableCell(lines[headerIdx], 'URL');
    const widenedSeparator = appendTrailingTableCell(lines[separatorIdx], '', true);
    if (widenedHeader == null || widenedSeparator == null) {
      return { added: false, reason: 'the tracker table is missing a closing pipe' };
    }

    const widenedRows = [];
    for (let i = separatorIdx + 1; i < lines.length && lines[i].startsWith('|'); i++) {
      const widened = appendTrailingTableCell(lines[i]);
      if (widened == null) return { added: false, reason: `table row ${i + 1} is missing a closing pipe` };
      if (lines[i].split('|').length !== expectedCellCount) {
        return { added: false, reason: `table row ${i + 1} has the wrong number of cells` };
      }
      widenedRows.push([i, widened]);
    }

    lines[headerIdx] = widenedHeader;
    lines[separatorIdx] = widenedSeparator;
    for (const [i, widened] of widenedRows) lines[i] = widened;
    return { added: true };
  }

  function buildRow(o) {
    const width = HEADER_WIDTH ?? (Math.max(...Object.values(COLMAP)) + 2);
    const cells = new Array(Math.max(0, width - 2)).fill('—');
    if (o.raw) {
      const prev = String(o.raw).split('|').map(s => s.trim());
      for (let i = 0; i < cells.length; i++) {
        if (prev[i + 1] !== undefined) cells[i] = prev[i + 1];
      }
    }
    const put = (key, value) => {
      const idx = COLMAP[key];
      if (idx == null) return false;
      const at = idx - 1;
      if (at < 0 || at >= cells.length) return false;
      cells[at] = value;
      return true;
    };

    put('num', o.num);
    put('date', o.date);
    put('company', cell(o.company));
    put('via', cell(o.via) || '—');
    put('role', cell(o.role));
    put('location', cell(o.location) || '—');
    put('score', o.score);
    put('status', o.status);
    put('pdf', o.pdf);
    const prevUrlCell = COLMAP.url != null ? (cells[COLMAP.url - 1] ?? '') : '';
    put('url', formatUrlCell(o.url, prevUrlCell));

    let notes = cell(o.notes);
    if (!put('report', o.report) && o.report && String(o.report).trim() !== '—') {
      const link = String(o.report).trim();
      if (notes && !notes.includes(link)) notes = `${notes.replace(/\s*$/, '')} Report: ${link}.`;
      else if (!notes) notes = `Report: ${link}.`;
    }
    put('notes', notes);

    return `| ${cells.join(' | ')} |`;
  }

  function buildHeaderRows() {
    const labels = ['#', 'Date', 'Company'];
    if (COLMAP.via != null) labels.push('Via');
    labels.push('Role');
    if (COLMAP.location != null) labels.push('Location');
    labels.push('Score', 'Status', 'PDF', 'Report', 'Notes');
    return {
      header: `| ${labels.join(' | ')} |`,
      separator: `|${labels.map((l) => '-'.repeat(Math.max(3, l.length + 2))).join('|')}|`,
    };
  }

  function parseAppLine(line) {
    const parts = line.split('|').map(s => s.trim());
    const maxIdx = Math.max(...Object.values(COLMAP));
    if (parts.length <= maxIdx) return null;
    const num = parseInt(parts[COLMAP.num]);
    if (isNaN(num) || num === 0) return null;
    return {
      num,
      date: parts[COLMAP.date],
      company: parts[COLMAP.company],
      via: COLMAP.via != null ? parts[COLMAP.via] : '',
      role: parts[COLMAP.role],
      location: COLMAP.location != null ? parts[COLMAP.location] : '',
      score: parts[COLMAP.score],
      status: parts[COLMAP.status],
      pdf: COLMAP.pdf != null ? (parts[COLMAP.pdf] ?? '') : '',
      report: COLMAP.report != null ? (parts[COLMAP.report] ?? '') : '',
      notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
      url: COLMAP.url != null ? extractCellUrl(parts[COLMAP.url] || '') : '',
      raw: line,
    };
  }

  const PLACEHOLDER_CELL = /^(n\/?a|tbd|none|null|-|—|–)$/i;

  function splitAdditionCells(line) {
    if (line.startsWith('|')) {
      const parts = line.split('|').map(s => s.trim());
      if (parts[0] === '') parts.shift();
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      return parts;
    }
    return line.split('\t').map(s => s.trim());
  }

  function parseTsvExtras(parts, filename) {
    const extras = parts.slice(9)
      .map(s => String(s).trim())
      .filter(s => s !== '' && !PLACEHOLDER_CELL.test(s));
    const viaTags = extras.filter(s => /^via=/i.test(s));
    const urls = extras.filter(s => !/^via=/i.test(s) && /^https?:\/\//i.test(s));
    const untagged = extras.filter(s => !/^via=/i.test(s) && !/^https?:\/\//i.test(s));
    if (viaTags.length > 1 || untagged.length > 1 || urls.length > 1) {
      console.warn(`⚠️  Skipping ${filename}: ambiguous extra fields [${extras.join(', ')}] — expected at most one "via=Firm" tag, one location and one URL`);
      return null;
    }
    return {
      via: viaTags.length ? viaTags[0].replace(/^via=/i, '').trim() : '',
      location: untagged[0] || '',
      url: urls[0] || '',
    };
  }

  function parseTrackerNum(text) {
    const t = String(text ?? '').trim();
    if (!/^0*[1-9]\d*$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }

  function parseHeadedAddition(lines, filename) {
    const { map, missing, duplicates, unknown } = resolveTsvColumns(splitAdditionCells(lines[0]));
    if (duplicates.length) {
      console.warn(`⚠️  Skipping ${filename}: header labels the same column twice (${[...new Set(duplicates)].join(', ')}) — refusing to guess which one carries the value`);
      return null;
    }
    if (missing.length) {
      console.warn(`⚠️  Skipping ${filename}: header is missing required column(s): ${missing.join(', ')}`);
      return null;
    }
    if (unknown.length) {
      console.warn(`⚠️  ${filename}: ignoring unrecognized header column(s): ${unknown.join(', ')}`);
    }

    const dataLines = lines.slice(1);
    if (dataLines.length === 0) {
      console.warn(`⚠️  Skipping ${filename}: header row with no data row`);
      return null;
    }
    if (dataLines.length > 1) {
      console.warn(`⚠️  Skipping ${filename}: ${dataLines.length} data rows — one addition per file`);
      return null;
    }

    const parts = splitAdditionCells(dataLines[0]);
    const shortLabels = Object.entries(map).filter(([, i]) => i >= parts.length).map(([k]) => k);
    const missingRequiredCells = shortLabels.filter(k => TSV_REQUIRED_FIELDS.includes(k));
    if (missingRequiredCells.length) {
      console.warn(`⚠️  Skipping ${filename}: data row has ${parts.length} field(s), missing the required cell(s): ${missingRequiredCells.join(', ')}`);
      return null;
    }

    const at = (k) => (map[k] != null ? String(parts[map[k]] ?? '').trim() : '');
    const optional = (k) => {
      const v = at(k);
      return PLACEHOLDER_CELL.test(v) ? '' : v;
    };

    const blankRequiredCells = TSV_REQUIRED_FIELDS.filter(k => at(k) === '');
    if (blankRequiredCells.length) {
      console.warn(`⚠️  Skipping ${filename}: required cell(s) present but empty: ${blankRequiredCells.join(', ')} — use the documented sentinel (— / N/A) rather than a blank cell`);
      return null;
    }

    if (map.url != null && shortLabels.includes('url')) {
      const misplacedUrl = Object.entries(map)
        .filter(([k, i]) => k !== 'url' && i < parts.length && /^https?:\/\/\S*$/i.test(String(parts[i] ?? '').trim()))
        .map(([k]) => k);
      if (misplacedUrl.length) {
        console.warn(`⚠️  Skipping ${filename}: a URL sits under "${misplacedUrl.join('", "')}" while the "url" cell is absent — the optional cells are shifted; write an empty cell for each optional value you omit`);
        return null;
      }
    }

    const score = at('score').replace(/\*\*/g, '').trim();
    if (!looksLikeScoreCell(score)) {
      console.warn(`⚠️  Skipping ${filename}: the column labelled "score" reads "${score}", which is not a score or a documented sentinel (X.X/5, N/A, —, -) — check the header labels match the value order`);
      return null;
    }

    return {
      num: parseTrackerNum(at('num')),
      date: at('date'),
      company: at('company'),
      role: at('role'),
      status: validateStatus(at('status')),
      score,
      pdf: at('pdf'),
      report: at('report'),
      notes: optional('notes'),
      via: optional('via').replace(/^via=/i, '').trim(),
      location: optional('location'),
      url: optional('url'),
    };
  }

  function parseTsvContent(content, filename) {
    const rawLines = String(content ?? '').split(/\r?\n/).filter(l => l.trim() !== '');
    content = String(content ?? '').trim();
    if (!content) return null;

    if (looksLikeTsvHeaderRow(splitAdditionCells(rawLines[0]))) {
      const headed = parseHeadedAddition(rawLines, filename);
      if (!headed) return null;
      if (!Number.isSafeInteger(headed.num) || headed.num <= 0) {
        console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
        return null;
      }
      return headed;
    }

    let parts;
    let addition;

    if (content.startsWith('|')) {
      parts = content.split('|').map(s => s.trim());
      if (parts[0] === '') parts.shift();
      if (parts[parts.length - 1] === '') parts.pop();
      if (parts.length < 8) {
        console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
        return null;
      }
      const resolved = resolveScoreStatus(parts[4], parts[5]);
      if (!resolved) {
        console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4]}" | "${parts[5]}") — refusing to merge a possible column swap`);
        return null;
      }
      addition = {
        num: parseTrackerNum(parts[0]),
        date: parts[1],
        company: parts[2],
        role: parts[3],
        score: resolved.score.replace(/\*\*/g, '').trim(),
        status: validateStatus(resolved.status),
        pdf: parts[6],
        report: parts[7],
        notes: parts[8] || '',
      };
      const extras = parseTsvExtras(parts, filename);
      if (!extras) return null;
      Object.assign(addition, extras);
    } else {
      parts = content.split('\t');
      if (parts.length < 8) {
        console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
        return null;
      }

      const resolved = resolveScoreStatus(parts[4].trim(), parts[5].trim());
      if (!resolved) {
        console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4].trim()}" | "${parts[5].trim()}") — refusing to merge a possible column swap`);
        return null;
      }

      addition = {
        num: parseTrackerNum(parts[0]),
        date: parts[1],
        company: parts[2],
        role: parts[3],
        status: validateStatus(resolved.status),
        score: resolved.score.replace(/\*\*/g, '').trim(),
        pdf: parts[6],
        report: parts[7],
        notes: parts[8] || '',
      };
      const extras = parseTsvExtras(parts, filename);
      if (!extras) return null;
      Object.assign(addition, extras);
    }

    if (!Number.isSafeInteger(addition.num) || addition.num <= 0) {
      console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
      return null;
    }

    return addition;
  }

  let trackerLock;
  try {
    trackerLock = await acquireTrackerLock(TRACKER_LOCK_DIR, {
      timeoutMs: options.lock?.timeoutMs || 60_000,
      retryMs: options.lock?.retryMs || 75,
      staleMs: options.lock?.staleMs || 10 * 60_000,
      tracker: APPS_FILE,
    });
    if (trackerLock.waitMs > 0 || trackerLock.staleRecovered) {
      console.log(`🔒 Tracker merge lock acquired (wait_ms=${trackerLock.waitMs} | attempts=${trackerLock.attempts} | stale_recovered=${trackerLock.staleRecovered})`);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
  try {
    return await mergeUnderLock();
  } finally {
    trackerLock.release();
  }

  async function mergeUnderLock() {
    if (!existsSync(APPS_FILE)) {
      console.log('No applications.md found. Nothing to merge into.');
      return 0;
    }
    const appContent = readFileSync(APPS_FILE, 'utf-8');
    if (MERGE_READY_IPC && typeof process.send === 'function') {
      process.send({ type: 'merge-tracker-ready' });
    }
    if (MERGE_HOLD_MS > 0) {
      await sleep(MERGE_HOLD_MS);
    }

    if (MIGRATE) {
      const migrated = appContent
        .split('\n')
        .map(line => (line.startsWith('|') ? normalizeReportLink(line) : line));
      const before = appContent.split('\n');
      const changed = migrated.filter((l, i) => l !== before[i]).length;

      if (DRY_RUN) {
        console.log(`🔎 Migration (dry-run): ${changed} row(s) would be rewritten in ${basename(APPS_FILE)}`);
      } else {
        writeFileAtomic(APPS_FILE, migrated.join('\n'));
        console.log(`✅ Migration: rewrote ${changed} report link(s) in ${basename(APPS_FILE)} relative to ${TRACKER_DIR === DATA_ROOT ? 'repo root' : 'data/'}`);
      }
      return 0;
    }

    if (MIGRATE_VIA) {
      const lines = appContent.split('\n');
      const colmap = detectColumns(lines) || LEGACY_COLMAP;
      if (colmap.via != null) {
        console.log('✅ Via column already present — nothing to migrate.');
        return 0;
      }
      const companyIdx = colmap.company;
      let changed = 0;
      const migrated = lines.map(line => {
        if (!line.startsWith('|')) return line;
        const parts = line.split('|').map(s => s.trim());
        if (parts.length <= companyIdx) return line;
        const isHeader = parts[colmap.num] === '#';
        const isSeparator = /^[-: ]*$/.test(parts.join(''));
        const insert = isHeader ? 'Via' : isSeparator ? '-----' : '—';
        const cells = [...parts.slice(1, companyIdx + 1), insert, ...parts.slice(companyIdx + 1, parts.length - 1)];
        changed++;
        return isSeparator
          ? `|${cells.map(c => c || '---').join('|')}|`
          : `| ${cells.join(' | ')} |`;
      });
      if (DRY_RUN) {
        console.log(`🔎 Migration (dry-run): Via column would be inserted after Company (${changed} table line(s) rewritten)`);
      } else {
        writeFileAtomic(APPS_FILE, migrated.join('\n'));
        console.log(`✅ Migration: inserted Via column after Company (${changed} table line(s) rewritten). Direct applications are marked —.`);
      }
      return 0;
    }

    if (MIGRATE_URLS) {
      const lines = appContent.split('\n');
      const colmap = detectColumns(lines) || LEGACY_COLMAP;
      if (colmap.url == null) {
        console.error('❌ --migrate-urls: this tracker has no URL column. Add a `URL` header column first (additive), then re-run.');
        return 1;
      }
      const cellCount = (line) => {
        const parts = line.split('|');
        return parts.length - 1 - (line.trimEnd().endsWith('|') ? 1 : 0);
      };
      const headerLine = lines.find(line => isHeaderRow(line));
      const headerCells = headerLine ? cellCount(headerLine) : null;
      let changed = 0;
      const skipped = [];
      const migrated = lines.map((line, i) => {
        if (!line.startsWith('|')) return line;
        if (isHeaderRow(line) || SEPARATOR_ROW_RE.test(line)) return line;
        if (headerCells != null && cellCount(line) !== headerCells) {
          skipped.push(i + 1);
          return line;
        }
        const parts = line.split('|').map(s => s.trim());
        if (parts.length <= colmap.url) return line;
        const before = parts[colmap.url];
        const after = formatUrlCell(before);
        if (after === before) return line;
        parts[colmap.url] = after;
        changed++;
        return rebuildRow(parts);
      });
      const skippedNote = skipped.length
        ? ` Left ${skipped.length} row(s) untouched because their cell count does not match the header — usually a \`|\` inside a URL: line(s) ${skipped.join(', ')}. Fix those by hand (a URL may not contain a literal \`|\`), then re-run.`
        : '';
      if (DRY_RUN) {
        console.log(`🔎 Migration (dry-run): ${changed} URL cell(s) would be rendered as markdown links in ${basename(APPS_FILE)}.${skippedNote}`);
      } else {
        writeFileAtomic(APPS_FILE, migrated.join('\n'));
        console.log(`✅ Migration: rendered ${changed} URL cell(s) as markdown links in ${basename(APPS_FILE)}. Every row's dedup key is unchanged (verified per cell).${skippedNote}`);
      }
      return 0;
    }

    function sortTrackerRowsInPlace(lines) {
      let sepIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (SEPARATOR_ROW_RE.test(lines[i])) { sepIdx = i; break; }
      }
      if (sepIdx < 0) return 0;
      let end = sepIdx + 1;
      while (end < lines.length && lines[end].startsWith('|')) end++;
      const block = lines.slice(sepIdx + 1, end);
      if (block.length < 2) return 0;
      const numOf = (line) => {
        const parts = line.split('|').map(s => s.trim());
        const n = parseInt(parts[COLMAP.num], 10);
        return Number.isNaN(n) ? null : n;
      };
      const decorated = block.map((line, i) => ({ line, i, num: numOf(line) }));
      decorated.sort((a, b) => {
        if (a.num === null || b.num === null) {
          if (a.num === b.num) return a.i - b.i;
          return a.num === null ? 1 : -1;
        }
        return a.num === b.num ? a.i - b.i : a.num - b.num;
      });
      const sorted = decorated.map(d => d.line);
      let moved = 0;
      for (let i = 0; i < sorted.length; i++) if (sorted[i] !== block[i]) moved++;
      lines.splice(sepIdx + 1, block.length, ...sorted);
      return moved;
    }

    const appLines = appContent.split('\n');
    let urlColumnAdded = false;
    if (BACKFILL_URLS) {
      const migration = addMissingUrlColumn(appLines);
      if (migration.reason) {
        console.error(`❌ --backfill-urls: cannot add the URL column safely (${migration.reason}).`);
        trackerLock.release();
        return 1;
      }
      urlColumnAdded = migration.added;
    }
    COLMAP = detectColumns(appLines) || LEGACY_COLMAP;
    HEADER_WIDTH = (() => {
      for (const line of appLines) {
        if (line.startsWith('|') && isHeaderRow(line)) return line.split('|').length;
      }
      return null;
    })();
    if (COLMAP.location != null) console.log('🧭 Detected Location column.');
    if (COLMAP.via != null) console.log('🧭 Detected Via column.');
    if (COLMAP.url != null) console.log('🧭 Detected URL column (deterministic dedup active).');
    if (HEADER_WIDTH != null && HEADER_WIDTH - 2 > Object.keys(COLMAP).length) {
      console.log(
        `🧭 Header has ${HEADER_WIDTH - 2} columns; ${HEADER_WIDTH - 2 - Object.keys(COLMAP).length} ` +
        'not mapped to a career-ops field — those cells are written as "—".',
      );
    }
    const existingApps = [];
    let maxNum = 0;

    for (const line of appLines) {
      if (!line.startsWith('|')) continue;
      const app = parseAppLine(line);
      if (app) {
        existingApps.push(app);
        if (app.num > maxNum) maxNum = app.num;
      }
    }

    if (BACKFILL_URLS) {
      if (COLMAP.url == null) {
        console.error('❌ --backfill-urls: could not detect a URL column after migration.');
        trackerLock.release();
        return 1;
      }
      let filled = 0, noReport = 0, noUrl = 0, already = 0;
      const backfilled = appLines.map(line => {
        if (!line.startsWith('|')) return line;
        const app = parseAppLine(line);
        if (!app) return line;
        if ((app.url || '').trim()) { already++; return buildRow({ ...app }); }
        const resolved = resolveReportUrl(app.report);
        if (resolved.reason === 'no-report') { noReport++; return buildRow({ ...app, url: '' }); }
        if (resolved.reason === 'no-url') { noUrl++; return buildRow({ ...app, url: '' }); }
        filled++;
        return buildRow({ ...app, url: resolved.url });
      });
      const summary = `${filled} filled, ${already} already set, ${noReport} no/missing report, ${noUrl} report has no **URL:**`;
      if (DRY_RUN) {
        const action = urlColumnAdded
          ? `would add the URL column and fill ${filled} row(s)`
          : `would fill ${filled} row(s)`;
        console.log(`🔎 Backfill URLs (dry-run): ${action}. (${summary})`);
      } else {
        writeFileAtomic(APPS_FILE, backfilled.join('\n'));
        console.log(`✅ Backfill URLs: ${urlColumnAdded ? 'added the URL column; ' : ''}${summary}.`);
      }
      trackerLock.release();
      return 0;
    }
    const usedNumbers = new Set();
    const MAX_COL_IDX = Math.max(...Object.values(COLMAP));
    for (const line of appLines) {
      if (!line.startsWith('|')) continue;
      const parts = line.split('|').map(s => s.trim());
      if (parts.length <= MAX_COL_IDX) continue;
      const n = parseInt(parts[COLMAP.num]);
      if (!isNaN(n) && n !== 0) {
        usedNumbers.add(n);
        if (n > maxNum) maxNum = n;
      }
    }

    console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let missingReports = 0;
    const pdfIndex = loadPdfIndex();
    const pdfSynced = syncPdfFlags(existingApps, appLines, pdfIndex);
    updated += pdfSynced;

    if (!existsSync(ADDITIONS_DIR)) {
      console.log('No tracker-additions directory found.');
      const moved = DRY_RUN ? 0 : sortTrackerRowsInPlace(appLines);
      if (moved > 0) console.log(`🔢 Sorted tracker by # ascending (${moved} row(s) repositioned).`);
      if ((pdfSynced > 0 || moved > 0) && !DRY_RUN) writeFileAtomic(APPS_FILE, appLines.join('\n'));
      if (DRY_RUN) console.log('(dry-run — no changes written)');
      trackerLock.release();
      return 0;
    }

    const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
    if (tsvFiles.length === 0) {
      console.log('✅ No pending additions to merge.');
      const moved = DRY_RUN ? 0 : sortTrackerRowsInPlace(appLines);
      if (moved > 0) console.log(`🔢 Sorted tracker by # ascending (${moved} row(s) repositioned).`);
      if ((pdfSynced > 0 || moved > 0) && !DRY_RUN) writeFileAtomic(APPS_FILE, appLines.join('\n'));
      if (DRY_RUN) console.log('(dry-run — no changes written)');
      trackerLock.release();
      return 0;
    }

    tsvFiles.sort((a, b) => {
      const numA = parseInt(/^(\d+)/.exec(a)?.[1] ?? '', 10) || 0;
      const numB = parseInt(/^(\d+)/.exec(b)?.[1] ?? '', 10) || 0;
      return numA - numB;
    });

    console.log(`📥 Found ${tsvFiles.length} pending additions`);

    let warnedNoUrlCol = false;
    const newLines = [];
    const failedAdditions = [];

    function replaceTrackerLine(oldLine, updatedLine) {
      const idx = appLines.indexOf(oldLine);
      if (idx >= 0) {
        appLines[idx] = updatedLine;
        return true;
      }
      const pendingIdx = newLines.indexOf(oldLine);
      if (pendingIdx >= 0) {
        newLines[pendingIdx] = updatedLine;
        return true;
      }
      return false;
    }

    for (const file of tsvFiles) {
      const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8');
      const addition = parseTsvContent(content, file);
      if (!addition) { skipped++; continue; }

      if (addition.via && COLMAP.via == null) {
        console.warn(`⚠️  ${file}: carries via=${addition.via} but the tracker has no Via column — value dropped. Add it with: node merge-tracker.mjs --migrate-via`);
        addition.via = '';
      }

      if (addition.url && COLMAP.url == null && !warnedNoUrlCol) {
        console.warn('⚠️  Additions carry a URL but this tracker has no URL column — URL dedup is INACTIVE (fuzzy fallback). Add a `URL` header column to enable it.');
        warnedNoUrlCol = true;
      }

      addition.report = normalizeReportLink(addition.report);

      if (!addition.url) addition.url = resolveReportUrl(addition.report).url;

      const reportNum = extractReportNum(addition.report, addition.notes);

      if (reportNum && FAILED_REPORT_NUMBERS.has(reportNum)) {
        console.warn(`⚠️  Skipping ${file}: report #${reportNum} is marked "failed" in batch-state.tsv — refusing to merge a tracker line for an offer the batch runner itself recorded as failed (possible fabricated result)`);
        if (COMPLETED_REPORT_NUMBERS.has(reportNum)) {
          console.warn(`   batch-state.tsv also has a "completed" row for #${reportNum}: the number was likely reused after a failure by an older batch runner. If this report is the completed offer's, set report_num to "-" on the failed row and re-run.`);
        }
        skipped++;
        continue;
      }

      const deadLink = findDeadReportLink(addition.report, TRACKER_DIR, DATA_ROOT);
      if (deadLink !== null) {
        const linked = deadLink.trim();
        console.warn(`⚠️  ${file}: ${addition.company} — ${addition.role}: report link "${linked}" does not resolve to a file (checked from ${TRACKER_DIR} and ${DATA_ROOT}) — the row is not rewritten; verify-pipeline will flag it until the report exists`);
        missingReports++;
      }

      let duplicate = null;
      let reportNumMatched = false;

      const addUrl = normalizeUrl(addition.url);
      let dupReason = null;
      if (addUrl) {
        duplicate = existingApps.find(a => a.url && normalizeUrl(a.url) === addUrl);
        if (duplicate) dupReason = 'url';
      }

      const urlDiffers = (cand) => {
        const candUrl = normalizeUrl(cand.url);
        if (!candUrl || !addUrl) return false;
        if (isAggregatorUrl(cand.url) || isAggregatorUrl(addition.url)) {
          const candId = aggregatorPostingId(cand.url);
          const addId = aggregatorPostingId(addition.url);
          return Boolean(candId && addId && candId.domain === addId.domain && candId.id !== addId.id);
        }
        return candUrl !== addUrl;
      };

      const urlBlocksHeuristic = (cand) => {
        if (urlDiffers(cand)) return true;
        return Boolean(normalizeUrl(cand.url)) && !addUrl;
      };

      const additionReqNum = extractReqNumber(addition.notes);
      const reqNumDiffers = (cand) => {
        const appReqNum = extractReqNumber(cand.notes);
        return Boolean(additionReqNum && appReqNum && additionReqNum !== appReqNum);
      };

      if (!duplicate) {
        const addPath = resolveReportPath(addition.report);
        if (addPath) {
          duplicate = existingApps.find(app => !urlDiffers(app) && resolveReportPath(app.report) === addPath);
          if (duplicate) { dupReason = 'report-file'; reportNumMatched = true; }
        }
      }

      if (!duplicate && reportNum) {
        duplicate = existingApps.find(app => {
          if (urlDiffers(app)) return false;
          const existingReportNum = extractReportNum(app.report, app.notes);
          return existingReportNum === reportNum && companiesMatch(app.company, addition.company);
        });
        if (duplicate) reportNumMatched = true;
      }

      if (!duplicate) {
        duplicate = existingApps.find(app =>
          !urlBlocksHeuristic(app) && app.num === addition.num && companiesMatch(app.company, addition.company)
          && !reqNumDiffers(app)
          && (!app.addedThisRun || roleFuzzyMatch(addition.role, app.role))
        );
      }

      if (!duplicate) {
        const fuzzyTierMatch = (app, widenToCorporateForm) => {
          if (urlBlocksHeuristic(app)) return false;
          if (!companiesMatch(app.company, addition.company)
              && !(widenToCorporateForm && companiesMatchIgnoringCorporateForm(app.company, addition.company))) return false;
          if (!roleFuzzyMatch(addition.role, app.role)) return false;
          if (COLMAP.via != null
              && (String(addition.company).trim() === '?' || String(app.company).trim() === '?')) {
            const additionVia = normalizeVia(addition.via || '');
            const appVia = normalizeVia(app.via || '');
            if (!additionVia || !appVia || additionVia !== appVia) return false;
          }
          if (COLMAP.via == null
              && (String(addition.company).trim() === '?' || String(app.company).trim() === '?')
              && normalizeVia(addition.via || '') !== normalizeVia(app.via || '')) return false;
          const appReqNum = extractReqNumber(app.notes);
          if (reqNumDiffers(app)) return false;
          if (additionReqNum && !appReqNum) return false;
          return true;
        };
        duplicate = existingApps.find(app => fuzzyTierMatch(app, false))
          || existingApps.find(app => fuzzyTierMatch(app, true));
      }

      if (duplicate) {
        if (isUnscoreable(addition.score) && !isUnscoreable(duplicate.score)) {
          console.log(
            `⏭️  Skipping ${file}: re-eval of #${duplicate.num} ${addition.company} — `
            + `${addition.role} produced no score (${String(addition.score).trim()}); `
            + `keeping ${duplicate.score}`,
          );
          skipped++;
          continue;
        }
        const newScore = parseScore(addition.score);
        const oldScore = parseScore(duplicate.score);

        const downgrade = newScore < oldScore;
        const oldReportNum = extractReportNum(duplicate.report, duplicate.notes);
        const supersededNote = downgrade && oldReportNum && oldReportNum !== reportNum
          ? `Superseded report [${oldReportNum}] (was ${oldScore}/5)`
          : '';

        console.log(
          `${downgrade ? '🔽' : '🔄'} Update: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`
          + (downgrade ? ' — DOWNGRADE, re-eval scored lower' : ''),
        );
        const reportChanged = String(reportNum ?? '') !== String(oldReportNum ?? '');
        const pdf = reportNum && pdfIndex.has(String(reportNum))
          ? '✅'
          : (reportChanged ? '❌' : duplicate.pdf);
        const updatedLine = buildRow({
          num: duplicate.num, date: addition.date,
          company: (reportNumMatched || dupReason === 'url' || companiesMatch(duplicate.company, addition.company))
            ? addition.company : duplicate.company,
          role: (reportNumMatched || dupReason === 'url') ? addition.role : duplicate.role,
          via: addition.via || duplicate.via || '—',
          location: addition.location || duplicate.location || '—',
          score: addition.score, status: duplicate.status, pdf,
          report: addition.report,
          notes: mergeNotes(duplicate.notes, addition, oldScore, newScore, supersededNote),
          raw: duplicate.raw,
          url: addition.url || duplicate.url || '',
        });
        if (replaceTrackerLine(duplicate.raw, updatedLine)) {
          const refreshed = parseAppLine(updatedLine);
          if (refreshed) Object.assign(duplicate, refreshed);
          else duplicate.raw = updatedLine;
          updated++;
        } else {
          console.error(
            `❌ ${file}: could not locate tracker row #${duplicate.num} ` +
            `(${duplicate.company} — ${duplicate.role}) to update; this evaluation was NOT merged.`,
          );
          failedAdditions.push(file);
        }
      } else {
        let entryNum;
        if (!usedNumbers.has(addition.num)) {
          entryNum = addition.num;
        } else {
          entryNum = maxNum + 1;
          while (usedNumbers.has(entryNum)) entryNum++;
          console.warn(
            `⚠️  Tracker #${addition.num} already used; assigning #${entryNum} to ` +
            `${addition.company} — ${addition.role}. Report link remains ${addition.report}.`,
          );
        }
        usedNumbers.add(entryNum);
        if (entryNum > maxNum) maxNum = entryNum;

        const pdf = reportNum && pdfIndex.has(String(reportNum)) ? '✅' : addition.pdf;
        const newLine = buildRow({
          num: entryNum, date: addition.date, company: addition.company, role: addition.role,
          via: addition.via || '—',
          location: addition.location || '—',
          score: addition.score, status: addition.status, pdf,
          report: addition.report, notes: addition.notes,
          url: addition.url || '',
        });
        newLines.push(newLine);
        const parsedNew = parseAppLine(newLine);
        if (parsedNew) {
          parsedNew.addedThisRun = true;
          existingApps.push(parsedNew);
        }
        added++;
        console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
      }
    }

    if (newLines.length > 0) {
      let insertIdx = -1;
      for (let i = 0; i < appLines.length; i++) {
        if (SEPARATOR_ROW_RE.test(appLines[i])) {
          insertIdx = i + 1;
          break;
        }
      }
      if (insertIdx < 0) {
        console.error(`❌ Aborting merge: ${basename(APPS_FILE)} has no table separator row ("|---|------|...").`);
        console.error(`   There is no insert point for ${newLines.length} new row(s), so NOTHING was written and no TSV was archived.`);
        console.error('   Repair the tracker table header, then re-run — the pending additions in');
        console.error(`   ${ADDITIONS_DIR} will merge then. Expected header:`);
        const { header, separator } = buildHeaderRows();
        console.error(`     ${header}`);
        console.error(`     ${separator}`);
        for (const line of newLines) console.error(`   not merged: ${line}`);
        trackerLock.release();
        return 1;
      }
      appLines.splice(insertIdx, 0, ...newLines);
    }

    if (!DRY_RUN) {
      const moved = sortTrackerRowsInPlace(appLines);
      if (moved > 0) console.log(`\n🔢 Sorted tracker by # ascending (${moved} row(s) repositioned).`);
      writeFileAtomic(APPS_FILE, appLines.join('\n'));

      if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
      const archivable = tsvFiles.filter(f => !failedAdditions.includes(f));
      for (const file of archivable) {
        renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
      }
      console.log(`\n✅ Moved ${archivable.length} TSVs to merged/`);
    }

    console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped${failedAdditions.length ? `, ❌${failedAdditions.length} NOT merged` : ''}`);
    if (missingReports > 0) console.log(`⚠️  ${missingReports} row(s) link to a report that is not on disk (see warnings above)`);
    if (DRY_RUN) console.log('(dry-run — no changes written)');
    trackerLock.release();

    if (!DRY_RUN) {
      try {
        const code = await syncTrackerPdfFlags({
          appsFile: APPS_FILE,
          pdfManifest: PDF_INDEX_FILE,
          lockDir: TRACKER_LOCK_DIR,
          lock: options.lock,
          logger: console,
        });
        if (code !== 0) console.warn(`⚠️  Failed to sync PDF flags: sync-pdf-flags exited with ${code}`);
      } catch (e) {
        console.warn(`⚠️  Failed to sync PDF flags: ${e.message}`);
      }
    }

    if (VERIFY && !DRY_RUN) {
      console.log('\n--- Running verification ---');
      try {
        execFileSync(process.execPath, [join(CAREER_OPS_CODE_ROOT, 'verify-pipeline.mjs')], { stdio: 'inherit', env: CHILD_ENV });
      } catch (e) {
        return 1;
      }
    }

    if (failedAdditions.length > 0) {
      console.error(
        `\n❌ ${failedAdditions.length} addition(s) were NOT merged and were left in ${ADDITIONS_DIR}: ` +
        failedAdditions.join(', '),
      );
      return 1;
    }

    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  validateFlags(argv, MERGE_TRACKER_KNOWN_FLAGS, MERGE_TRACKER_USAGE);

  const DATA_ROOT = getCareerOpsRoot();
  const appsFile = resolveTrackerPath(DATA_ROOT);
  const code = await mergeTracker({
    appsFile,
    dataRoot: DATA_ROOT,
    additionsDir: process.env.CAREER_OPS_ADDITIONS || join(DATA_ROOT, 'batch/tracker-additions'),
    batchStateFile: process.env.CAREER_OPS_BATCH_STATE || join(DATA_ROOT, 'batch/batch-state.tsv'),
    pdfIndexFile: resolvePdfIndexPath(appsFile),
    lockDir: trackerLockDirFor(appsFile),
    lock: {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
      staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
    },
    flags: {
      dryRun: argv.includes('--dry-run'),
      verify: argv.includes('--verify'),
      migrate: argv.includes('--migrate'),
      migrateVia: argv.includes('--migrate-via'),
      migrateUrls: argv.includes('--migrate-urls'),
      backfillUrls: argv.includes('--backfill-urls'),
    },
    holdMs: Number(process.env.CAREER_OPS_MERGE_HOLD_MS) || 0,
    readyIpc: process.env.CAREER_OPS_MERGE_READY_IPC === '1',
    childEnv: process.env,
  });
  process.exitCode = code;
}
