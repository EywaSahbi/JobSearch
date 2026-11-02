#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { loadCanonicalStates, foldStatusInput } from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODEBASE_ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

const FOLLOWUPS_FILE = join(CAREER_OPS, 'data/follow-ups.md');
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(CAREER_OPS, 'config/profile.yml');


const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const overdueOnly = args.includes('--overdue-only');
const appliedDaysRaw = flagValue(args, '--applied-days');

const APPLIED_DAYS_RE = /^\d+$/;
export function parseAppliedDaysOverride(raw) {
  return raw !== undefined && APPLIED_DAYS_RE.test(raw) ? parseInt(raw, 10) : null;
}
const appliedDaysOverride = parseAppliedDaysOverride(appliedDaysRaw);

export const DEFAULT_CADENCE = {
  applied_first: 7,
  applied_subsequent: 7,
  applied_max_followups: 2,
  responded_initial: 1,
  responded_subsequent: 3,
  interview_thankyou: 1,
};

const PROFILE_CADENCE_KEYS = {
  applied_first_days: 'applied_first',
  applied_subsequent_days: 'applied_subsequent',
  applied_max_followups: 'applied_max_followups',
  responded_initial_days: 'responded_initial',
  responded_subsequent_days: 'responded_subsequent',
  interview_thankyou_days: 'interview_thankyou',
};

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function loadProfileCadence(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return {};
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
  const source = raw.followup_cadence || {};
  const cadence = {};
  for (const [profileKey, cadenceKey] of Object.entries(PROFILE_CADENCE_KEYS)) {
    const parsed = positiveInteger(source[profileKey]);
    if (parsed !== null) cadence[cadenceKey] = parsed;
  }
  return cadence;
}

export function resolveCadenceConfig({ profilePath = PROFILE_FILE, appliedDays = appliedDaysOverride } = {}) {
  const cadence = { ...DEFAULT_CADENCE, ...loadProfileCadence(profilePath) };
  const cliApplied = positiveInteger(appliedDays);
  if (cliApplied !== null) cadence.applied_first = cliApplied;
  return cadence;
}

const CADENCE = resolveCadenceConfig();

let aliasMapCache = null;

function statusAliasMap() {
  if (aliasMapCache) return aliasMapCache;
  const map = new Map();
  try {
    for (const st of loadCanonicalStates(join(CODEBASE_ROOT, 'templates', 'states.yml'))) {
      const id = st.id.toLowerCase();
      map.set(foldStatusInput(id), id);
      if (st.label) map.set(foldStatusInput(st.label), id);
      for (const a of st.aliases) map.set(foldStatusInput(a), id);
    }
  } catch (err) {
    console.error(`[followup-cadence] cannot read canonical states from templates/states.yml: ${err.message}`);
    return (aliasMapCache = new Map());
  }
  return (aliasMapCache = map);
}

const ACTIONABLE_STATUSES = ['applied', 'responded', 'interview'];

export function normalizeStatus(raw) {
  const clean = foldStatusInput(String(raw).replace(/\s+\d{4}-\d{2}-\d{2}.*$/, ''));
  return statusAliasMap().get(clean) || clean;
}

function today() {
  return new Date(localToday());
}

export function parseDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return null;
  const s = dateStr.trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

const APPLIED_DATE_SOURCE = String.raw`\bapplied\b[^.;?!\r\n\u2028\u2029]{0,39}?[^\S\r\n\u2028\u2029]~?(\d{4}-\d{2}-\d{2})(?![\w-])`;
const APPLIED_DATE_RE = new RegExp(APPLIED_DATE_SOURCE, 'gi');
const APPLIED_DATE_HAS_DATE_RE = new RegExp(APPLIED_DATE_SOURCE, 'i');

export function parseAppliedDate(notes, options = {}) {
  if (!notes) return null;
  const validateCalendar = options.requireValidCalendarDate === true;
  const text = String(notes);

  const matches = [];
  for (const m of text.matchAll(APPLIED_DATE_RE)) {
    if (!validateCalendar || isRealCalendarDate(m[1])) matches.push({ date: m[1], index: m.index });
  }
  if (matches.length === 0) return null;

  const own = matches.filter(m => !isCrossReferencedMention(text, m.index));

  if (own.length > 0) return own[0].date;

  return null;
}

const CROSS_REF_LOOKBACK = 120;

const REQ_LABELLED_HASH_RE = /\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:_-]*$/i;

function isCrossReferencedMention(text, index) {
  const windowStart = Math.max(0, index - CROSS_REF_LOOKBACK);
  const window = text.slice(windowStart, index);
  let refEnd = -1;
  for (const m of window.matchAll(/(?<![\w-])#\d+\b/g)) {
    if (m.index === 0 && /[\w-]/.test(text[windowStart - 1] ?? '')) continue;
    if (REQ_LABELLED_HASH_RE.test(window.slice(0, m.index))) continue;
    refEnd = m.index + m[0].length;
  }
  if (refEnd === -1) return false;

  const sinceRef = window.slice(refEnd);
  if (/[.!?]\s/.test(sinceRef)) return false;

  const lastSeparator = [...sinceRef.matchAll(/[;|]/g)].pop();
  if (lastSeparator) {
    const beforeSeparator = sinceRef.slice(0, lastSeparator.index);
    if (APPLIED_DATE_HAS_DATE_RE.test(beforeSeparator)) return false;
  }
  return true;
}

export function isRealCalendarDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return false;
  const [y, mo, d] = iso.split('-').map(Number);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function resolveAppliedDate(app) {
  const fromNotes = parseAppliedDate(app?.notes, { requireValidCalendarDate: true });
  return fromNotes
    ? { appliedDate: fromNotes, appDateSource: 'notes' }
    : { appliedDate: app?.date ?? null, appDateSource: 'evaluation-date-fallback' };
}

export function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

export function addDays(date, days) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().split('T')[0];
}

function parseTrackerContent(content) {
  const lines = String(content ?? '').split('\n');
  const parseOptions = { allowTabs: true, allowIndentation: true };
  const colmap = resolveColumns(lines, parseOptions);
  const entries = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap, parseOptions);
    if (row) entries.push(row);
  }
  return entries;
}

const BULLET_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+#(\d+)\s+(.+?)(?:\s+—\s+(.*))?$/;

export function parseFollowups(content) {
  const entries = [];
  for (const line of String(content ?? '').split('\n')) {
    if (line.startsWith('|')) {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length < 8) continue;
      const num = parseInt(parts[1]);
      if (isNaN(num)) continue;
      const appNum = parseInt(parts[2]);
      if (isNaN(appNum)) continue;
      entries.push({
        num,
        appNum,
        date: parts[3],
        company: parts[4],
        role: parts[5],
        channel: parts[6],
        contact: parts[7],
        notes: parts[8] || '',
      });
      continue;
    }
    const m = line.match(BULLET_RE);
    if (!m) continue;
    entries.push({
      num: null,
      appNum: parseInt(m[2]),
      date: m[1],
      company: m[3],
      role: '',
      channel: 'Other',
      contact: '',
      notes: m[4] || '',
    });
  }
  return entries;
}

export { parseFollowups as parseFollowupsContent };

const OVERRIDE_RE = /^-\s+next\s+#(\d+)\s+(\d{4}-\d{2}-\d{2})(?:\s+\(set\s+(\d{4}-\d{2}-\d{2})\))?(?:\s*[—–-].*)?\s*$/i;

export function parseNextOverrides(content) {
  const byApp = new Map();
  for (const line of content.split('\n')) {
    const m = line.match(OVERRIDE_RE);
    if (!m) continue;
    const date = m[2];
    if (!parseDate(date)) continue;
    const appNum = parseInt(m[1]);
    byApp.set(appNum, { appNum, date, setDate: m[3] || date });
  }
  return byApp;
}

export function resolveNextOverride(override, lastFollowupDate) {
  if (!override) return null;
  if (lastFollowupDate && lastFollowupDate > override.setDate) return null;
  return override.date;
}

const CLEARED_RE = /^-\s+cleared\s+#(\d+)\s+(\d{4}-\d{2}-\d{2})(?:\s*[—–-].*)?\s*$/i;

export function parseClearedDirectives(content) {
  const byApp = new Map();
  for (const line of String(content ?? '').split('\n')) {
    const m = line.match(CLEARED_RE);
    if (!m) continue;
    const setDate = m[2];
    if (!parseDate(setDate)) continue;
    const appNum = parseInt(m[1]);
    byApp.set(appNum, { appNum, setDate });
  }
  return byApp;
}

export function isRetired(cleared, lastFollowupDate) {
  if (!cleared) return false;
  if (lastFollowupDate && lastFollowupDate > cleared.setDate) return false;
  return true;
}

const EMAIL_RE = /[\w.+%-]+@[\w.-]+\.\w+/g;

const OUTREACH_NAME_RE = /\b(?:recruiter|hiring manager|messaged|contacted|emailed|called|reached out to|spoke with|outreach)\b[\s(]*([A-Z][a-z]*(?:[-'’][A-Z]?[a-z]+)*(?:\s+[A-Z][a-z]*(?:[-'’][A-Z]?[a-z]+)*)+)/g;

function splitStatements(notes) {
  return String(notes).split(/[;\n]+|\.\s+(?=[A-Z])/).filter(s => s.trim());
}

export function loadSelfIdentities(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return new Set();
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return new Set();
  }
  const out = new Set();
  const push = (v) => { if (typeof v === 'string' && v.includes('@')) out.add(v.trim().toLowerCase()); };
  push(raw.candidate?.email);
  const alternates = raw.candidate?.alternate_emails;
  if (Array.isArray(alternates)) for (const alt of alternates) push(alt);
  return out;
}

const SELF_IDENTITIES = loadSelfIdentities();

export function extractContacts(notes, selfIdentities = SELF_IDENTITIES) {
  if (!notes) return [];
  const byEmail = new Map();
  const byName = new Map();
  const contacts = [];

  const add = ({ name, email, channel }) => {
    const emailKey = email ? email.toLowerCase() : null;
    const nameKey = name ? name.toLowerCase() : null;

    const byEmailHit = emailKey ? byEmail.get(emailKey) : null;
    const byNameHit = nameKey ? byName.get(nameKey) : null;

    if (byEmailHit && byNameHit && byEmailHit !== byNameHit) {
      byEmailHit.name = byEmailHit.name || byNameHit.name;
      byEmailHit.email = byEmailHit.email || byNameHit.email;
      byEmailHit.channel = byEmailHit.channel || byNameHit.channel;
      const idx = contacts.indexOf(byNameHit);
      if (idx !== -1) contacts.splice(idx, 1);
      for (const [k, v] of byEmail) if (v === byNameHit) byEmail.set(k, byEmailHit);
      for (const [k, v] of byName) if (v === byNameHit) byName.set(k, byEmailHit);
    }

    const existing = byEmailHit || byNameHit || null;
    if (existing) {
      if (!existing.name && name) existing.name = name;
      if (!existing.email && email) existing.email = email;
      if (!existing.channel && channel) existing.channel = channel;
      if (existing.email) byEmail.set(existing.email.toLowerCase(), existing);
      if (existing.name) byName.set(existing.name.toLowerCase(), existing);
      return;
    }

    const contact = { name: name ?? null, email: email ?? null, channel: channel ?? null };
    contacts.push(contact);
    if (emailKey) byEmail.set(emailKey, contact);
    if (nameKey) byName.set(nameKey, contact);
  };

  for (const span of splitStatements(notes)) {
    const emails = span.match(EMAIL_RE) || [];
    const names = [...span.matchAll(OUTREACH_NAME_RE)].map(m => m[1].trim());
    if (!emails.length && !names.length) continue;
    const channel = detectChannel(span, emails.length > 0);

    if (names.length === 1 && emails.length === 1) {
      add({ name: names[0], email: emails[0], channel });
      continue;
    }

    for (const email of emails) {
      let name = null;
      const beforeEmail = span.substring(0, span.indexOf(email));
      const nameMatch = beforeEmail.match(/(?:emailed|contact[:\s]+|to\s+)([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*(?:at|@|$)/i);
      if (nameMatch) name = nameMatch[1].trim();
      add({ name, email, channel });
    }
    for (const name of names) add({ name, email: null, channel });
  }

  return contacts.filter((c) => !(c.email && selfIdentities.has(c.email.toLowerCase())));
}

function detectChannel(span, hasEmail = false) {
  if (/\blinkedin\b/i.test(span)) return 'linkedin';
  if (/\bphone\b|\bcalled\b/i.test(span)) return 'phone';
  if (/\bemail(ed)?\b/i.test(span) || hasEmail) return 'email';
  return null;
}

export function contactLabel(contact) {
  if (!contact) return '-';
  return contact.email || contact.name || '-';
}

export function resolveReportPath(reportField, appsFile = APPS_FILE, repoRoot = CAREER_OPS) {
  const match = reportField.match(/\]\(([^)]+)\)/);
  if (!match) return null;
  const fullPath = join(dirname(appsFile), match[1]);
  const repoRelative = relative(repoRoot, fullPath).split(sep).join('/');
  if (repoRelative.startsWith('../') || repoRelative === '..' || !repoRelative.startsWith('reports/')) return null;
  return existsSync(fullPath) ? repoRelative : null;
}

export function computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount) {
  if (status === 'applied') {
    if (followupCount >= CADENCE.applied_max_followups) return 'cold';
    if (followupCount === 0 && daysSinceApp >= CADENCE.applied_first) return 'overdue';
    if (followupCount > 0 && daysSinceLastFollowup !== null && daysSinceLastFollowup >= CADENCE.applied_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'responded') {
    if (daysSinceLastFollowup !== null) {
      return daysSinceLastFollowup >= CADENCE.responded_subsequent ? 'overdue' : 'waiting';
    }
    if (daysSinceApp < CADENCE.responded_initial) return 'urgent';
    if (daysSinceApp >= CADENCE.responded_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'interview') {
    if (daysSinceLastFollowup !== null) {
      return daysSinceLastFollowup >= CADENCE.responded_subsequent ? 'overdue' : 'waiting';
    }
    return daysSinceApp >= CADENCE.interview_thankyou ? 'overdue' : 'waiting';
  }
  return 'waiting';
}

export function computeNextFollowupDate(status, appDate, lastFollowupDate, followupCount) {
  if (status === 'applied') {
    if (followupCount >= CADENCE.applied_max_followups) return null;
    if (followupCount === 0) return addDays(parseDate(appDate), CADENCE.applied_first);
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.applied_subsequent);
    return addDays(parseDate(appDate), CADENCE.applied_first);
  }
  if (status === 'responded') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.responded_subsequent);
    return addDays(parseDate(appDate), CADENCE.responded_initial);
  }
  if (status === 'interview') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.responded_subsequent);
    return addDays(parseDate(appDate), CADENCE.interview_thankyou);
  }
  return null;
}

export function analyzeFromContent(trackerContent, followupsContent = '') {
  const apps = parseTrackerContent(trackerContent);
  if (apps.length === 0) {
    return { error: 'No applications found in tracker.', cadenceDefaults: DEFAULT_CADENCE };
  }

  const followups = parseFollowups(followupsContent);
  const overrides = parseNextOverrides(String(followupsContent ?? ''));
  const cleared = parseClearedDirectives(followupsContent);

  const followupsByApp = new Map();
  for (const fu of followups) {
    if (!followupsByApp.has(fu.appNum)) followupsByApp.set(fu.appNum, []);
    followupsByApp.get(fu.appNum).push(fu);
  }

  const now = today();
  const entries = [];

  for (const app of apps) {
    const normalized = normalizeStatus(app.status);
    if (!ACTIONABLE_STATUSES.includes(normalized)) continue;

    const { appliedDate, appDateSource } = resolveAppliedDate(app);
    const appDate = parseDate(appliedDate);
    if (!appDate) continue;

    const daysSinceApp = daysBetween(appDate, now);
    const appFollowups = followupsByApp.get(app.num) || [];
    const followupCount = appFollowups.length;

    let lastFollowupDate = null;
    let daysSinceLastFollowup = null;
    const sortedFollowups = [...appFollowups].sort((a, b) => (a.date > b.date ? -1 : 1));
    if (sortedFollowups.length > 0) {
      lastFollowupDate = sortedFollowups[0].date;
      const lastDate = parseDate(lastFollowupDate);
      if (lastDate) daysSinceLastFollowup = daysBetween(lastDate, now);
    }

    let urgency = computeUrgency(normalized, daysSinceApp, daysSinceLastFollowup, followupCount);
    let nextFollowupDate = computeNextFollowupDate(normalized, appliedDate, lastFollowupDate, followupCount);

    const nextOverride = resolveNextOverride(overrides.get(app.num), lastFollowupDate);
    if (nextOverride) {
      nextFollowupDate = nextOverride;
      urgency = daysBetween(parseDate(nextOverride), now) >= 0 ? 'overdue' : 'waiting';
    }

    const retired = isRetired(cleared.get(app.num), lastFollowupDate);
    if (retired) {
      urgency = 'retired';
      nextFollowupDate = null;
    }

    const nextDate = nextFollowupDate ? parseDate(nextFollowupDate) : null;
    const daysUntilNext = nextDate ? daysBetween(now, nextDate) : null;

    const contacts = extractContacts(app.notes);
    const reportPath = resolveReportPath(app.report);

    entries.push({
      num: app.num,
      date: app.date,
      appliedDate,
      appDateSource,
      company: app.company,
      via: app.via && app.via !== '—' ? app.via : null,
      role: app.role,
      status: normalized,
      score: app.score,
      notes: app.notes,
      reportPath,
      contacts,
      daysSinceApplication: daysSinceApp,
      daysSinceLastFollowup,
      followupCount,
      followups: sortedFollowups,
      urgency,
      nextFollowupDate,
      nextOverride,
      daysUntilNext,
    });
  }

  const urgencyOrder = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };
  entries.sort((a, b) => (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9));

  const retiredCount = entries.filter(e => e.urgency === 'retired').length;
  const active = entries.filter(e => e.urgency !== 'retired');

  const filtered = overdueOnly
    ? active.filter(e => e.urgency === 'overdue' || e.urgency === 'urgent')
    : active;

  return {
    metadata: {
      analysisDate: now.toISOString().split('T')[0],
      totalTracked: apps.length,
      actionable: active.length,
      overdue: active.filter(e => e.urgency === 'overdue').length,
      urgent: active.filter(e => e.urgency === 'urgent').length,
      cold: active.filter(e => e.urgency === 'cold').length,
      waiting: active.filter(e => e.urgency === 'waiting').length,
      retired: retiredCount,
    },
    entries: filtered,
    cadenceConfig: CADENCE,
    cadenceDefaults: DEFAULT_CADENCE,
  };
}

function analyze() {
  const trackerContent = existsSync(APPS_FILE) ? readFileSync(APPS_FILE, 'utf-8') : '';
  const followupsContent = existsSync(FOLLOWUPS_FILE) ? readFileSync(FOLLOWUPS_FILE, 'utf-8') : '';
  return analyzeFromContent(trackerContent, followupsContent);
}

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }

  const { metadata, entries } = result;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Follow-up Cadence Dashboard — ${metadata.analysisDate}`);
  console.log(`  ${metadata.totalTracked} total applications, ${metadata.actionable} actionable`);
  console.log(`${'='.repeat(70)}\n`);

  if (entries.length === 0) {
    console.log('  No active applications to track. Apply to some roles first.\n');
    return;
  }

  const urgencyIcon = { urgent: 'URGENT', overdue: 'OVERDUE', waiting: 'waiting', cold: 'COLD' };
  console.log(`  ${metadata.urgent} urgent | ${metadata.overdue} overdue | ${metadata.waiting} waiting | ${metadata.cold} cold\n`);

  console.log('  ' + '#'.padEnd(5) + 'Company'.padEnd(16) + 'Status'.padEnd(12) + 'Days'.padEnd(6) + 'F/U'.padEnd(5) + 'Next'.padEnd(13) + 'Urgency'.padEnd(10) + 'Contact');
  console.log('  ' + '-'.repeat(80));

  for (const e of entries) {
    const urgLabel = urgencyIcon[e.urgency] || e.urgency;
    const nextStr = e.nextFollowupDate || '-';
    const contactStr = e.contacts.length > 0 ? contactLabel(e.contacts[0]) : '-';
    console.log(
      '  ' +
      String(e.num).padEnd(5) +
      e.company.substring(0, 15).padEnd(16) +
      e.status.padEnd(12) +
      String(e.daysSinceApplication).padEnd(6) +
      String(e.followupCount).padEnd(5) +
      nextStr.padEnd(13) +
      urgLabel.padEnd(10) +
      contactStr
    );
  }

  console.log('');
}

const KNOWN_FLAGS = ['--summary', '--json', '--overdue-only', '--applied-days', '--help', '-h'];
const VALUE_FLAGS = ['--applied-days'];

const USAGE = `Usage:
  node followup-cadence.mjs                    # full JSON analysis to stdout
  node followup-cadence.mjs --json             # same as above, JSON is the default
  node followup-cadence.mjs --summary          # human-readable dashboard (wins over --json)
  node followup-cadence.mjs --overdue-only     # only show overdue/urgent entries
  node followup-cadence.mjs --applied-days 10  # override applied_first cadence (days)
  node followup-cadence.mjs --help|-h          # print this usage block and exit`;

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (appliedDaysRaw !== undefined && !(Number.isFinite(appliedDaysOverride) && appliedDaysOverride >= 0)) {
    console.error(`Error: --applied-days requires a non-negative integer, got "${appliedDaysRaw}"`);
    process.exit(1);
  }

  const result = analyze();

  if (summaryMode) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.error) process.exit(1);
}
