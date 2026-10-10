#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { validateFlags, hasFlag, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { unescapeFormulaCell } from './lib/tsv-formula-escape.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const CONTACTS_PATH = join(DATA_ROOT, 'data/contacts.tsv');
const DEFAULT_VCF = join(DATA_ROOT, 'output/contacts.vcf');


const KNOWN_FLAGS = ['--summary', '--self-test', '--caller-id', '--vcf', '--help', '-h'];

const USAGE = `Usage:
  node contacts.mjs                     # JSON: contacts + quality + total
  node contacts.mjs --summary           # human-readable table
  node contacts.mjs --vcf [path]        # write vCard, default output/contacts.vcf
  node contacts.mjs --vcf --caller-id   # FN as "Jane Doe (Acme recruiter)"
  node contacts.mjs --self-test         # run the in-memory test suite
  node contacts.mjs --help              # print this usage block and exit`;

const args = isMainModule(import.meta.url) ? process.argv.slice(2) : [];
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--vcf'] });
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const callerIdMode = args.includes('--caller-id');
const vcfMode = hasFlag(args, '--vcf');
const vcfPathArg = (() => {
  if (!vcfMode) return null;
  const val = flagValue(args, '--vcf');
  return val === undefined || val.startsWith('--') ? null : val || null;
})();

const VALID_TYPES = new Set(['recruiter', 'hiring-manager', 'peer', 'interviewer', 'internal-referral', 'other']);

export function parseContacts(content) {
  const contacts = [];
  const quality = { shortRows: [], missingRequired: [], invalidTypes: [], duplicates: [] };
  let lineNo = 0;
  for (const raw of String(content || '').split('\n')) {
    lineNo++;
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cells = line.split('\t').map(c => unescapeFormulaCell(c.trim()));
    if (cells.length < 4) { quality.shortRows.push({ line: lineNo, cells: cells.length }); continue; }
    const [name, company, type, title = '', phone = '', email = '', linkedin = '', tracker = ''] = cells;
    const notes = cells.slice(8).join(' ');
    if (!name || !company) { quality.missingRequired.push({ line: lineNo, name, company }); continue; }
    if (type && !VALID_TYPES.has(type)) quality.invalidTypes.push({ line: lineNo, name, type });
    contacts.push({ name, company, type, title, phone, email, linkedin, tracker: tracker === '-' ? null : tracker || null, notes });
  }
  const byUid = new Map();
  for (const c of contacts) {
    const uid = contactUid(c);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(c);
  }
  for (const [uid, group] of byUid) {
    if (group.length > 1) {
      const last = group[group.length - 1];
      quality.duplicates.push({ uid, name: last.name, company: last.company, count: group.length });
    }
  }
  return { contacts, quality };
}

export function escapeVcard(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function foldLine(line) {
  if (Buffer.byteLength(line, 'utf-8') <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf-8');
    if (curBytes + chBytes > 75) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
    }
    cur += ch;
    curBytes += chBytes;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeForHash(raw) {
  return String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function uidPart(raw) {
  const s = slug(raw);
  const h = createHash('sha1').update(normalizeForHash(raw), 'utf8').digest('hex').slice(0, 8);
  return s ? `${s}-${h}` : h;
}

export function contactUid(c) {
  return `careerops-${uidPart(c.name)}--${uidPart(c.company)}`;
}

export function contactToVcard(contact, { callerId = false, rev = null } = {}) {
  const c = contact;
  const parts = c.name.trim().split(/\s+/);
  const family = parts[parts.length - 1];
  const given = parts.slice(0, -1).join(' ');
  const fn = callerId ? `${c.name} (${c.company}${c.type ? ` ${c.type}` : ''})` : c.name;
  const noteParts = [];
  if (c.type) noteParts.push(c.type);
  if (c.tracker) noteParts.push(`tracker #${c.tracker}`);
  if (c.notes) noteParts.push(c.notes);

  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`UID:${contactUid(c)}`);
  lines.push(`FN:${escapeVcard(fn)}`);
  lines.push(`N:${escapeVcard(family)};${escapeVcard(given)};;;`);
  lines.push(`ORG:${escapeVcard(c.company)}`);
  if (c.title) lines.push(`TITLE:${escapeVcard(c.title)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${escapeVcard(c.phone)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVcard(c.email)}`);
  if (c.linkedin) lines.push(`URL:${escapeVcard(c.linkedin)}`);
  if (noteParts.length) lines.push(`NOTE:${escapeVcard(noteParts.join(' — '))}`);
  lines.push('CATEGORIES:career-ops');
  lines.push(`REV:${rev ?? new Date().toISOString()}`);
  lines.push('END:VCARD');
  return lines.map(foldLine).join('\r\n');
}

export function buildVcf(contacts, opts = {}) {
  if (!contacts.length) return '';
  const byUid = new Map();
  for (const c of contacts) byUid.set(contactUid(c), c);
  return [...byUid.values()].map(c => contactToVcard(c, opts)).join('\r\n') + '\r\n';
}

const CONTACTS_FIXTURE = [
  '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes',
  '',
  'Jane Doe\tAcme\trecruiter\tTalent Partner\t+49 151 1234567\tjane@acme.io\thttps://linkedin.com/in/janedoe\t012\tmet at screen; email, ok',
  '山田 太郎\tGlobex\thiring-manager\t\t\t\t\t-\t',
  'Jörg Müller\tInitech\tpeer\t\t\tjoerg@initech.de\t\t-\tintro via meetup',
  'Too\tFew',
  '\tNoName GmbH\tother\t',
  'Typo Type\tHooli\trecruter\t',
  'Tab Note\tHooli\tother\t\t\t\t\t-\tpart one\tpart two',
  'Jane Doe\tAcme\trecruiter\tTalent Partner\t+49 151 1234567\tjane@acme.io\thttps://linkedin.com/in/janedoe\t012\tupdated after call',
].join('\n');

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); }
  };

  const { contacts, quality } = parseContacts(CONTACTS_FIXTURE);
  assert(contacts.length === 6, `6 contacts parsed, got ${contacts.length}`);
  assert(contacts[0].name === 'Jane Doe' && contacts[0].tracker === '012', 'fields mapped');
  assert(contacts[1].tracker === null, '- tracker ref -> null');
  assert(parseContacts('').contacts.length === 0, 'empty store');
  assert(quality.shortRows.length === 1 && quality.shortRows[0].cells === 2, 'short row reported');
  assert(quality.missingRequired.length === 1 && quality.missingRequired[0].company === 'NoName GmbH', 'empty name reported, columns not shifted');
  assert(quality.invalidTypes.length === 1 && quality.invalidTypes[0].type === 'recruter', 'off-enum type reported');
  assert(contacts.some(c => c.name === 'Typo Type'), 'off-enum type contact kept, not dropped');
  assert(contacts.find(c => c.name === 'Tab Note').notes === 'part one part two', 'tab inside notes folds back (tab -> space), tail cells never dropped');
  assert(quality.duplicates.length === 1 && /^careerops-jane-doe-[0-9a-f]{8}--acme-[0-9a-f]{8}$/.test(quality.duplicates[0].uid) && quality.duplicates[0].count === 2,
    'duplicate name+company reported in quality.duplicates');

  assert(escapeVcard('a\\b;c,d\ne') === 'a\\\\b\\;c\\,d\\ne', 'escape order backslash;comma newline');
  assert(escapeVcard('x\r\ny') === 'x\\ny', 'CRLF collapses to one \\n');
  assert(escapeVcard(null) === '', 'null -> empty');

  const ascii = foldLine('NOTE:' + 'x'.repeat(100));
  const asciiLines = ascii.split('\r\n');
  assert(asciiLines.length === 2 && Buffer.byteLength(asciiLines[0], 'utf-8') === 75, 'ASCII folds at exactly 75 octets');
  assert(asciiLines[1].startsWith(' ') && asciiLines.map((l, i) => (i ? l.slice(1) : l)).join('') === 'NOTE:' + 'x'.repeat(100), 'continuation starts with one space, content preserved');
  const cjk = foldLine('NOTE:' + 'あ'.repeat(40));
  const cjkLines = cjk.split('\r\n');
  assert(Buffer.byteLength(cjkLines[0], 'utf-8') === 74, `CJK fold closes at 74 octets (never splits あ), got ${Buffer.byteLength(cjkLines[0], 'utf-8')}`);
  assert(cjkLines.every(l => Buffer.byteLength(l, 'utf-8') <= 75), 'every folded CJK line <= 75 octets');
  assert(cjkLines.map((l, i) => (i ? l.slice(1) : l)).join('') === 'NOTE:' + 'あ'.repeat(40), 'CJK content survives folding intact');

  assert(slug('Jörg Müller') === 'j-rg-m-ller', 'slug collapses non-alphanumerics');
  assert(slug('--Acme  Inc.--') === 'acme-inc', 'slug trims dashes');
  assert(/^jane-doe-[0-9a-f]{8}$/.test(uidPart('Jane Doe')), 'uidPart = pretty slug + raw-value hash for ASCII');
  assert(/^[0-9a-f]{8}$/.test(uidPart('山田 太郎')), 'empty slug (CJK) is the bare 8-hex sha1');
  const taroPart1 = uidPart('山田 太郎');
  const taroPart2 = uidPart('山田 太郎');
  assert(taroPart1 === taroPart2, 'uidPart deterministic across two calls');
  assert(uidPart('山田 太郎') !== uidPart('佐藤 花子'), 'different CJK names never collide');
  assert(slug('José') === slug('Josè'), 'distinct accented names slug identically');
  assert(uidPart('José') !== uidPart('Josè'), 'lossy-equal slugs still get distinct UID parts');
  assert(contactUid({ name: 'José', company: 'Acme' }) !== contactUid({ name: 'Josè', company: 'Acme' }),
    'distinct raw names that slug the same produce different contact UIDs');
  assert(uidPart('José') === uidPart('JOSÉ') && uidPart('José') === uidPart('  josé  '),
    'case + surrounding-whitespace variants of one name get the same UID part');
  assert(normalizeForHash('José'.normalize('NFC')) === normalizeForHash('José'.normalize('NFD')),
    'NFC vs NFD composition folds to one normalized hash input');
  assert(normalizeForHash('José') !== normalizeForHash('Josè'), 'normalizeForHash keeps é vs è distinct');
  const cjkCard = contactToVcard(contacts[1], { rev: '2026-07-09T00:00:00.000Z' });
  assert(/UID:careerops-[0-9a-f]{8}--globex-[0-9a-f]{8}\r\n/.test(cjkCard), 'CJK contact UID: bare hash name part, slug+hash company part');
  const card = contactToVcard(contacts[0], { rev: '2026-07-09T00:00:00.000Z' });
  assert(/UID:careerops-jane-doe-[0-9a-f]{8}--acme-[0-9a-f]{8}\r\n/.test(card), 'UID = careerops-{uidPart(name)}--{uidPart(company)}');
  assert(card === contactToVcard(contacts[0], { rev: '2026-07-09T00:00:00.000Z' }), 'card deterministic under pinned REV');
  assert(card.includes('FN:Jane Doe\r\n'), 'default FN is the plain name');
  assert(card.includes('N:Doe;Jane;;;'), 'N best-effort Last;First split');
  assert(card.includes('NOTE:recruiter — tracker #012 — met at screen\\; email\\, ok'), 'NOTE joins type + tracker + notes with escaping');
  const callerCard = contactToVcard(contacts[0], { callerId: true, rev: '2026-07-09T00:00:00.000Z' });
  assert(callerCard.includes('FN:Jane Doe (Acme recruiter)'), '--caller-id FN variant');

  const vcf = buildVcf(contacts.slice(0, 2), { rev: '2026-07-09T00:00:00.000Z' });
  assert(vcf.endsWith('END:VCARD\r\n'), 'vcf ends with CRLF');
  assert(!/[^\r]\n/.test(vcf) && !vcf.startsWith('\n'), 'no bare LF anywhere');
  assert((vcf.match(/BEGIN:VCARD/g) || []).length === 2, 'one card per contact');
  const dedupVcf = buildVcf(contacts, { rev: '2026-07-09T00:00:00.000Z' });
  assert((dedupVcf.match(/BEGIN:VCARD/g) || []).length === 5, '6 rows, 1 duplicate pair -> 5 cards');
  assert(dedupVcf.includes('updated after call') && !dedupVcf.includes('met at screen'), 'LAST duplicate occurrence wins the export');
  assert(buildVcf([]) === '', 'empty store -> empty vcf');

  console.log('contacts self-test OK (parser + escaping + byte-safe folding + UID fallback + dedup + emitter)');
}

function printSummary(contacts, quality) {
  console.log('\nCONTACTS — job-search phonebook\n');

  if (!contacts.length) {
    console.log('  No contacts yet.');
    console.log('  Add lines to data/contacts.tsv:');
    console.log('  {name}\\t{company}\\t{type}\\t{title}\\t{phone}\\t{email}\\t{linkedin}\\t{tracker#|-}\\t{notes}');
    console.log('  Export to your phone with: node contacts.mjs --vcf');
  } else {
    const rows = contacts.map(c => [
      c.name, c.company, c.type || '—',
      ['phone', 'email', 'linkedin'].filter(ch => c[ch]).join(',') || '—',
      c.tracker ? `#${c.tracker}` : '—',
    ]);
    const header = ['NAME', 'COMPANY', 'TYPE', 'CHANNELS', 'APP'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    for (const r of [header, ...rows]) {
      console.log('  ' + r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
    }
  }

  console.log('\n  Data quality:');
  if (quality.shortRows.length) {
    console.log(`  ⚠ ${quality.shortRows.length} row${quality.shortRows.length === 1 ? '' : 's'} with fewer than 4 cells (skipped):`);
    for (const r of quality.shortRows) console.log(`      line ${r.line} (${r.cells} cell${r.cells === 1 ? '' : 's'})`);
  } else {
    console.log('  short rows: none');
  }
  if (quality.missingRequired.length) {
    console.log(`  ⚠ ${quality.missingRequired.length} row${quality.missingRequired.length === 1 ? '' : 's'} missing name or company (skipped):`);
    for (const r of quality.missingRequired) console.log(`      line ${r.line}: name "${r.name}", company "${r.company}"`);
  } else {
    console.log('  missing name/company: none');
  }
  if (quality.invalidTypes.length) {
    console.log(`  ⚠ ${quality.invalidTypes.length} contact${quality.invalidTypes.length === 1 ? '' : 's'} with off-enum type (kept — check for typos, e.g. recruter vs recruiter):`);
    for (const r of quality.invalidTypes) console.log(`      line ${r.line} ${r.name}: type "${r.type}"`);
  } else {
    console.log('  off-enum types: none');
  }
  if (quality.duplicates.length) {
    console.log(`  ⚠ ${quality.duplicates.length} duplicated contact${quality.duplicates.length === 1 ? '' : 's'} (same name+company — the LAST line wins the --vcf export):`);
    for (const d of quality.duplicates) console.log(`      ${d.name} @ ${d.company} (${d.count} lines, ${d.uid})`);
  } else {
    console.log('  duplicates: none');
  }
  console.log(`  total: ${contacts.length} contact${contacts.length === 1 ? '' : 's'}`);
  console.log('');
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeVcf(contacts, quality) {
  const issues = quality.shortRows.length + quality.missingRequired.length
    + quality.invalidTypes.length + quality.duplicates.length;
  if (issues) {
    console.error(`⚠ ${issues} data-quality issue${issues === 1 ? '' : 's'} in data/contacts.tsv (details: node contacts.mjs --summary):`);
    if (quality.shortRows.length) console.error(`    ${quality.shortRows.length} row${quality.shortRows.length === 1 ? '' : 's'} with fewer than 4 cells (skipped)`);
    if (quality.missingRequired.length) console.error(`    ${quality.missingRequired.length} row${quality.missingRequired.length === 1 ? '' : 's'} missing name or company (skipped)`);
    if (quality.invalidTypes.length) console.error(`    ${quality.invalidTypes.length} contact${quality.invalidTypes.length === 1 ? '' : 's'} with off-enum type (kept)`);
    if (quality.duplicates.length) console.error(`    ${quality.duplicates.length} duplicated contact${quality.duplicates.length === 1 ? '' : 's'} (the last line wins)`);
  }
  if (!contacts.length) {
    console.log('No contacts to export — data/contacts.tsv is empty or missing. No file written.');
    return;
  }
  const outPath = resolve(vcfPathArg ?? DEFAULT_VCF);
  const relOut = relative(CAREER_OPS, outPath);
  if (relOut === '' || relOut.startsWith('..') || isAbsolute(relOut)) {
    console.error(`Refusing to write the vCard outside the project directory: ${outPath}`);
    process.exit(1);
  }
  const vcf = buildVcf(contacts, { callerId: callerIdMode });
  const cards = (vcf.match(/BEGIN:VCARD/g) || []).length;
  mkdirSync(dirname(outPath), { recursive: true });
  if (isSymlink(outPath)) {
    console.error(`Refusing to write the vCard outside the project directory: ${outPath}`);
    process.exit(1);
  }
  const repoReal = realpathSync(CAREER_OPS);
  const canonicalTarget = existsSync(outPath)
    ? realpathSync(outPath)
    : join(realpathSync(dirname(outPath)), basename(outPath));
  const relReal = relative(repoReal, canonicalTarget);
  if (relReal === '' || relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) {
    console.error(`Refusing to write the vCard outside the project directory: ${outPath}`);
    process.exit(1);
  }
  writeFileSync(outPath, vcf);
  console.log(`Wrote ${cards} contact${cards === 1 ? '' : 's'} → ${outPath}`);
}

function main() {
  if (selfTestMode) { selfTest(); return; }

  const content = existsSync(CONTACTS_PATH) ? readFileSync(CONTACTS_PATH, 'utf-8') : '';
  const { contacts, quality } = parseContacts(content);

  if (vcfMode) {
    writeVcf(contacts, quality);
  } else if (summaryMode) {
    printSummary(contacts, quality);
  } else {
    console.log(JSON.stringify({ contacts, quality, total: contacts.length }, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
