import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseTrackerRow, resolveColumns, isSeparatorRow, isHeaderRow } from './tracker-parse.mjs';
import { resolveTrackerPath, resolveWorkspaceRoot } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { canonicalOutcome } from './lib/outcome-types.mjs';
import { outcomeDirsFor } from './lib/outcome-dir.mjs';

const DATA_ROOT = getCareerOpsRoot();

export const JOURNAL_OUTCOMES = {
  hired: { reachedInterview: true, reachedOffer: true, terminal: true },
  offer_received: { reachedInterview: true, reachedOffer: true, terminal: true },
  offer_declined: { reachedInterview: true, reachedOffer: true, terminal: true },
  interview_progress: { reachedInterview: true, reachedOffer: false, terminal: false },
  interview_only: { reachedInterview: true, reachedOffer: false, terminal: true },
  rejected: { reachedInterview: false, reachedOffer: false, terminal: true },
  no_response: { reachedInterview: false, reachedOffer: false, terminal: true },
};

const TRACKER_TERMINAL = {
  hired: { reachedInterview: true, reachedOffer: true },
  offer: { reachedInterview: true, reachedOffer: true },
  interview: { reachedInterview: true, reachedOffer: false },
  rejected: { reachedInterview: false, reachedOffer: false },
};

const BANDS = [
  { key: '<3.5', min: -Infinity, max: 3.5 },
  { key: '3.5-3.9', min: 3.5, max: 4.0 },
  { key: '4.0-4.4', min: 4.0, max: 4.5 },
  { key: '>=4.5', min: 4.5, max: Infinity },
];

export function parseOutcomeJournal(text) {
  const entries = String(text ?? '').split(/^## Entry: /m).slice(1);
  let latestType = null;
  const feedback = [];
  for (const entry of entries) {
    const typeMatch = entry.match(/^- \*\*Outcome Type\*\*: *(\S+)/m);
    if (typeMatch) latestType = canonicalOutcome(typeMatch[1]);
    const fbMatch = entry.match(/- \*\*Verbatim Feedback\*\*:\n((?:> .*\n?)+)/);
    if (fbMatch) {
      const fb = fbMatch[1].split('\n').map((l) => l.replace(/^> ?/, '').trim()).filter(Boolean).join(' ');
      if (fb && fb !== 'None recorded') feedback.push(fb);
    }
  }
  return { latestType, feedback };
}

export function computeCalibration(rows, journals, opts = {}) {
  const minBandN = opts.minBandN ?? 5;
  const reached = opts.reached ?? new Map();

  const resolved = [];
  const inFlight = [];
  const unscored = [];
  const allFeedback = [];

  for (const row of rows) {
    const journal = journals.get(row.num);
    if (journal?.feedback?.length) {
      for (const fb of journal.feedback) allFeedback.push({ num: row.num, company: row.company, feedback: fb });
    }
    let verdict = null;
    const led = reached.get(row.num);
    if (journal?.latestType) {
      verdict = { source: 'journal', type: journal.latestType, ...JOURNAL_OUTCOMES[journal.latestType] };
    } else if (led && (led.reachedInterview || led.reachedOffer)) {
      verdict = { source: 'ledger', type: led.reachedOffer ? 'offer' : 'interview', reachedInterview: true, reachedOffer: !!led.reachedOffer };
    } else {
      const s = String(row.status || '').replace(/\*\*/g, '').trim().toLowerCase().replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '');
      if (TRACKER_TERMINAL[s]) verdict = { source: 'tracker', type: s, ...TRACKER_TERMINAL[s] };
      else if (['applied', 'responded'].includes(s)) { inFlight.push(row.num); continue; }
      else continue;
    }
    if (!Number.isFinite(row.score) || row.score <= 0) { unscored.push(row.num); continue; }
    resolved.push({ num: row.num, score: row.score, ...verdict });
  }

  const bands = BANDS.map((b) => {
    const members = resolved.filter((r) => r.score >= b.min && r.score < b.max);
    const interviews = members.filter((r) => r.reachedInterview).length;
    const offers = members.filter((r) => r.reachedOffer).length;
    const enough = members.length >= minBandN;
    return {
      band: b.key,
      n: members.length,
      interviews,
      offers,
      interviewRate: enough ? Math.round((interviews / members.length) * 100) : null,
      offerRate: enough ? Math.round((offers / members.length) * 100) : null,
    };
  });

  const rated = bands.filter((b) => b.interviewRate !== null);
  let verdict;
  if (rated.length < 2) {
    verdict = {
      kind: 'insufficient',
      text: `Not enough resolved outcomes to compare score bands yet (${resolved.length} resolved, floor ${minBandN} per band). Keep recording with /outcome and rerun.`,
    };
  } else {
    const low = rated[0];
    const high = rated[rated.length - 1];
    const gap = high.interviewRate - low.interviewRate;
    if (gap >= 10) {
      verdict = { kind: 'separating', text: `The scoring is separating for you: your ${high.band} applications reached interviews at ${high.interviewRate}% vs ${low.interviewRate}% for ${low.band}. Trusting the score is paying off.` };
    } else if (gap <= -10) {
      verdict = { kind: 'inverted', text: `Inverted signal: your ${low.band} applications are converting BETTER (${low.interviewRate}%) than your ${high.band} ones (${high.interviewRate}%). Worth reading what the high-scored rejections had in common before trusting the next 4.5.` };
    } else {
      verdict = { kind: 'flat', text: `No meaningful separation yet: ${high.band} converts at ${high.interviewRate}% vs ${low.interviewRate}% for ${low.band}. With more resolved outcomes this usually sharpens one way or the other.` };
    }
  }

  return {
    resolved: resolved.length,
    inFlight: inFlight.length,
    unscored: unscored.length,
    bands,
    verdict,
    feedback: allFeedback.slice(-10),
  };
}

export function loadTrackerRows(appsFile) {
  const lines = readFileSync(appsFile, 'utf-8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|') || isHeaderRow(line) || isSeparatorRow(line)) continue;
    const row = parseTrackerRow(line, colmap);
    if (!row || !Number.isFinite(row.num)) continue;
    const score = parseFloat(String(row.score ?? ''));
    rows.push({ num: row.num, company: row.company || '', score: Number.isFinite(score) ? score : null, status: row.status || '' });
  }
  return rows;
}

function loadJournals(workspaceRoot) {
  const journals = new Map();
  const dir = join(workspaceRoot, 'data', 'outcomes');
  if (!existsSync(dir)) return journals;

  const nums = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const numMatch = entry.name.match(/^(\d+)_/);
    if (numMatch) nums.add(parseInt(numMatch[1], 10));
  }
  for (const num of nums) {
    const dirs = outcomeDirsFor(dir, num);
    const logPath = dirs.length ? join(dir, dirs[0], 'outcome.md') : null;
    if (!logPath || !existsSync(logPath)) continue;
    const journal = parseOutcomeJournal(readFileSync(logPath, 'utf-8'));
    if (dirs.length > 1) journal.splitAcross = dirs;
    journals.set(num, journal);
  }
  return journals;
}

export function loadLedgerReached(workspaceRoot) {
  const reached = new Map();
  const logPath = join(workspaceRoot, 'data', 'status-log.tsv');
  if (!existsSync(logPath)) return reached;
  const INTERVIEW_PLUS = new Set(['interview', 'offer', 'hired']);
  const OFFER_PLUS = new Set(['offer', 'hired']);
  for (const line of readFileSync(logPath, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    const rawNum = String(c[0] || '').trim();
    const date = String(c[1] || '').trim();
    const rawFrom = String(c[2] || '').trim();
    const rawTo = String(c[3] || '').trim();
    if (!/^\d+$/.test(rawNum) || !date || !rawFrom || !rawTo) continue;
    const num = Number(rawNum);
    const from = rawFrom.toLowerCase();
    const to = rawTo.toLowerCase();
    const cur = reached.get(num) || { reachedInterview: false, reachedOffer: false };
    if (INTERVIEW_PLUS.has(from) || INTERVIEW_PLUS.has(to)) cur.reachedInterview = true;
    if (OFFER_PLUS.has(from) || OFFER_PLUS.has(to)) { cur.reachedOffer = true; cur.reachedInterview = true; }
    reached.set(num, cur);
  }
  return reached;
}

function renderHuman(result) {
  const out = [];
  out.push('📐 Calibration — your scores vs your real outcomes');
  out.push('');
  out.push(`Resolved outcomes: ${result.resolved} · in flight (not counted): ${result.inFlight} · unscored: ${result.unscored}`);
  out.push('');
  out.push('| Score band | n | Interviews | Offers | Interview rate | Offer rate |');
  out.push('|---|---|---|---|---|---|');
  for (const b of result.bands) {
    const ir = b.interviewRate === null ? '(n too small)' : `${b.interviewRate}%`;
    const or_ = b.offerRate === null ? '' : `${b.offerRate}%`;
    out.push(`| ${b.band} | ${b.n} | ${b.interviews} | ${b.offers} | ${ir} | ${or_} |`);
  }
  out.push('');
  out.push(`Verdict: ${result.verdict.text}`);
  if (result.feedback.length) {
    out.push('');
    out.push('Signals from recorded feedback (latest 10):');
    for (const f of result.feedback) out.push(`- #${f.num} ${f.company}: "${f.feedback}"`);
  }
  out.push('');
  out.push('This report is advisory. It never changes scoring rules — that conversation belongs to you.');
  return out.join('\n');
}

function selfTest() {
  const failures = [];
  const t = (name, cond) => { if (!cond) failures.push(name); };

  const journal = parseOutcomeJournal([
    '# Application Outcome Log — Acme — Dev (#7)', '',
    '## Entry: 2026-08-01',
    '- **Outcome Type**: interview_progress',
    '- **Canonical State**: Interview',
    '- **Stage Reached**: phone screen',
    '- **Verbatim Feedback**:',
    '> None recorded',
    '- **Notes**: n',
    '',
    '## Entry: 2026-08-20',
    '- **Outcome Type**: rejected',
    '- **Canonical State**: Rejected',
    '- **Stage Reached**: onsite',
    '- **Verbatim Feedback**:',
    '> Strong system design, gaps in Go depth',
    '- **Notes**: n',
  ].join('\n'));
  t('journal: last entry wins', journal.latestType === 'rejected');
  t('journal: feedback collected', journal.feedback.length === 1 && journal.feedback[0].includes('Go depth'));

  const mk = (num, score, status) => ({ num, company: `C${num}`, score, status });
  const J = (type) => ({ latestType: type, feedback: [] });

  const sep = computeCalibration(
    [mk(1, 4.6, 'Applied'), mk(2, 4.7, 'Applied'), mk(3, 3.2, 'Applied'), mk(4, 3.1, 'Applied'), mk(5, 4.0, 'Responded')],
    new Map([[1, J('hired')], [2, J('interview_only')], [3, J('no_response')], [4, J('rejected')]]),
    { minBandN: 2 },
  );
  t('separating verdict', sep.verdict.kind === 'separating');
  t('in-flight excluded from resolved', sep.resolved === 4 && sep.inFlight === 1);
  t('offer counted only on offer tier', sep.bands.find((b) => b.band === '>=4.5').offers === 1);

  const inv = computeCalibration(
    [mk(1, 4.6, 'x'), mk(2, 4.7, 'x'), mk(3, 3.2, 'x'), mk(4, 3.1, 'x')].map((r) => ({ ...r, status: 'Applied' })),
    new Map([[1, J('no_response')], [2, J('rejected')], [3, J('hired')], [4, J('interview_only')]]),
    { minBandN: 2 },
  );
  t('inverted verdict', inv.verdict.kind === 'inverted');

  const thin = computeCalibration([mk(1, 4.6, 'Applied')], new Map([[1, J('hired')]]), { minBandN: 5 });
  t('thin data withholds rates', thin.bands.every((b) => b.interviewRate === null));
  t('thin data verdict is insufficient', thin.verdict.kind === 'insufficient');

  const fb = computeCalibration(
    [mk(1, 4.2, 'Interview'), mk(2, 4.1, 'Applied'), mk(3, 4.3, 'Applied')],
    new Map([[3, J('rejected')]]),
    { minBandN: 2 },
  );
  t('tracker terminal resolves', fb.resolved === 2);
  t('journal outranks tracker', fb.bands.find((b) => b.band === '4.0-4.4').interviews === 1);

  const pop = computeCalibration([mk(1, 4.2, 'Evaluated'), mk(2, 2.1, 'Discarded')], new Map(), { minBandN: 2 });
  t('never-applied excluded', pop.resolved === 0 && pop.inFlight === 0);

  const led = computeCalibration(
    [mk(1, 4.6, 'Discarded'), mk(2, 4.5, 'Rejected'), mk(3, 4.2, 'Discarded')],
    new Map(),
    { minBandN: 2, reached: new Map([[1, { reachedInterview: true, reachedOffer: true }], [2, { reachedInterview: true, reachedOffer: false }]]) },
  );
  const ledHigh = led.bands.find((b) => b.band === '>=4.5');
  t('ledger resolves declined offer as reachedOffer', ledHigh.offers === 1 && ledHigh.interviews === 2 && led.resolved === 2);
  t('ledger leaves history-less Discarded excluded', led.bands.find((b) => b.band === '4.0-4.4').n === 0);
  const ledVsJournal = computeCalibration(
    [mk(1, 4.6, 'Discarded')], new Map([[1, J('rejected')]]),
    { minBandN: 1, reached: new Map([[1, { reachedInterview: true, reachedOffer: true }]]) },
  );
  t('journal outranks ledger', ledVsJournal.bands.find((b) => b.band === '>=4.5').offers === 0);

  if (failures.length) {
    console.error(`❌ calibrate self-test: ${failures.length} failure(s):\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✅ calibrate.mjs self-test: all checks passed');
  process.exit(0);
}

import { isMainModule } from './lib/is-main-module.mjs';

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();

  const minFlagIdx = argv.indexOf('--min-band-n');
  const minBandN = minFlagIdx !== -1 ? parseInt(argv[minFlagIdx + 1], 10) : 5;
  if (!Number.isInteger(minBandN) || minBandN < 1) {
    console.error('--min-band-n must be a positive integer');
    process.exit(2);
  }
  const appsFile = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(appsFile)) {
    console.error(`No tracker found at ${appsFile} — nothing to calibrate yet.`);
    process.exit(1);
  }
  const workspaceRoot = resolveWorkspaceRoot(appsFile);
  const rows = loadTrackerRows(appsFile);
  const journals = loadJournals(workspaceRoot);
  const reached = loadLedgerReached(workspaceRoot);
  const result = computeCalibration(rows, journals, { minBandN, reached });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHuman(result));
}
