#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';
import { asciiFold } from './lib/ascii-fold.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_CSV = join(DATA_ROOT, 'data/Connections.csv');
export const TRACKER_PATH = resolveTrackerPath(DATA_ROOT);
const PORTALS_PATH = join(DATA_ROOT, 'portals.yml');
const CONTACTS_PATH = join(DATA_ROOT, 'data/contacts.tsv');

const args = process.argv.slice(2);

const VALUE_FLAGS = ['--since', '--csv', '--company'];
const KNOWN_FLAGS = [
  '--summary', '--tsv', '--self-test', '--include-weak',
  '--tracker-only', '--portals-only', ...VALUE_FLAGS, '--help', '-h',
];

const USAGE = `Usage: node linkedin-join.mjs [options]

Joins a LinkedIn Connections.csv export against tracker + portals.yml companies
to answer "do I know anyone here?". Offline, read-only, zero token cost.

  --company <name>   Answer for ONE company; says so explicitly when nobody matches
  --summary          Human-readable output grouped by company (default: JSON)
  --tsv              contacts.tsv-shaped rows on stdout (never appends)
  --tracker-only     Only companies in data/applications.md
  --portals-only     Only portals.yml scanner targets
  --include-weak     Include weak name matches (noisier)
  --since <YYYY>     Only connections made in/after this 4-digit year
  --csv <path>       Override the export location
  --self-test        Run the inline checks
  --help, -h         Show this message`;

const summaryMode = hasFlag(args, '--summary');
const tsvMode = hasFlag(args, '--tsv');
const selfTestMode = hasFlag(args, '--self-test');
const includeWeak = hasFlag(args, '--include-weak');
const trackerOnly = hasFlag(args, '--tracker-only');
const portalsOnly = hasFlag(args, '--portals-only');
const sinceRaw = flagValue(args, '--since') ?? null;
const sinceYear = sinceRaw === null ? null : (/^\d{4}$/.test(sinceRaw) ? Number(sinceRaw) : NaN);
const csvPath = flagValue(args, '--csv') || DEFAULT_CSV;
const companyQuery = flagValue(args, '--company') ?? null;

const GENERIC = new Set([
  'the', 'a', 'an', 'and', 'of', 'for',
  'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'mbh', 'ag', 'kg', 'sa', 'sas', 'sarl', 'bv', 'nv',
  'ab', 'oy', 'as', 'aps', 'plc', 'pty', 'srl', 'spa', 'kk', 'pte', 'pvt',
  'holdings', 'holding', 'group', 'groupe', 'international', 'global',
  'worldwide', 'enterprises', 'enterprise', 'ventures', 'capital', 'partners',
  'associates', 'consulting', 'consultancy', 'industries', 'industrial',
  'technologies', 'technology', 'tech', 'software', 'systems', 'system',
  'solutions', 'solution', 'services', 'service', 'labs', 'lab', 'digital',
  'data', 'cloud', 'ai', 'health', 'healthcare', 'medical', 'media', 'network',
  'networks', 'platform', 'platforms', 'security', 'cybersecurity', 'cyber',
  'financial', 'finance', 'insurance', 'energy', 'studio', 'studios',
  'stealth', 'startup', 'unknown', 'confidential', 'undisclosed', 'anon',
  'anonymous', 'client', 'various',
]);

export function foldToken(token) {
  const raw = String(token);
  const folded = asciiFold(raw, { punctuation: 'delete' });
  if (folded) return folded;
  return normalizeTextKey(raw);
}

export function companyTokens(name) {
  const raw = String(name || '');
  const parens = [...raw.matchAll(/\(([^)]*)\)/g)].map(m => m[1].trim()).filter(Boolean);
  const base = raw.replace(/\([^)]*\)/g, ' ');
  const all = base
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
    .map(foldToken)
    .filter(Boolean);
  return {
    all,
    distinctive: all.filter(t => !GENERIC.has(t)),
    key: all.join(''),
    parenthetical: parens.length ? parens.join(' ') : null,
  };
}

export function matchCompany(a, b) {
  if (!a.key || !b.key) return null;
  if (a.key === b.key) return 'exact';

  const da = new Set(a.distinctive);
  const db = new Set(b.distinctive);
  if (!da.size || !db.size) return null;

  const shared = [...da].filter(t => db.has(t));
  if (!shared.length) return null;

  const identical = da.size === db.size && shared.length === da.size;
  const substantive = shared.some(t => t.length >= 3);
  if (identical && substantive) return 'strong';
  return 'weak';
}

export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\r' && s[i + 1] === '\n') { field += '\n'; i += 2; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map(c => c.trim().toLowerCase());
    if (lower.includes('first name') && lower.includes('company')) return i;
  }
  return -1;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isRealDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function parseConnectedOn(value) {
  const s = String(value || '').trim();
  if (!s) return { iso: null, year: null, raw: '' };

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isRealDate(s) ? { iso: s, year: Number(m[1]), raw: s } : { iso: null, year: null, raw: s };

  m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) {
      const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
      if (isRealDate(iso)) return { iso, year: Number(m[3]), raw: s };
    }
  }
  return { iso: null, year: null, raw: s };
}

export function parseConnections(text) {
  const quality = { noHeader: false, noCompany: 0, noName: 0, unparsedDates: 0 };
  const rows = parseCsv(text);
  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) {
    quality.noHeader = true;
    return { connections: [], quality };
  }

  const header = rows[headerIdx].map(c => c.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    first: col('first name'),
    last: col('last name'),
    url: col('url'),
    email: col('email address'),
    company: col('company'),
    position: col('position'),
    connected: col('connected on'),
  };

  const connections = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.length || cells.every(c => !c.trim())) continue;
    const get = (k) => (idx[k] !== -1 && cells[idx[k]] != null ? String(cells[idx[k]]).trim() : '');

    const name = [get('first'), get('last')].filter(Boolean).join(' ');
    const company = get('company');
    if (!name) { quality.noName++; continue; }
    if (!company) { quality.noCompany++; continue; }

    const connected = parseConnectedOn(get('connected'));
    if (connected.raw && !connected.iso) quality.unparsedDates++;

    connections.push({
      name,
      company,
      title: get('position'),
      linkedin: get('url'),
      email: get('email'),
      connectedOn: connected.iso,
      connectedYear: connected.year,
      tokens: companyTokens(company),
    });
  }
  return { connections, quality };
}

export function parseTrackerTargets(content) {
  const lines = String(content || '').split('\n');
  const colmap = resolveColumns(lines);
  const targets = [];
  const skipped = [];

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || !row.company) continue;

    const tokens = companyTokens(row.company);
    const meta = { num: row.num, role: row.role, status: row.status, score: row.score };
    if (tokens.distinctive.length) {
      targets.push({ company: row.company, source: 'tracker', tokens, tracker: meta });
    } else {
      skipped.push({ company: row.company, reason: 'placeholder / no identifying tokens' });
    }
    if (tokens.parenthetical) {
      const alias = companyTokens(tokens.parenthetical);
      if (alias.key && alias.distinctive.length) {
        targets.push({
          company: tokens.parenthetical,
          source: 'tracker',
          tokens: alias,
          tracker: { ...meta, viaAlias: true },
        });
      }
    }
  }
  return { targets, skipped };
}

export function parsePortalTargets(content) {
  let doc;
  try {
    doc = yaml.load(String(content || ''));
  } catch {
    return { targets: [], skipped: [{ company: '(portals.yml)', reason: 'YAML parse error' }] };
  }
  const list = Array.isArray(doc?.tracked_companies) ? doc.tracked_companies : [];
  const targets = [];
  const skipped = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name) continue;
    if (typeof entry === 'object' && entry.enabled === false) continue;
    const tokens = companyTokens(name);
    if (!tokens.distinctive.length) {
      skipped.push({ company: name, reason: 'placeholder / no identifying tokens' });
      continue;
    }
    targets.push({ company: name, source: 'portals', tokens, tracker: null });
  }
  return { targets, skipped };
}

export function parseKnownContacts(content) {
  const known = new Set();
  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const cells = line.split('\t').map(c => c.trim());
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    known.add(`${normalizeTextKey(cells[0])}::${normalizeTextKey(cells[1])}`);
  }
  return known;
}

export function secondDegreeSearchUrl(company) {
  const q = encodeURIComponent(String(company || '').trim());
  return `https://www.linkedin.com/search/results/people/?keywords=${q}&network=%5B%22S%22%5D`;
}

const TIER_RANK = { exact: 0, strong: 1, weak: 2 };

export function joinConnections(connections, targetList, { known = new Set(), includeWeak = false } = {}) {
  const merged = [];
  const ordered = [...targetList].sort((a, b) =>
    (a.source === 'tracker' ? 0 : 1) - (b.source === 'tracker' ? 0 : 1));
  for (const t of ordered) {
    const twin = merged.find(m => {
      const tier = matchCompany(m.tokens, t.tokens);
      return tier === 'exact' || tier === 'strong';
    });
    if (!twin) merged.push({ ...t, connections: [] });
  }
  const byKey = new Map(merged.map(t => [t.tokens.key, t]));

  const matched = new Set();
  for (const conn of connections) {
    for (const target of byKey.values()) {
      const tier = matchCompany(conn.tokens, target.tokens);
      if (!tier) continue;
      if (tier === 'weak' && !includeWeak) continue;
      target.connections.push({
        name: conn.name,
        title: conn.title,
        linkedinCompany: conn.company,
        linkedin: conn.linkedin,
        email: conn.email || null,
        connectedOn: conn.connectedOn,
        connectedYear: conn.connectedYear,
        match: tier,
        alreadyInPhonebook: known.has(`${normalizeTextKey(conn.name)}::${normalizeTextKey(target.company)}`),
      });
      matched.add(conn);
    }
  }

  const targets = [...byKey.values()]
    .filter(t => t.connections.length)
    .map(t => ({
      company: t.company,
      source: t.source,
      tracker: t.tracker,
      secondDegreeSearch: secondDegreeSearchUrl(t.company),
      connections: t.connections.sort((a, b) =>
        TIER_RANK[a.match] - TIER_RANK[b.match] ||
        String(b.connectedOn || '').localeCompare(String(a.connectedOn || '')) ||
        a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'tracker' ? -1 : 1;
      if (a.source === 'tracker') {
        const an = Number(a.tracker?.num) || 0;
        const bn = Number(b.tracker?.num) || 0;
        if (an !== bn) return an - bn;
      }
      return a.company.localeCompare(b.company);
    });

  return { targets, matchedConnections: matched.size, targetCount: merged.length };
}

function renderSummary(result) {
  const { targets, totals, quality } = result;
  const out = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  out.push('LinkedIn warm-intro join');
  out.push(`  ${plural(totals.connections, 'connection', 'connections')} · ` +
           `${plural(totals.targets, 'target company', 'target companies')} · ` +
           `${plural(totals.matchedCompanies, 'company', 'companies')} with a connection · ` +
           `${plural(totals.matchedConnections, 'person', 'people')}`);
  out.push('');

  if (!targets.length) {
    out.push('  No overlap found.' + (includeWeak ? '' : ' Try --include-weak for looser name matches.'));
    return out.join('\n');
  }

  let section = null;
  for (const t of targets) {
    if (t.source !== section) {
      section = t.source;
      out.push(section === 'tracker'
        ? '── In your tracker ' + '─'.repeat(40)
        : '── Scanner targets (no application yet) ' + '─'.repeat(21));
      out.push('');
    }

    const head = t.source === 'tracker' && t.tracker
      ? `${t.company}  [#${t.tracker.num} ${t.tracker.status || '?'}${t.tracker.role ? ` · ${t.tracker.role}` : ''}]`
      : t.company;
    out.push(`  ${head}`);

    for (const c of t.connections) {
      const bits = [];
      if (c.title) bits.push(c.title);
      if (c.connectedOn) bits.push(`since ${c.connectedOn.slice(0, 7)}`);
      if (c.match !== 'exact') bits.push(`${c.match} match: "${c.linkedinCompany}"`);
      if (c.alreadyInPhonebook) bits.push('already in contacts.tsv');
      out.push(`    · ${c.name}${bits.length ? ` — ${bits.join(' — ')}` : ''}`);
      if (c.linkedin) out.push(`        ${c.linkedin}`);
    }
    out.push(`    2nd-degree: ${t.secondDegreeSearch}`);
    out.push('');
  }

  const notes = [];
  if (quality.noHeader) notes.push('CSV header row not found — is this a LinkedIn Connections export?');
  if (quality.noCompany) notes.push(`${quality.noCompany} connections have no employer listed (cannot join)`);
  if (quality.unparsedDates) notes.push(`${quality.unparsedDates} unparseable "Connected On" dates`);
  if (quality.skippedTargets.length) notes.push(`${quality.skippedTargets.length} target rows skipped (placeholder names)`);
  if (notes.length) {
    out.push('Notes:');
    for (const n of notes) out.push(`  ! ${n}`);
    out.push('');
  }
  out.push('Review before acting: a 1st-degree connection is not automatically a warm intro.');
  return out.join('\n');
}

function renderTsv(result) {
  const out = ['# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker#\tnotes'];
  for (const t of result.targets) {
    for (const c of t.connections) {
      if (c.alreadyInPhonebook) continue;
      const note = [
        `LinkedIn 1st-degree${c.connectedOn ? `, connected ${c.connectedOn}` : ''}.`,
        c.match === 'exact' ? '' : `Name match ${c.match}: "${c.linkedinCompany}".`,
        'Verify current employer before outreach.',
      ].filter(Boolean).join(' ');
      const clean = (v) => {
        const value = String(v || '').replace(/[\t\r\n]+/g, ' ').trim();
        return /^[=+\-@]/.test(value) ? `'${value}` : value;
      };
      out.push([
        clean(c.name), clean(t.company), 'peer', clean(c.title), '',
        clean(c.email), clean(c.linkedin),
        t.tracker?.num ? String(t.tracker.num) : '-', clean(note),
      ].join('\t'));
    }
  }
  return out.join('\n');
}

function renderCompanyAnswer(result, query) {
  const target = result.targets[0];
  const out = [`Do you know anyone at "${query}"?`, ''];

  if (!target || !target.connections.length) {
    out.push('  No. No first-degree connection in your export lists this company.');
    if (!includeWeak) out.push('  (Strict name matching. Try --include-weak for looser variants.)');
  } else {
    const n = target.connections.length;
    out.push(`  Yes — ${n} ${n === 1 ? 'connection' : 'connections'}:`);
    out.push('');
    for (const c of target.connections) {
      const bits = [];
      if (c.title) bits.push(c.title);
      if (c.connectedOn) bits.push(`since ${c.connectedOn.slice(0, 7)}`);
      if (c.match !== 'exact') bits.push(`${c.match} match: "${c.linkedinCompany}"`);
      if (c.alreadyInPhonebook) bits.push('already in contacts.tsv');
      out.push(`    · ${c.name}${bits.length ? ` — ${bits.join(' — ')}` : ''}`);
      if (c.linkedin) out.push(`        ${c.linkedin}`);
    }
  }

  out.push('');
  out.push('  Second-degree (not in any export — open it yourself, nothing is fetched):');
  out.push(`    ${secondDegreeSearchUrl(query)}`);
  return out.join('\n');
}

function selfTest() {
  let passed = 0;
  const failures = [];
  const check = (name, cond) => { if (cond) passed++; else failures.push(name); };
  const tier = (a, b) => matchCompany(companyTokens(a), companyTokens(b));

  check('case-insensitive exact', tier('GE HealthCare', 'GE Healthcare') === 'exact');
  check('diacritics fold', tier('Estée Lauder', 'Estee Lauder') === 'exact');
  check('ampersand splits', tier('Crum & Forster', 'Crum Forster') === 'exact');
  check('conjunction is generic', tier('Crum & Forster', 'Crum and Forster') === 'strong');
  check('legal suffix ignored', tier('EXL', 'EXL Service Holdings, Inc.') === 'strong');
  check('subset match', tier('Siemens', 'Siemens Digital Industries Software') === 'strong');
  check('leading article', tier('New York Times', 'The New York Times') === 'strong');
  check('generic token alone does not match', tier('Monogram Health', 'Advocate Health') === null);
  check('no substring matching', tier('Loop', 'Loopio') === null);
  check('unrelated names', tier('Datavant', 'Snyk') === null);
  check('all-generic name is inert', tier('Stealth Startup', 'Acme Startup') === null);
  check('short shared token demoted', tier('GE', 'GE Inc') === 'weak');
  check('extra distinctive token demotes', tier('Epic Systems', 'Epic Games') === 'weak');
  check('nested name demotes', tier('Optimal Blue', 'Blue Cloud Ventures') === 'weak');
  check('extra token demotes', tier('Red Cell Partners', 'Red Rock Cell Co') === 'weak');
  check('partial overlap is weak', tier('Kixie Nimbus', 'Nimbus Chainguard') === 'weak');
  check('CJK preserved', companyTokens('株式会社テスト').key.length > 0);
  check('Cyrillic preserved', companyTokens('Яндекс').key.length > 0);
  check('CJK still matches itself', tier('株式会社テスト', '株式会社テスト') === 'exact');
  check('slashed O folds', tier('Ørsted', 'Orsted') === 'exact');
  check('dotless i folds', tier('Işık Holding', 'Isik Holding') === 'exact');
  check('eszett folds', tier('Straße GmbH', 'Strasse GmbH') === 'exact');
  check('ligature folds', tier('Æther Labs', 'Aether Labs') === 'exact');
  check('slashed l folds', tier('Łukasiewicz', 'Lukasiewicz') === 'exact');
  check('decomposing diacritics still fold', tier('Société Générale', 'Societe Generale') === 'exact');

  const csv = parseCsv('a,"b,c",d\n"line\nbreak","say ""hi""",z\n');
  check('csv quoted comma', csv[0][1] === 'b,c');
  check('csv embedded newline', csv[1][0] === 'line\nbreak');
  check('csv escaped quotes', csv[1][1] === 'say "hi"');

  const export_ = [
    'Notes:', '"preamble text"', '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Jane,Doe,https://linkedin.com/in/janedoe,,Datavant,"Director, Platform",03 Aug 2026',
    'No,Employer,https://x,,,Consultant,01 Jan 2020',
  ].join('\n');
  const { connections, quality } = parseConnections(export_);
  check('preamble skipped', connections.length === 1);
  check('name joined', connections[0].name === 'Jane Doe');
  check('quoted position kept', connections[0].title === 'Director, Platform');
  check('date parsed', connections[0].connectedOn === '2026-08-03');
  check('missing employer counted', quality.noCompany === 1);

  check('header by content, not offset',
    findHeaderRow(parseCsv('x\ny\nz\nFirst Name,Company\nA,B\n')) === 3);

  const joined = joinConnections(connections, [
    { company: 'Datavant', source: 'tracker', tokens: companyTokens('Datavant'), tracker: { num: '23', status: 'Applied' } },
    { company: 'Datavant', source: 'portals', tokens: companyTokens('Datavant'), tracker: null },
  ]);
  check('targets deduped, tracker wins', joined.targets.length === 1 && joined.targets[0].source === 'tracker');
  check('connection attached once', joined.targets[0].connections.length === 1);

  const weakOnly = joinConnections(
    [{ ...connections[0], company: 'GE', tokens: companyTokens('GE') }],
    [{ company: 'GE Vernova', source: 'tracker', tokens: companyTokens('GE Vernova'), tracker: { num: '1' } }],
  );
  check('weak excluded by default', weakOnly.targets.length === 0);

  const known = parseKnownContacts('# header\nJane Doe\tDatavant\tpeer\n\n');
  check('phonebook key built', known.has('janedoe::datavant'));

  const url = secondDegreeSearchUrl('Acme & Co');
  check('2nd-degree url encodes the company', url.includes('keywords=Acme%20%26%20Co'));
  check('2nd-degree url filters to 2nd degree', url.includes('network=%5B%22S%22%5D'));
  check('2nd-degree url is linkedin people search',
    url.startsWith('https://www.linkedin.com/search/results/people/?'));

  const placeholders = parseTrackerTargets([
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-01 | Stealth Startup | CTO | 4.0/5 | Evaluated | ❌ | [1](reports/x.md) | - |',
    '| 2 | 2026-01-01 | ? | CTO | 4.0/5 | Evaluated | ❌ | [2](reports/y.md) | - |',
    '| 3 | 2026-01-01 | Datavant | CTO | 4.0/5 | Applied | ❌ | [3](reports/z.md) | - |',
  ].join('\n'));
  check('placeholder targets dropped',
    placeholders.targets.length === 1 && placeholders.targets[0].company === 'Datavant');
  check('placeholder drops reported', placeholders.skipped.length === 2);

  console.log(failures.length
    ? `FAIL ${failures.length}/${passed + failures.length}\n  ${failures.join('\n  ')}`
    : `PASS ${passed}/${passed} self-test checks`);
  return failures.length ? 1 : 0;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (selfTestMode) return selfTest();

  if (trackerOnly && portalsOnly) {
    console.error('--tracker-only and --portals-only are mutually exclusive: '
      + 'together they exclude every target source. Pass neither to search both.');
    return 1;
  }

  if (Number.isNaN(sinceYear)) {
    console.error(`--since expects a 4-digit year, got "${sinceRaw}".`);
    return 1;
  }

  const csvText = readOrNull(csvPath);
  if (csvText === null) {
    console.error(`Connections export not readable: ${csvPath}\n` +
      'Export it from LinkedIn (Settings → Data Privacy → Get a copy of your data → Connections),\n' +
      'drop Connections.csv in data/, or pass --csv <path> pointing at the file.');
    return 1;
  }

  const { connections, quality } = parseConnections(csvText);

  const skippedTargets = [];
  let targetList = [];
  const trackerText = portalsOnly ? null : readOrNull(TRACKER_PATH);
  if (trackerText !== null) {
    const t = parseTrackerTargets(trackerText);
    targetList = targetList.concat(t.targets);
    skippedTargets.push(...t.skipped);
  }
  const portalsText = trackerOnly ? null : readOrNull(PORTALS_PATH);
  if (portalsText !== null) {
    const p = parsePortalTargets(portalsText);
    targetList = targetList.concat(p.targets);
    skippedTargets.push(...p.skipped);
  }

  const contactsText = readOrNull(CONTACTS_PATH);
  const known = contactsText === null ? new Set() : parseKnownContacts(contactsText);

  const sinceActive = sinceYear !== null;
  const undatedExcluded = sinceActive
    ? connections.filter(c => c.connectedYear == null).length
    : 0;
  const filtered = sinceActive
    ? connections.filter(c => c.connectedYear != null && c.connectedYear >= sinceYear)
    : connections;

  if (companyQuery) {
    const tokens = companyTokens(companyQuery);
    if (!tokens.distinctive.length) {
      console.error(`"${companyQuery}" has no identifying words to match on `
        + '(all generic or placeholder terms). Give a more specific company name.');
      return 1;
    }
    targetList = [{ company: companyQuery, source: 'query', tokens, tracker: null }];
  }

  const { targets, matchedConnections, targetCount } = joinConnections(filtered, targetList, { known, includeWeak });

  const result = {
    targets,
    totals: {
      connections: connections.length,
      connectionsConsidered: filtered.length,
      targets: targetCount,
      matchedCompanies: targets.length,
      matchedConnections,
    },
    quality: { ...quality, skippedTargets, undatedExcludedBySince: undatedExcluded },
    filters: {
      includeWeak,
      since: sinceYear,
      scope: trackerOnly ? 'tracker' : portalsOnly ? 'portals' : 'all',
      csv: csvPath,
    },
  };

  if (tsvMode) console.log(renderTsv(result));
  else if (companyQuery && !summaryMode) console.log(JSON.stringify(result, null, 2));
  else if (companyQuery) console.log(renderCompanyAnswer(result, companyQuery));
  else if (summaryMode) console.log(renderSummary(result));
  else console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
