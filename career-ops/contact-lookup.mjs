#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseContacts } from './contacts.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const CONTACTS_PATH = join(DATA_ROOT, 'data/contacts.tsv');

const KNOWN_FLAGS = ['--company', '--summary', '--self-test', '--help', '-h'];

const USAGE = `Usage:
  node contact-lookup.mjs --company <name>            # JSON: saved contacts at <name>
  node contact-lookup.mjs --company <name> --summary  # human-readable
  node contact-lookup.mjs --self-test                  # run the in-memory test suite
  node contact-lookup.mjs --help                       # print this usage block and exit`;

const args = isMainModule(import.meta.url) ? process.argv.slice(2) : [];
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--company'], requireOperand: true });
const selfTestMode = args.includes('--self-test');
const summaryMode = args.includes('--summary');
const companyQuery = flagValue(args, '--company') ?? null;

export function findContactsByCompany(contacts, company) {
  const key = normalizeCompany(company);
  if (!key) return [];
  return contacts.filter((c) => normalizeCompany(c.company) === key).reverse();
}

function renderSummary(company, matches) {
  const lines = [`\nSAVED CONTACTS @ ${company}\n`];
  if (!matches.length) {
    lines.push('  No saved contact at this company yet — nothing to surface before the cold search.\n');
    return lines.join('\n');
  }
  for (const c of matches) {
    const bits = [];
    if (c.title) bits.push(c.title);
    bits.push(c.type ? `type: ${c.type}` : 'type: —');
    bits.push(c.tracker ? `tracker #${c.tracker}` : 'tracker: —');
    lines.push(`  ${c.name} (${bits.join(', ')})`);
    if (c.notes) lines.push(`    notes: ${c.notes}`);
  }
  lines.push('');
  return lines.join('\n');
}

const CONTACTS_FIXTURE = [
  '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes',
  'Jane Doe\tAcme Inc.\tinterviewer\tEng Manager\t\tjane@acme.io\t\t012\tinterviewed me for the SWE role, March 2026',
  'Jörg Müller\tInitech\tpeer\t\t\tjoerg@initech.de\t\t-\tintro via meetup',
  'Old Jane\tAcme Inc.\trecruiter\tOld Title\t\t\t\t007\tolder saved line, same company',
].join('\n');

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); }
  };

  const { contacts } = parseContacts(CONTACTS_FIXTURE);

  const exact = findContactsByCompany(contacts, 'Acme Inc.');
  assert(exact.length === 2, `exact company name finds both Acme contacts, got ${exact.length}`);

  const folded = findContactsByCompany(contacts, 'ACME, Inc');
  assert(folded.length === 2, `normalized company name still matches, got ${folded.length}`);

  assert(folded[0].name === 'Old Jane', 'most-recently-listed row comes first (reversed order)');

  assert(findContactsByCompany(contacts, 'Globex').length === 0, 'no match -> empty array');

  const initech = findContactsByCompany(contacts, 'Initech');
  assert(initech.length === 1 && initech[0].name === 'Jörg Müller', 'distinct company matches only its own contact');

  assert(findContactsByCompany(contacts, '').length === 0, 'empty query -> empty array, never "matches everything"');
  assert(findContactsByCompany(contacts, '?').length === 0, '"?" placeholder query -> empty array');

  console.log('contact-lookup self-test OK (exact + normalized company matching, empty/placeholder guards)');
}

function main() {
  if (selfTestMode) { selfTest(); return; }

  if (!companyQuery) {
    console.error('--company is required, e.g. --company "Acme"');
    process.exit(1);
  }

  const content = existsSync(CONTACTS_PATH) ? readFileSync(CONTACTS_PATH, 'utf-8') : '';
  const { contacts } = parseContacts(content);
  const matches = findContactsByCompany(contacts, companyQuery);

  if (summaryMode) {
    console.log(renderSummary(companyQuery, matches));
  } else {
    console.log(JSON.stringify({ company: companyQuery, matches, total: matches.length }, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
