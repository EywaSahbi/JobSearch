#!/usr/bin/env node

import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, resolve, join, basename } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { format } from 'util';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import * as yaml from 'js-yaml';
import {
  resolveColumns, detectColumns, isHeaderRow, isSeparatorRow, LEGACY_COLMAP,
} from './tracker-parse.mjs';
import {
  canonicalizeTrackerPath, openTrackerTransaction, writeFileAtomic,
} from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

function resolveDbPath(mdPath, override) {
  return override || (mdPath.endsWith('.md') ? mdPath.slice(0, -3) + '.db' : mdPath + '.db');
}

function defaultDbPath() {
  return resolveDbPath(resolveTrackerPath(getCareerOpsRoot()), process.env.CAREER_OPS_TRACKER_DB);
}

class TrackerExit extends Error {
  constructor(code) {
    super(`tracker.mjs exited with ${code}`);
    this.exitCode = code;
  }
}

const CODEBASE_ROOT = dirname(fileURLToPath(import.meta.url));
const STATES_PATH = join(CODEBASE_ROOT, 'templates/states.yml');
const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEPARATOR = '|---|------|---------|------|-------|--------|-----|--------|-------|';

const SCHEMA_FIELDS = {
  num: 'id', date: 'date', company: 'company', role: 'role', score: 'score',
  status: 'status', pdf: 'pdf', report: 'report', notes: 'notes',
};

const SCHEMA_VERSION = '2';

async function loadSqlite(ctx) {
  const origEmit = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === 'string' ? warning : warning?.message || '';
    if (text.includes('SQLite is an experimental feature')) return;
    return origEmit.call(process, warning, ...args);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } catch {
    ctx.error('Error: node:sqlite is not available. tracker.mjs needs Node >= 22.13 (you are on ' + process.version + ').');
    ctx.error('The markdown tracker keeps working without it — the index is optional.');
    throw new TrackerExit(1);
  } finally {
    process.emitWarning = origEmit;
  }
}

export function openDb(DatabaseSync, path = defaultDbPath()) {
  mkdirSync(dirname(path) || '.', { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id      INTEGER PRIMARY KEY,
        pos     INTEGER NOT NULL,
        date    TEXT NOT NULL,
        company TEXT NOT NULL,
        role    TEXT NOT NULL,
        score   TEXT NOT NULL DEFAULT '—',
        status  TEXT NOT NULL,
        pdf     TEXT NOT NULL DEFAULT '❌',
        report  TEXT NOT NULL DEFAULT '—',
        notes   TEXT NOT NULL DEFAULT '',
        -- Cells of columns the schema has no field for, keyed by their index in
        -- the source row's split by pipe. JSON object, '{}' when the layout is
        -- the canonical nine columns.
        extras  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS status_events (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES applications(id),
        status TEXT NOT NULL,
        date   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
      CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company);
      CREATE INDEX IF NOT EXISTS idx_events_app ON status_events(app_id);
    `);
    const columns = db.prepare('PRAGMA table_info(applications)').all().map(c => c.name);
    if (!columns.includes('extras')) {
      db.exec("ALTER TABLE applications ADD COLUMN extras TEXT NOT NULL DEFAULT '{}'");
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function loadStates(ctx) {
  if (!existsSync(STATES_PATH)) {
    ctx.error(`Error: ${STATES_PATH} not found — cannot validate statuses (broken install: templates/states.yml ships with career-ops).`);
    throw new TrackerExit(1);
  }
  const doc = yaml.load(readFileSync(STATES_PATH, 'utf-8'));
  const byKey = new Map();
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    byKey.set(s.label.toLowerCase(), s.label);
    if (s.id) byKey.set(String(s.id).toLowerCase(), s.label);
    for (const alias of s.aliases || []) byKey.set(String(alias).toLowerCase(), s.label);
  }
  return { byKey, labels };
}

function normalizeStatus(raw, states) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.byKey.get(cleaned) || null;
}

const SCORE_RE = /^\*{0,2}(\d+(?:\.\d+)?\/5)\*{0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseApplicationId(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function repairPlaceholder(cell) {
  if (/^鈥.{0,2}$/.test(cell) || cell === '�') return '—';
  return cell;
}

function detectLayout(lines) {
  const at = (i) => {
    const separatorIndex = isSeparatorRow(lines[i + 1] ?? '') ? i + 1 : null;
    return {
      header: lines[i],
      separator: separatorIndex === null ? null : lines[separatorIndex],
      labels: headerLabels(lines[i]),
      headerIndex: i,
      separatorIndex,
    };
  };
  for (let i = 0; i < lines.length; i++) if (isHeaderRow(lines[i])) return at(i);
  for (let i = 1; i < lines.length; i++) {
    if (isSeparatorRow(lines[i]) && lines[i - 1].startsWith('|')) return at(i - 1);
  }
  return null;
}

function headerLabels(row) {
  const parts = row.split('|').map(c => c.trim());
  const cells = parts.slice(1);
  if (cells.length && cells[cells.length - 1] === '' && row.endsWith('|')) cells.pop();
  return cells;
}

function parseMarkdownRows(text, diag) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const raw = text.split('\n').map(l => l.replace(/\r$/, ''));
  const lines = raw.map(l => l.trim());
  const colmap = resolveColumns(lines);
  const layout = detectLayout(lines);
  const width = layout ? layout.labels.length + 2 : Math.max(...Object.values(colmap)) + 2;
  const schemaIndices = new Set(Object.keys(SCHEMA_FIELDS).map(k => colmap[k]).filter(i => i != null));
  const rows = [];
  const consumed = new Set();
  if (layout) {
    consumed.add(layout.headerIndex);
    if (layout.separatorIndex !== null) consumed.add(layout.separatorIndex);
  }
  let secondaryFrom = null;
  for (let index = 0; index < lines.length; index++) {
    const t = lines[index];
    if (!t.startsWith('|')) continue;
    let parts = t.split('|').map(c => c.trim());
    if (parts.length < 3) continue;
    const isStructure = index === layout?.headerIndex || isHeaderRow(t) || isSeparatorRow(t);
    if (isStructure && layout && index > (layout.separatorIndex ?? layout.headerIndex)
        && secondaryFrom === null) {
      secondaryFrom = rows.length;
    }
    if (index === layout?.headerIndex) continue;
    if ((parts[colmap.num] ?? '') === '#' || isHeaderRow(t) || /^[-: ]*$/.test(parts.join(''))) continue;
    if (parts.length > width && colmap.notes === width - 2) {
      parts = [...parts.slice(0, colmap.notes), parts.slice(colmap.notes, parts.length - 1).join(' | '), ''];
      if (diag) diag.strayPipes++;
    }
    const at = (k) => (colmap[k] != null ? (parts[colmap[k]] ?? '') : '');
    const lastCell = t.endsWith('|') ? parts.length - 2 : parts.length - 1;
    const extras = {};
    for (let i = 1; i <= lastCell; i++) {
      if (schemaIndices.has(i)) continue;
      if (parts[i]) extras[i] = parts[i];
    }
    consumed.add(index);
    rows.push({
      cells: [at('num'), at('date'), at('company'), at('role'), at('score'), at('status'), at('pdf'), at('report'), at('notes')],
      extras,
    });
  }
  return {
    rows,
    layout: layout && { ...layout, ...collectStructure(raw, consumed), eol, secondaryFrom },
  };
}

function collectStructure(lines, consumed) {
  const indices = [...consumed].sort((a, b) => a - b);
  if (indices.length === 0) return { prologue: [], epilogue: [], interior: [] };
  const first = indices[0];
  const last = indices[indices.length - 1];
  const interior = [];
  for (let i = first + 1; i < last; i++) if (!consumed.has(i)) interior.push(lines[i]);
  return { prologue: lines.slice(0, first), epilogue: lines.slice(last + 1), interior };
}

export function removeRowByNum(content, num) {
  const target = String(num).trim();
  const lines = content.split('\n');
  const colmap = resolveColumns(lines.map(l => l.trim()));
  let removedCount = 0;
  let report = null;
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t.startsWith('|')) return true;
    const parts = t.split('|').map((c) => c.trim());
    const numCell = parts[colmap.num] ?? '';
    if (numCell === '#' || /^[-: ]*$/.test(parts.join(''))) return true;
    if (numCell === target) {
      removedCount++;
      if (report === null) report = (colmap.report != null ? parts[colmap.report] : '') || null;
      return false;
    }
    return true;
  });
  return { removed: removedCount > 0, removedCount, report, newContent: kept.join('\n') };
}

function parseTracker(states, ctx) {
  const diag = { mojibake: 0, scoreInStatus: 0, unknownStatus: 0, badId: 0, badDate: 0, strayPipes: 0 };
  const { rows, layout } = parseMarkdownRows(readFileSync(ctx.mdPath, 'utf-8'), diag);

  const usedIds = new Set();
  let maxId = 0;
  const apps = [];

  for (const { cells, extras } of rows) {
    let [idRaw, date, company, role, score, status, pdf, report, notes] = cells;

    const before = [score, pdf, report].join('|');
    score = repairPlaceholder(score);
    pdf = repairPlaceholder(pdf);
    report = repairPlaceholder(report);
    if ([score, pdf, report].join('|') !== before) diag.mojibake++;

    const scoreInStatus = status.match(SCORE_RE);
    if (scoreInStatus) {
      if (!SCORE_RE.test(score)) score = scoreInStatus[1];
      status = 'Evaluated';
      diag.scoreInStatus++;
    }

    const canonical = normalizeStatus(status, states);
    if (!canonical) {
      notes = notes ? `${notes} [sync: original status "${status}"]` : `[sync: original status "${status}"]`;
      status = 'Evaluated';
      diag.unknownStatus++;
    } else {
      status = canonical;
    }

    let id = parseApplicationId(idRaw);
    if (id === null || usedIds.has(id)) {
      id = 0;
      diag.badId++;
    } else {
      usedIds.add(id);
      if (id > maxId) maxId = id;
    }

    if (!DATE_RE.test(date)) diag.badDate++;

    apps.push({
      id, pos: apps.length, date, company, role, score: score || '—', status,
      pdf: pdf || '❌', report: report || '—', notes, extras: JSON.stringify(extras),
    });
  }
  for (const app of apps) if (app.id === 0) app.id = ++maxId;

  return { apps, diag, layout };
}

function mdHash(ctx) {
  return createHash('sha256').update(readFileSync(ctx.mdPath)).digest('hex');
}

function reportDiagnostics(diag, ctx) {
  const total = Object.values(diag).reduce((a, b) => a + b, 0);
  if (total === 0) {
    ctx.error('No corruption detected — index matches the markdown cleanly.');
    return 0;
  }
  ctx.error(`Corruption detected in ${ctx.mdPath} (normalized in the index only — the markdown is untouched):`);
  if (diag.mojibake) ctx.error(`  ${diag.mojibake} mojibake placeholder cell(s)`);
  if (diag.scoreInStatus) ctx.error(`  ${diag.scoreInStatus} score(s) sitting in the status column`);
  if (diag.unknownStatus) ctx.error(`  ${diag.unknownStatus} non-canonical status(es), indexed as Evaluated (original kept in notes)`);
  if (diag.badId) ctx.error(`  ${diag.badId} missing/malformed/duplicate id(s), reassigned in the index`);
  if (diag.badDate) ctx.error(`  ${diag.badDate} malformed date(s), kept as-is`);
  if (diag.strayPipes) ctx.error(`  ${diag.strayPipes} row(s) with stray pipes, folded into notes`);
  ctx.error('Fix at the source with `node normalize-statuses.mjs` / `node dedup-tracker.mjs`, then re-sync.');
  return total;
}

function syncIndex(db, states, ctx) {
  const { apps, diag, layout } = parseTracker(states, ctx);
  const today = localToday();

  db.exec('BEGIN');
  db.exec('PRAGMA defer_foreign_keys = ON');
  try {
    db.exec('DELETE FROM applications');
    const insertApp = db.prepare('INSERT INTO applications (id, pos, date, company, role, score, status, pdf, report, notes, extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const a of apps) insertApp.run(a.id, a.pos, a.date, a.company, a.role, a.score, a.status, a.pdf, a.report, a.notes, a.extras);

    db.exec('DELETE FROM status_events WHERE app_id NOT IN (SELECT id FROM applications)');
    const latestEvent = db.prepare('SELECT status FROM status_events WHERE app_id = ? ORDER BY id DESC LIMIT 1');
    const insertEvent = db.prepare('INSERT INTO status_events (app_id, status, date) VALUES (?, ?, ?)');
    for (const a of apps) {
      const last = latestEvent.get(a.id);
      if (!last) insertEvent.run(a.id, a.status, DATE_RE.test(a.date) ? a.date : today);
      else if (last.status !== a.status) insertEvent.run(a.id, a.status, today);
    }

    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    setMeta.run('md_sha256', mdHash(ctx));
    setMeta.run('schema_version', SCHEMA_VERSION);
    setMeta.run('md_header', layout?.header ?? '');
    setMeta.run('md_separator', layout?.separator ?? '');
    setMeta.run('md_prologue', JSON.stringify(layout?.prologue ?? []));
    setMeta.run('md_epilogue', JSON.stringify(layout?.epilogue ?? []));
    setMeta.run('md_interior', JSON.stringify(layout?.interior ?? []));
    setMeta.run('md_eol', layout?.eol ?? '\n');
    setMeta.run('md_secondary_from', layout?.secondaryFrom == null ? '' : String(layout.secondaryFrom));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { apps, diag };
}

async function sync(args, ctx) {
  if (!existsSync(ctx.mdPath)) {
    ctx.error(`Error: ${ctx.mdPath} not found — nothing to index.`);
    throw new TrackerExit(1);
  }
  const states = loadStates(ctx);

  if (args.includes('--check')) {
    const { apps, diag } = parseTracker(states, ctx);
    ctx.error(`Parsed ${apps.length} data rows from ${ctx.mdPath}`);
    const issues = reportDiagnostics(diag, ctx);
    ctx.error('(--check — no index written)');
    return issues > 0 ? 1 : 0;
  }

  const DatabaseSync = await loadSqlite(ctx);
  const db = ctx.openDb(DatabaseSync);
  const { apps, diag } = syncIndex(db, states, ctx);
  ctx.error(`Indexed ${apps.length} applications from ${ctx.mdPath} into ${ctx.dbPath()}`);
  reportDiagnostics(diag, ctx);
}

function ensureFresh(db, states, ctx) {
  if (!existsSync(ctx.mdPath)) {
    ctx.error(`Error: ${ctx.mdPath} not found — the index has no source of truth to read from.`);
    throw new TrackerExit(1);
  }
  const synced = db.prepare('SELECT value FROM meta WHERE key = ?').get('md_sha256');
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (synced && synced.value === mdHash(ctx) && version?.value === SCHEMA_VERSION) return;
  ctx.error(`(index stale — resyncing from ${ctx.mdPath})`);
  syncIndex(db, states, ctx);
}

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const kv = args.find(a => a.startsWith(flag + '='));
  return kv ? kv.split('=').slice(1).join('=') : null;
}

const cleanCell = (v) => String(v ?? '').replace(/\|/g, '│').replace(/\r?\n/g, ' ');

function rowToMarkdown(r) {
  return `| ${r.id} | ${cleanCell(r.date)} | ${cleanCell(r.company)} | ${cleanCell(r.role)} | ${cleanCell(r.score)} | ${cleanCell(r.status)} | ${cleanCell(r.pdf)} | ${cleanCell(r.report)} | ${cleanCell(r.notes)} |`;
}

async function query(args, ctx) {
  const DatabaseSync = await loadSqlite(ctx);
  const db = ctx.openDb(DatabaseSync);
  const states = loadStates(ctx);
  ensureFresh(db, states, ctx);

  const where = [];
  const params = [];
  const status = flagValue(args, '--status');
  if (status) {
    const canonical = normalizeStatus(status, states);
    if (!canonical) { ctx.error(`Error: unknown status "${status}". Canonical: ${states.labels.join(', ')}`); throw new TrackerExit(1); }
    where.push('status = ?'); params.push(canonical);
  }
  const company = flagValue(args, '--company');
  if (company) { where.push('company LIKE ?'); params.push(`%${company}%`); }
  const role = flagValue(args, '--role');
  if (role) { where.push('role LIKE ?'); params.push(`%${role}%`); }
  const since = flagValue(args, '--since');
  if (since) {
    if (!DATE_RE.test(since)) { ctx.error('Error: --since must be YYYY-MM-DD'); throw new TrackerExit(1); }
    where.push('date >= ?'); params.push(since);
  }
  const idRaw = flagValue(args, '--id');
  if (args.some(arg => arg === '--id' || arg.startsWith('--id='))) {
    const id = parseApplicationId(idRaw);
    if (id === null) { ctx.error('Error: --id must be a positive integer'); throw new TrackerExit(1); }
    where.push('id = ?'); params.push(id);
  }

  let sql = 'SELECT id, date, company, role, score, status, pdf, report, notes FROM applications'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC';
  const limit = parseInt(flagValue(args, '--limit') || '0', 10);
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }

  const rows = db.prepare(sql).all(...params);
  if (args.includes('--json')) {
    ctx.log(JSON.stringify(rows, null, 2));
  } else {
    ctx.log(HEADER);
    ctx.log(SEPARATOR);
    for (const r of rows) ctx.log(rowToMarkdown(r));
    ctx.error(`\n${rows.length} row(s)`);
  }
}

async function history(args, ctx) {
  const DatabaseSync = await loadSqlite(ctx);
  const db = ctx.openDb(DatabaseSync);
  ensureFresh(db, loadStates(ctx), ctx);
  const id = parseApplicationId(flagValue(args, '--id'));
  if (id === null) { ctx.error('Error: history requires --id N (a positive integer)'); throw new TrackerExit(1); }
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) { ctx.error(`Error: no application with id ${id}`); throw new TrackerExit(1); }
  ctx.log(`#${app.id} ${app.company} — ${app.role}`);
  for (const e of db.prepare('SELECT status, date FROM status_events WHERE app_id = ? ORDER BY id').all(id)) {
    ctx.log(`  ${e.date}  ${e.status}`);
  }
}

function parseExtras(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readLayout(meta) {
  const list = (raw, fallback) => {
    try {
      const parsed = JSON.parse(raw ?? '');
      return Array.isArray(parsed) ? parsed.map(String) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    header: meta.md_header || '',
    separator: meta.md_separator || '',
    prologue: list(meta.md_prologue, ['# Applications Tracker', '']),
    epilogue: list(meta.md_epilogue, ['']),
    interior: list(meta.md_interior, []),
    eol: meta.md_eol === '\r\n' ? '\r\n' : '\n',
    secondaryFrom: /^\d+$/.test(meta.md_secondary_from ?? '') ? Number(meta.md_secondary_from) : null,
  };
}

function renderTable(rows, layout) {
  const header = layout.header || HEADER;
  const labels = layout.header ? headerLabels(layout.header) : headerLabels(HEADER);
  const colmap = (layout.header ? detectColumns([layout.header]) : null) || LEGACY_COLMAP;

  const fieldAt = new Map();
  for (const [field, dbField] of Object.entries(SCHEMA_FIELDS)) {
    if (colmap[field] != null) fieldAt.set(colmap[field], dbField);
  }

  const width = labels.length;
  const unplaceable = new Set();
  const sanitized = [];
  const body = rows.map((r) => {
    const extras = parseExtras(r.extras);
    for (const key of Object.keys(extras)) {
      if (Number(key) > width) unplaceable.add(Number(key));
    }
    const cells = [];
    for (let i = 1; i <= width; i++) {
      const field = fieldAt.get(i);
      const value = field ? r[field] : extras[i] ?? '';
      const rendered = cleanCell(value);
      if (rendered !== String(value ?? '')) {
        sanitized.push(`row #${r.id}, column ${i}${labels[i - 1] ? ` (${labels[i - 1]})` : ''}: "${value}" → "${rendered}"`);
      }
      cells.push(rendered);
    }
    return `| ${cells.join(' | ')} |`;
  });

  const separator = layout.separator
    || (layout.header
      ? `|${labels.map(l => '-'.repeat(Math.max(3, l.length + 2))).join('|')}|`
      : SEPARATOR);

  const dropped = [
    ...[...unplaceable].sort((a, b) => a - b)
      .map(i => `column ${i}${labels[i - 1] ? ` (${labels[i - 1]})` : ''}`),
    ...sanitized,
  ];
  return { header, separator, body, dropped };
}

async function exportMd(args, ctx) {
  const outPath = flagValue(args, '--out');
  const force = args.includes('--force');
  if (outPath && existsSync(outPath) && statSync(outPath).isDirectory()) {
    ctx.error(`Error: --out ${outPath} is a directory — pass a file path.`);
    throw new TrackerExit(1);
  }

  const trackerPath = canonicalizeTrackerPath(ctx.mdPath);
  const writesTracker = outPath
    ? canonicalizeTrackerPath(outPath) === trackerPath
    : false;
  const trackerTransaction = writesTracker
    ? await openTrackerTransaction(trackerPath)
    : null;

  try {
    const DatabaseSync = await loadSqlite(ctx);
    const db = ctx.openDb(DatabaseSync);
    ensureFresh(db, loadStates(ctx), ctx);
    const rows = db.prepare('SELECT * FROM applications ORDER BY pos').all();
    const meta = db.prepare('SELECT key, value FROM meta').all()
      .reduce((acc, m) => Object.assign(acc, { [m.key]: m.value }), {});
    const layout = readLayout(meta);
    const primary = layout.secondaryFrom == null ? rows : rows.slice(0, layout.secondaryFrom);
    const secondary = layout.secondaryFrom == null ? [] : rows.slice(layout.secondaryFrom);
    const { header, separator, body, dropped } = renderTable(primary, layout);
    const out = [...layout.prologue, header, separator, ...body, ...layout.epilogue]
      .join(layout.eol);

    const losses = [
      ...dropped,
      ...layout.interior.map(line => `line between table rows: ${line === '' ? '(blank)' : `"${line}"`}`),
      ...secondary.map(r => `row #${r.id} (${r.company} — ${r.role}) belongs to a later table; the rebuilt one has no place for it`),
    ];
    if (losses.length) {
      ctx.error(`Warning: ${losses.length} item(s) in ${ctx.mdPath} cannot be reproduced by export and will be dropped:`);
      for (const d of losses) ctx.error(`  ${d}`);
      ctx.error('Cells outside the declared header, and content between the first and last table row, have nowhere to go in a single rebuilt table.');
    }

    if (!outPath) {
      ctx.stdout.write(out);
      return;
    }
    mkdirSync(dirname(outPath) || '.', { recursive: true });
    const writeTarget = writesTracker ? trackerPath : outPath;
    if (losses.length && existsSync(writeTarget) && !force) {
      ctx.error(`Refusing to overwrite ${outPath} — that would drop the item(s) listed above.`);
      ctx.error('Re-run with --force if you have read the list and want the export anyway.');
      return 1;
    }
    if (existsSync(writeTarget)) {
      copyFileSync(writeTarget, writeTarget + '.bak');
      ctx.error(`Existing ${outPath} backed up to ${outPath}.bak`);
    }
    if (trackerTransaction) trackerTransaction.replace(out);
    else writeFileAtomic(outPath, out);
    ctx.error(`Exported ${body.length} applications to ${outPath}`);
  } finally {
    trackerTransaction?.close();
  }
}

async function deleteApp(args, ctx) {
  const num = flagValue(args, '--num');
  if (!num) {
    ctx.error('Usage: node tracker.mjs delete --num <N> [--dry-run]   (remove one application row by its number)');
    throw new TrackerExit(1);
  }
  if (!existsSync(ctx.mdPath)) {
    ctx.error(`Error: ${ctx.mdPath} not found — nothing to delete.`);
    throw new TrackerExit(1);
  }
  if (args.includes('--dry-run')) {
    const { removed, removedCount, report } = removeRowByNum(readFileSync(ctx.mdPath, 'utf-8'), num);
    if (!removed) {
      ctx.error(`No application numbered ${num} in ${ctx.mdPath}.`);
      throw new TrackerExit(1);
    }
    ctx.error(`Would remove application ${num} (${removedCount} row${removedCount > 1 ? 's' : ''}) from ${ctx.mdPath}.`);
    if (report) ctx.error(`(report file would be orphaned: ${report})`);
    return;
  }

  const trackerTransaction = await openTrackerTransaction(ctx.mdPath);

  let removal;
  try {
    removal = removeRowByNum(trackerTransaction.read(), num);
    if (!removal.removed) {
      ctx.error(`No application numbered ${num} in ${ctx.mdPath}.`);
      return 1;
    }
    trackerTransaction.replace(removal.newContent);
  } finally {
    trackerTransaction.close();
  }

  const { removedCount, report } = removal;
  try {
    const states = loadStates(ctx);
    const DatabaseSync = await loadSqlite(ctx);
    const db = ctx.openDb(DatabaseSync);
    syncIndex(db, states, ctx);
  } catch (e) {
    if (e instanceof TrackerExit) throw e;
    ctx.error(`(row removed; index resync skipped: ${e.message})`);
  }
  ctx.error(`Removed application ${num} (${removedCount} row${removedCount > 1 ? 's' : ''}) from ${ctx.mdPath} and reindexed.`);
  if (report) ctx.error(`Note: report file may now be orphaned — ${report}`);
}

const COMMANDS = { sync, query, history, export: exportMd, delete: deleteApp };

export async function runTracker(command, args = [], options = {}) {
  const { mdPath, stdout = process.stdout, stderr = process.stderr } = options;
  if (!mdPath) throw new TypeError('runTracker: options.mdPath is required');
  const line = (stream) => (...parts) => { stream.write(`${format(...parts)}\n`); };
  const opened = [];
  const ctx = {
    mdPath,
    stdout,
    log: line(stdout),
    error: line(stderr),
    openDb(DatabaseSync) {
      const db = openDb(DatabaseSync, ctx.dbPath());
      opened.push(db);
      return db;
    },
    dbPath() {
      const path = resolveDbPath(mdPath, options.dbPath);
      if (resolve(mdPath) === resolve(path)) {
        ctx.error(`Error: DB path must differ from the markdown path (${mdPath}).`);
        throw new TrackerExit(1);
      }
      return path;
    },
  };
  const fn = COMMANDS[command];
  if (!fn) {
    ctx.log('Usage: node tracker.mjs <sync|query|history|export|delete> [flags]');
    ctx.log('See the header comment of this file for examples, or docs/SCRIPTS.md.');
    return command ? 1 : 0;
  }
  try {
    return (await fn(args, ctx)) ?? 0;
  } catch (err) {
    if (err instanceof TrackerExit) return err.exitCode;
    throw err;
  } finally {
    for (const db of opened) db.close();
  }
}

if (isMainModule(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  runTracker(command, args, {
    mdPath: resolveTrackerPath(getCareerOpsRoot()),
    dbPath: process.env.CAREER_OPS_TRACKER_DB,
  }).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error('Fatal:', err.message);
      process.exitCode = 1;
    },
  );
}
