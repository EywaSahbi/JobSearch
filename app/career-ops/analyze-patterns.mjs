#!/usr/bin/env node

import { readFileSync, existsSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { load as yamlLoad } from 'js-yaml';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { atsVendorOf } from './ats-vendor.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';

const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

const MACHINE_SUMMARY_FIELDS = new Set([
  'company',
  'role',
  'score',
  'legitimacy_tier',
  'archetype',
  'final_decision',
  'hard_stops',
  'soft_gaps',
  'top_strengths',
  'risk_level',
  'confidence',
  'score_evidence',
  'confidence_gaps',
  'next_action',
  'domain',
  'seniority',
  'remote',
  'team_size',
  'discard_reasons',
  'advertised_comp',
  'posting_location',
  'via',
  'company_confidential',
  'risk_summary',
  'work_auth',
  'reports_to',
  'requirement_importance',
]);

const args = process.argv.slice(2);

const KNOWN_FLAGS = ['--min-threshold', '--min-vendor-n', '--self-test', '--summary', '--help', '-h'];
const VALUE_FLAGS = ['--min-threshold', '--min-vendor-n'];
const USAGE = `Usage:
  node analyze-patterns.mjs                       # analyze application patterns as JSON
  node analyze-patterns.mjs --summary             # print a human-readable summary
  node analyze-patterns.mjs --min-threshold <n>   # minimum submitted applications required (default: 5)
  node analyze-patterns.mjs --min-vendor-n <n>    # minimum sample per vendor/channel (default: 8)
  node analyze-patterns.mjs --self-test           # run the built-in consistency checks
  node analyze-patterns.mjs --help                # show this message`;

const summaryMode = args.includes('--summary');

let MIN_THRESHOLD = 5;
let MIN_VENDOR_N = 8;

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'contratado': 'hired', 'contratada': 'hired', 'accepted': 'hired', 'accept': 'hired',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

export function classifyOutcome(status) {
  const s = normalizeStatus(status);
  if (['hired', 'interview', 'offer', 'responded'].includes(s)) return 'positive';
  if (s === 'applied') return 'awaiting';
  if (s === 'rejected') return 'negative';
  if (s === 'discarded') return 'discarded';
  if (s === 'skip') return 'self_filtered';
  return 'pending';
}

function discardableBase(enriched) {
  return enriched.filter(e => REASON_BEARING.has(e.outcome)).length;
}

function gapBearingBase(enriched) {
  return enriched.filter(e => e.report?.gaps?.length > 0).length;
}

export const OUTCOME_BUCKETS = ['positive', 'awaiting', 'negative', 'discarded', 'self_filtered', 'pending'];
const REASON_BEARING = new Set(['negative', 'discarded', 'self_filtered']);

const MIN_DECIDED_FOR_RECOMMENDATION = 2;
const MIN_POSITIVE_SCORES_FOR_THRESHOLD = 3;

export function newOutcomeCounts() {
  const row = { total: 0 };
  for (const bucket of OUTCOME_BUCKETS) row[bucket] = 0;
  return row;
}

export function withOutcomeRates(data) {
  const submitted = data.positive + data.negative + data.awaiting;
  const decided = data.positive + data.negative;
  return {
    ...data,
    submitted,
    decided,
    conversionRate: submitted > 0 ? Math.round((data.positive / submitted) * 100) : 0,
    decidedRate: decided > 0 ? Math.round((data.positive / decided) * 100) : null,
  };
}

function breakdownBy(enriched, labelKey, keyOf) {
  const map = new Map();
  for (const e of enriched) {
    const k = keyOf(e);
    if (!map.has(k)) map.set(k, newOutcomeCounts());
    const row = map.get(k);
    row.total++;
    row[e.outcome]++;
  }
  return [...map.entries()]
    .map(([label, data]) => ({ [labelKey]: label, ...withOutcomeRates(data) }))
    .sort((a, b) => b.total - a.total);
}

export function bestDecidedSegment(rows) {
  return rows
    .filter(r => r.decided >= MIN_DECIDED_FOR_RECOMMENDATION && r.decidedRate > 0)
    .sort((a, b) => b.decidedRate - a.decidedRate || b.decided - a.decided)[0] || null;
}

export function worstDecidedSegment(rows) {
  return rows
    .filter(r => r.positive === 0 && r.decided >= MIN_DECIDED_FOR_RECOMMENDATION)
    .sort((a, b) => b.decided - a.decided)[0] || null;
}

export function scoreThresholdFrom(positiveScoresRaw, negativeScoresRaw) {
  const positive = positiveScoresRaw.filter(s => s > 0);
  const negative = negativeScoresRaw.filter(s => s > 0);
  const min = positive.length > 0 ? Math.min(...positive) : 0;
  const rejectedBelow = negative.filter(s => s < min).length;
  const sufficient = positive.length >= MIN_POSITIVE_SCORES_FOR_THRESHOLD;
  const prescribe = sufficient && rejectedBelow > 0;
  let reasoning;
  if (positive.length === 0) reasoning = 'No positive outcome carries a score yet.';
  else if (!sufficient) reasoning = `Lowest score among positive outcomes so far is ${min}, but only ${positive.length} positive outcome(s) carry a score (${MIN_POSITIVE_SCORES_FOR_THRESHOLD} needed before this is a threshold).`;
  else if (!prescribe) reasoning = `Lowest score among ${positive.length} positive outcomes is ${min}, but no rejected application scored below it — nothing shows that lower scores fail.`;
  else reasoning = `None of the ${positive.length} positive outcomes scored below ${min}, and ${rejectedBelow} rejected application(s) did.`;
  return {
    recommended: prescribe ? Math.floor(min * 10) / 10 : null,
    observedMinimum: min > 0 ? min : null,
    sampleSize: positive.length,
    sufficientSample: sufficient,
    rejectedBelow,
    reasoning,
    positiveRange: positive.length > 0 ? `${min} - ${Math.max(...positive)}` : 'N/A',
  };
}

const VENDOR_ANALYSIS_SCOPE = Object.freeze(['greenhouse', 'lever', 'ashby', 'workday', 'icims']);

export function knownAtsVendorOf(rawUrl) {
  const vendor = atsVendorOf(rawUrl);
  return VENDOR_ANALYSIS_SCOPE.includes(vendor) ? vendor : null;
}

const SUBMITTED_STATUSES = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);

const ADVANCED_STATUSES = new Set(['responded', 'interview', 'offer', 'hired']);

const FUNNEL_ORDER = ['evaluated', 'applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'discarded', 'skip'];

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeScalar(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function parseMachineSummary(content) {
  const fenceMatch = content.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (!fenceMatch) return null;

  const raw = fenceMatch[1].trim();
  if (!raw) return null;

  try {
    const parsed = yamlLoad(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => MACHINE_SUMMARY_FIELDS.has(key))
    );
  } catch {
    return null;
  }
}

function buildViaChannelAnalysis(submitted, isAdvanced, minSample = MIN_VENDOR_N) {
  const viaOf = (e) => String(e.via ?? '').trim();
  const isDirect = (v) => v === '—' || v === '-';
  const agencySubmitted = submitted.filter(e => { const v = viaOf(e); return v !== '' && !isDirect(v); });
  const directSubmitted = submitted.filter(e => isDirect(viaOf(e)));
  const rate = (arr) => (arr.length > 0 ? Math.round((arr.filter(isAdvanced).length / arr.length) * 100) : 0);

  const byAgency = new Map();
  for (const e of agencySubmitted) {
    const raw = viaOf(e);
    const key = normalizeVia(raw) || raw.normalize('NFKC').toLowerCase();
    if (!byAgency.has(key)) byAgency.set(key, { agency: raw, total: 0, advanced: 0 });
    const entry = byAgency.get(key);
    entry.total++;
    if (isAdvanced(e)) entry.advanced++;
  }
  const breakdown = [...byAgency.values()]
    .map(d => ({
      agency: d.agency,
      total: d.total,
      advanced: d.advanced,
      advanceRate: d.total > 0 ? Math.round((d.advanced / d.total) * 100) : 0,
      sufficientSample: d.total >= minSample,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    minSampleForClaim: minSample,
    agencySubmitted: agencySubmitted.length,
    directSubmitted: directSubmitted.length,
    unknownVia: submitted.length - agencySubmitted.length - directSubmitted.length,
    agencyAdvanceRate: rate(agencySubmitted),
    directAdvanceRate: rate(directSubmitted),
    breakdown,
  };
}

const TECH_CANONICAL = new Map([
  'JavaScript', 'TypeScript', 'Python', 'Ruby', 'Java', 'Go', 'Rust',
  'React Native', 'React', 'Angular', 'Django', 'Flask', 'Rails', 'PHP',
  'Laravel', 'Symfony', 'Kotlin', 'Swift', 'C++', 'C#', '.NET', 'MongoDB',
  'MySQL', 'PostgreSQL', 'Redis', 'GraphQL', 'REST', 'AWS', 'GCP', 'Azure',
  'Docker', 'Kubernetes', 'Terraform', 'Supabase', 'Inngest',
].map(t => [t.toLowerCase(), t]));
TECH_CANONICAL.set('node.js', 'Node.js').set('nodejs', 'Node.js');
TECH_CANONICAL.set('vue.js', 'Vue.js').set('vuejs', 'Vue.js');

const TECH_MENTION_RE = /(?<!\w)(JavaScript|TypeScript|Python|Ruby|Java|Go|Rust|Node\.?js|React Native|React|Angular|Vue\.?js|Django|Flask|Rails|PHP|Laravel|Symfony|Kotlin|Swift|C\+\+|C#|\.NET|MongoDB|MySQL|PostgreSQL|Redis|GraphQL|REST|AWS|GCP|Azure|Docker|Kubernetes|Terraform|Supabase|Inngest)(?!\w)/gi;

function extractTechMentions(description) {
  const matches = String(description ?? '').match(TECH_MENTION_RE);
  if (!matches) return [];
  return matches.map(m => TECH_CANONICAL.get(m.toLowerCase()) || m);
}

function runSelfTest() {
  const summary = parseMachineSummary(`
## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff AI Engineer"
score: 4.4
legitimacy_tier: "High Confidence"
archetype: "AI Platform / LLMOps Engineer"
final_decision: "Apply"
hard_stops: []
soft_gaps:
  - "No direct healthcare domain experience"
top_strengths:
  - "Production evaluation pipelines"
risk_level: "Medium"
confidence: "High"
next_action: "Follow up on ticket #42 with tailored CV"
work_auth: "unstated"
posting_location: "Halifax, NS"
via: "Hays"
company_confidential: true
\`\`\`
`);

  const failures = [];
  if (!summary) failures.push('summary was not parsed');
  if (summary?.score !== 4.4) failures.push('numeric score was not parsed');
  if (!Array.isArray(summary?.hard_stops) || summary.hard_stops.length !== 0) failures.push('empty list was not parsed');
  if (summary?.soft_gaps?.[0] !== 'No direct healthcare domain experience') failures.push('list item was not parsed');
  if (summary?.next_action !== 'Follow up on ticket #42 with tailored CV') failures.push('hash-containing scalar field was not parsed');
  if (summary?.via !== 'Hays') failures.push('via was not preserved from Machine Summary');
  if (summary?.company_confidential !== true) failures.push('company_confidential boolean was not preserved from Machine Summary');
  if (summary?.work_auth !== 'unstated') failures.push('work_auth field was not preserved from Machine Summary');
  if (summary?.posting_location !== 'Halifax, NS') failures.push('posting_location field was not preserved from Machine Summary');

  if ('risk_summary' in (summary ?? {})) failures.push('summary without risk_summary must not gain the key');

  const riskSummary = parseMachineSummary(`
## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff AI Engineer"
score: 4.4
legitimacy_tier: "High Confidence"
risk_summary:
  legitimacy: high_confidence
  classification: clear
  culture: caution
  interview_redflags: not_evaluated
  ai_infra: not_evaluated
\`\`\`
`)?.risk_summary;
  if (!riskSummary || typeof riskSummary !== 'object' || Array.isArray(riskSummary)) {
    failures.push('risk_summary nested map was dropped or not parsed as a map');
  } else {
    if (riskSummary.legitimacy !== 'high_confidence') failures.push('risk_summary.legitimacy was not preserved');
    if (riskSummary.classification !== 'clear') failures.push('risk_summary.classification was not preserved');
    if (riskSummary.culture !== 'caution') failures.push('risk_summary.culture was not preserved');
    if (riskSummary.interview_redflags !== 'not_evaluated') failures.push('risk_summary.interview_redflags was not preserved');
    if (riskSummary.ai_infra !== 'not_evaluated') failures.push('risk_summary.ai_infra was not preserved');
  }

  const reqImportance = parseMachineSummary(`
## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff AI Engineer"
score: 4.4
requirement_importance:
  - requirement: "Fluent German (C1)"
    jd_signal: "Verhandlungssicheres Deutsch ist Voraussetzung"
    evidence: "stated"
    importance: "critical"
    match: "missing"
  - requirement: "Kubernetes in production"
    jd_signal: null
    evidence: "inferred"
    importance: "meaningful"
    match: "partial"
\`\`\`
`)?.requirement_importance;
  if (!Array.isArray(reqImportance) || reqImportance.length !== 2) {
    failures.push('requirement_importance list was dropped or not parsed as a list');
  } else {
    const [stated, inferred] = reqImportance;
    if (stated.requirement !== 'Fluent German (C1)') failures.push('requirement_importance[0].requirement was not preserved');
    if (stated.jd_signal !== 'Verhandlungssicheres Deutsch ist Voraussetzung') failures.push('requirement_importance[0].jd_signal verbatim quote was not preserved');
    if (stated.evidence !== 'stated') failures.push('requirement_importance[0].evidence was not preserved');
    if (stated.importance !== 'critical') failures.push('requirement_importance[0].importance was not preserved');
    if (stated.match !== 'missing') failures.push('requirement_importance[0].match was not preserved');
    if (inferred.jd_signal !== null) failures.push('requirement_importance[1].jd_signal null was not preserved');
    if (inferred.evidence !== 'inferred') failures.push('requirement_importance[1].evidence was not preserved');
    if (inferred.importance === 'critical' || inferred.importance === 'high') {
      failures.push('requirement_importance fixture violates the inferred cap (evidence: inferred must never be critical/high)');
    }
  }

  if ('requirement_importance' in (summary ?? {})) failures.push('summary without requirement_importance must not gain the key');

  const vendorCases = [
    ['https://boards.greenhouse.io/acme/jobs/12345', 'greenhouse'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/9', 'greenhouse'],
    ['https://jobs.lever.co/acme/abc-def', 'lever'],
    ['https://jobs.ashbyhq.com/acme/uuid', 'ashby'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/careers/job/R-1', 'workday'],
    ['https://careers.icims.com/jobs/9/x', 'icims'],
    ['https://jobs.dayforcehcm.com/en-US/co/CANDIDATEPORTAL/jobs/1', 'dayforce'],
    ['https://careers.example.com/jobs/1', 'careers.example.com'],
    ['not a url', null],
    ['', null],
    [null, null],
  ];
  for (const [url, expected] of vendorCases) {
    const got = atsVendorOf(url);
    if (got !== expected) failures.push(`atsVendorOf(${JSON.stringify(url)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }

  const headerCases = [
    ['URL: https://job-boards.greenhouse.io/acme/jobs/1', REPORT_URL_RE, 'https://job-boards.greenhouse.io/acme/jobs/1'],
    ['URL : https://job-boards.greenhouse.io/acme/jobs/1', REPORT_URL_RE, 'https://job-boards.greenhouse.io/acme/jobs/1'],
    ['URL\u00a0: https://jobs.lever.co/acme/x', REPORT_URL_RE, 'https://jobs.lever.co/acme/x'],
    ['Archetype: Delivery Manager', REPORT_ARCHETYPE_RE, 'Delivery Manager'],
    ['Archétype : Delivery Manager', REPORT_ARCHETYPE_RE, 'Delivery Manager'],
    ['Arquetipo: Delivery Manager', REPORT_ARCHETYPE_RE, 'Delivery Manager'],
  ];
  for (const [line, re, expected] of headerCases) {
    const got = re.exec(line)?.[1] ?? null;
    if (got !== expected) failures.push(`report header ${JSON.stringify(line)} → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }

  if (REPORT_URL_RE.test('Score: 4.4/5')) failures.push('REPORT_URL_RE matched a line with no URL field');

  const splitHeaderCases = [
    ['URL\n: https://elsewhere.example.com/x', REPORT_URL_RE],
    ['URL :\nhttps://elsewhere.example.com/y', REPORT_URL_RE],
    ['Archétype\n: Delivery Manager', REPORT_ARCHETYPE_RE],
  ];
  for (const [text, re] of splitHeaderCases) {
    if (re.test(text)) failures.push(`split-line header parsed as valid: ${JSON.stringify(text)}`);
  }

  const localeArchetypeCases = [
    ['Arquétipo: Delivery Manager', 'pt'],
    ['Arquetipo: Delivery Manager', 'es'],
    ['Archétype : Delivery Manager', 'fr (accented)'],
    ['Archetype : Delivery Manager', 'fr (as the mode writes it)'],
    ['Archetipo: Delivery Manager', 'it'],
    ['Archetyp: Delivery Manager', 'de, pl'],
    ['Arketipe: Delivery Manager', 'id'],
    ['Arketype: Delivery Manager', 'da'],
    ['Arketip: Delivery Manager', 'tr'],
    ['Архетип: Delivery Manager', 'ru, ua'],
  ];
  for (const [line, locale] of localeArchetypeCases) {
    const got = REPORT_ARCHETYPE_RE.exec(line)?.[1] ?? null;
    if (got !== 'Delivery Manager') failures.push(`archetype label for ${locale} → ${JSON.stringify(got)}`);
  }

  const scoringRow = '| Archétype / séniorité | 25 % | 2.0 |';
  if (REPORT_ARCHETYPE_RE.test(scoringRow)) failures.push('archetype pattern matched a scoring table row');

  const viaRows = [
    { via: 'Hays', normalizedStatus: 'interview' },
    { via: 'HAYS ', normalizedStatus: 'rejected' },
    { via: 'ＨＡＹＳ', normalizedStatus: 'rejected' },
    { via: 'Randstad', normalizedStatus: 'rejected' },
    { via: 'リクルートAgent', normalizedStatus: 'interview' },
    { via: 'パーソルAgent', normalizedStatus: 'rejected' },
    { via: '—', normalizedStatus: 'responded' },
    { via: '—', normalizedStatus: 'rejected' },
    { via: '', normalizedStatus: 'applied' },
  ];
  const viaResult = buildViaChannelAnalysis(viaRows, (e) => ADVANCED_STATUSES.has(e.normalizedStatus), 2);
  if (viaResult.agencySubmitted !== 6) failures.push(`via: agencySubmitted → ${viaResult.agencySubmitted}, expected 6`);
  if (viaResult.directSubmitted !== 2) failures.push(`via: directSubmitted → ${viaResult.directSubmitted}, expected 2`);
  if (viaResult.unknownVia !== 1) failures.push(`via: unknownVia → ${viaResult.unknownVia}, expected 1 (submitted row with empty Via must be counted, not silently dropped)`);
  if (viaResult.directAdvanceRate !== 50) failures.push(`via: directAdvanceRate → ${viaResult.directAdvanceRate}, expected 50`);
  const hays = viaResult.breakdown.find(a => a.agency === 'Hays');
  if (!hays || hays.total !== 3 || hays.advanceRate !== 33) {
    failures.push(`via: Hays bucket wrong (case/space/full-width variants must merge) → ${JSON.stringify(hays)}`);
  }
  if (!hays?.sufficientSample) failures.push('via: Hays should meet the n=2 sample bar');
  const recruit = viaResult.breakdown.find(a => a.agency === 'リクルートAgent');
  const persol = viaResult.breakdown.find(a => a.agency === 'パーソルAgent');
  if (!recruit || !persol || recruit.total !== 1 || persol.total !== 1) {
    failures.push(`via: distinct non-Latin agencies must stay separate buckets → リクルートAgent=${JSON.stringify(recruit)}, パーソルAgent=${JSON.stringify(persol)}`);
  }
  const randstad = viaResult.breakdown.find(a => a.agency === 'Randstad');
  if (randstad?.sufficientSample) failures.push('via: Randstad (n=1) must be flagged as too small for a claim');
  if (buildViaChannelAnalysis([], () => false).breakdown.length !== 0) {
    failures.push('via: empty input must produce an empty breakdown');
  }

  if (classifyOutcome('Hired') !== 'positive') failures.push(`hired: classifyOutcome('Hired') → ${classifyOutcome('Hired')}, expected 'positive'`);
  for (const alias of ['contratado', 'contratada', 'accepted', 'accept']) {
    if (normalizeStatus(alias) !== 'hired') failures.push(`hired: normalizeStatus('${alias}') → ${normalizeStatus(alias)}, expected 'hired'`);
  }
  for (const st of SUBMITTED_STATUSES) {
    const bucket = classifyOutcome(st);
    if (!['positive', 'negative', 'awaiting'].includes(bucket)) failures.push(`buckets: '${st}' classifies as '${bucket}', so submitted counts would disagree with the channel-yield pass`);
  }
  if (classifyOutcome('Discarded') !== 'discarded' || SUBMITTED_STATUSES.has('discarded')) failures.push('discarded: withdrawn/closed rows must be their own bucket and not count as submitted');

  if (!ADVANCED_STATUSES.has('hired')) failures.push('hired: ADVANCED_STATUSES must include hired (a hire advanced past screening)');
  if (!SUBMITTED_STATUSES.has('hired')) failures.push('hired: SUBMITTED_STATUSES must include hired (a hire was submitted)');
  if (!FUNNEL_ORDER.includes('hired')) failures.push('hired: FUNNEL_ORDER must include hired so it prints in the funnel');
  const hiredVia = buildViaChannelAnalysis(
    [{ via: 'Hays', normalizedStatus: 'hired' }, { via: 'Hays', normalizedStatus: 'rejected' }],
    (e) => ADVANCED_STATUSES.has(e.normalizedStatus), 1);
  const hiredHays = hiredVia.breakdown.find(a => a.agency === 'Hays');
  if (!hiredHays || hiredHays.advanced !== 1 || hiredHays.advanceRate !== 50) {
    failures.push(`hired: must count as advanced in channel yield (1/2 = 50%) → ${JSON.stringify(hiredHays)}`);
  }

  const techHits = extractTechMentions('Requires C++, C# and .NET, plus React Native and Go');
  for (const expected of ['C++', 'C#', '.NET', 'React Native', 'Go']) {
    if (!techHits.includes(expected)) failures.push(`tech extraction dropped "${expected}"`);
  }
  if (extractTechMentions('Google Cloud and JavaScripting skills').length !== 0) {
    failures.push('tech extraction false-positived on Google/JavaScripting');
  }
  if (extractTechMentions('nodejs, Node.js, NODEJS').some(t => t !== 'Node.js')) {
    failures.push('node.js case variants failed to canonicalize');
  }

  const baseFixture = [];
  for (let i = 0; i < 20; i++) {
    baseFixture.push({
      outcome: i === 19 ? 'negative' : 'self_filtered',
      notes: i < 3 ? `SKIP: geo-block${i === 0 ? '; SKIP: geo-block' : ''}` : '',
      report: { gaps: [] },
    });
  }
  for (let i = 0; i < 10; i++) {
    baseFixture.push({ outcome: 'pending', notes: '', report: null });
  }
  const baseSignals = buildPatternSignals(baseFixture);
  if (baseSignals.discardReasonBase !== 20) {
    failures.push(`discardReasonBase counted ${baseSignals.discardReasonBase}, expected 20`);
  }
  if (baseSignals.blockerBase !== 0) {
    failures.push(`blockerBase counted ${baseSignals.blockerBase}, expected 0 (no gaps in fixture)`);
  }
  const geoReason = baseSignals.discardReasonStats.find(d => d.reason === 'geo-block');
  if (geoReason?.frequency !== 3 || geoReason?.percentage !== 15) {
    failures.push(`discard aggregation returned ${JSON.stringify(geoReason)}, expected frequency 3 and percentage 15`);
  }
  if (!baseSignals.discardReasonRecommendation) {
    failures.push('3 discard reasons among 20 eligible entries did not trigger a recommendation');
  }

  const dupBlockerFixture = [
    { outcome: 'negative', notes: '', report: { gaps: [
      { description: 'US-only remote', severity: 'hard' },
      { description: 'Remote US only, no sponsorship', severity: 'hard' },
      { description: 'US-only residency required', severity: 'hard' },
    ] } },
    { outcome: 'negative', notes: '', report: { gaps: [{ description: 'US-only remote', severity: 'hard' }] } },
    { outcome: 'pending', notes: '', report: { gaps: [] } },
    { outcome: 'pending', notes: '', report: null },
    { outcome: 'positive', notes: '', report: { gaps: [] } },
  ];
  const blockerSignals = buildPatternSignals(dupBlockerFixture);
  const geoBlocker = blockerSignals.blockerAnalysis.find(b => b.blocker === 'geo-restriction');
  if (geoBlocker?.frequency !== blockerSignals.blockerBase || geoBlocker?.percentage !== 100) {
    failures.push(`geo blocker aggregation returned ${JSON.stringify(geoBlocker)} against base ${blockerSignals.blockerBase}, expected 2/2 (100%)`);
  }

  const techSignals = buildPatternSignals([
    { outcome: 'negative', notes: '', report: { gaps: [
      { description: 'Java is required', severity: 'hard' },
      { description: 'Production Java and Go experience', severity: 'hard' },
    ] } },
    { outcome: 'discarded', notes: '', report: { gaps: [{ description: 'Java is required', severity: 'hard' }] } },
  ]);
  const javaGap = techSignals.techStackGaps.find(g => g.skill === 'Java');
  if (javaGap?.frequency !== 2) {
    failures.push(`technology harvest returned ${JSON.stringify(javaGap)}, expected Java frequency 2 (one negative + one discarded row)`);
  }

  const emptySignals = buildPatternSignals([]);
  if (emptySignals.discardReasonBase !== 0 || emptySignals.blockerBase !== 0
      || emptySignals.discardReasonStats.length !== 0 || emptySignals.blockerAnalysis.length !== 0
      || emptySignals.discardReasonRecommendation) {
    failures.push(`empty pattern signals were not empty: ${JSON.stringify(emptySignals)}`);
  }

  if (classifyRemote('Fully remote — hiring in 70+ countries') !== 'global remote') {
    failures.push('classifyRemote did not read "70+ countries" as global remote');
  }
  if (classifyRemote('US-only remote') !== 'geo-restricted') {
    failures.push('classifyRemote geo-restricted precedence regressed');
  }

  {
    const legit = join(CAREER_OPS, 'reports', '042-acme-2026-01-01.md');
    if (!withinReports(legit)) failures.push('containment: legit reports/ path wrongly rejected');
    const escape = join(CAREER_OPS, 'reports/../../../etc/passwd');
    if (withinReports(escape)) failures.push('containment: traversal path escaped reports/ (path-traversal guard broken)');
    const sibling = join(CAREER_OPS, 'reports-evil', 'x.md');
    if (withinReports(sibling)) failures.push('containment: reports-prefixed sibling dir wrongly accepted');
  }

  {
    const reportsDir = join(CAREER_OPS, 'reports');
    if (existsSync(reportsDir)) {
      const tag = `__co2655-${process.pid}-${Date.now()}`;
      const realReport = join(reportsDir, `${tag}-real.md`);
      const escapeLink = join(reportsDir, `${tag}-escape.md`);
      const missing = join(reportsDir, `${tag}-missing.md`);
      try {
        if (!withinReports(missing)) failures.push('containment: missing report file wrongly rejected (should degrade to a null read, not a hard skip)');
      } catch (err) {
        failures.push(`containment: missing report file threw instead of degrading gracefully (${err.code || err.message})`);
      }
      try {
        writeFileSync(realReport, '# real report\n');
        if (!withinReports(realReport)) failures.push('containment: real file inside reports/ wrongly rejected');
        let symlinkCreated = false;
        try {
          symlinkSync(fileURLToPath(import.meta.url), escapeLink);
          symlinkCreated = true;
        } catch (err) {
          if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSYS') {
            console.log(`analyze-patterns self-test: skipping symlink-escape assertion (platform refused symlink creation: ${err.code})`);
          } else {
            throw err;
          }
        }
        if (symlinkCreated && withinReports(escapeLink)) {
          failures.push('containment: symlink escaping reports/ was accepted (realpath containment broken)');
        }
      } finally {
        rmSync(realReport, { force: true });
        rmSync(escapeLink, { force: true });
      }
    }
  }

  if (failures.length > 0) {
    console.error(`analyze-patterns self-test failed: ${failures.join('; ')}`);
    process.exit(1);
  }

  console.log('analyze-patterns self-test OK (Machine Summary parser + vendor detection + via channel analysis)');
  process.exit(0);
}

function parseTracker() {
  if (!existsSync(APPS_FILE)) return [];
  const content = readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const entries = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) entries.push(row);
  }
  return entries;
}

function withinReports(candidate) {
  const repoRelative = relative(CAREER_OPS, candidate).split(sep).join('/');
  if (!repoRelative.startsWith('reports/') || repoRelative.includes('..')) return false;
  let realRoot;
  try {
    realRoot = realpathSync(join(CAREER_OPS, 'reports'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true;
    throw err;
  }
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realCandidate === realRoot || realCandidate.startsWith(rootWithSep);
}

function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

const REPORT_URL_RE = /^URL[ \t\u00a0]*:[ \t\u00a0]*(https?:\/\/\S+)/im;
const ARCHETYPE_LABELS = [
  'Arquétipo',
  'Arquetipo',
  'Archétype',
  'Archetype',
  'Archetipo',
  'Archetyp',
  'Arketipe',
  'Arketype',
  'Arketip',
  'Архетип',
];

const HEADER_HSPACE = '[ \\t\\u00a0]*';
const REPORT_ARCHETYPE_RE = new RegExp(
  `^(?:${ARCHETYPE_LABELS.join('|')})${HEADER_HSPACE}:${HEADER_HSPACE}(.+?)$`,
  'im',
);

function parseReport(reportPath) {
  const content = readTextIfExists(reportPath);
  if (content === null) return null;
  const report = {
    company: null,
    role: null,
    url: null,
    archetype: null,
    legitimacyTier: null,
    finalDecision: null,
    seniority: null,
    remote: null,
    teamSize: null,
    comp: null,
    domain: null,
    riskLevel: null,
    confidence: null,
    nextAction: null,
    topStrengths: [],
    discardReasons: [],
    scores: {},
    gaps: [],
  };

  const machineSummary = parseMachineSummary(content);
  if (machineSummary) {
    report.machineSummary = machineSummary;
    report.company = normalizeScalar(machineSummary.company) || report.company;
    report.role = normalizeScalar(machineSummary.role) || report.role;
    report.archetype = normalizeScalar(machineSummary.archetype) || report.archetype;
    report.legitimacyTier = normalizeScalar(machineSummary.legitimacy_tier) || report.legitimacyTier;
    report.finalDecision = normalizeScalar(machineSummary.final_decision) || report.finalDecision;
    report.domain = normalizeScalar(machineSummary.domain) || report.domain;
    report.seniority = normalizeScalar(machineSummary.seniority) || report.seniority;
    report.remote = normalizeScalar(machineSummary.remote) || report.remote;
    report.teamSize = normalizeScalar(machineSummary.team_size) || report.teamSize;
    report.riskLevel = normalizeScalar(machineSummary.risk_level) || report.riskLevel;
    report.confidence = normalizeScalar(machineSummary.confidence) || report.confidence;
    report.nextAction = normalizeScalar(machineSummary.next_action) || report.nextAction;
    report.topStrengths = normalizeList(machineSummary.top_strengths);
    report.discardReasons = normalizeList(machineSummary.discard_reasons);

    if (typeof machineSummary.score === 'number') {
      report.scores.global = machineSummary.score;
    }

    for (const hardStop of normalizeList(machineSummary.hard_stops)) {
      report.gaps.push({ description: hardStop, severity: 'hard stop', mitigation: '' });
    }
    for (const softGap of normalizeList(machineSummary.soft_gaps)) {
      report.gaps.push({ description: softGap, severity: 'soft gap', mitigation: '' });
    }
  }

  const plain = content.replace(/\*\*/g, '');

  const blockARegex = /\|\s*(?:Detected\s+)?(?:Archetype|Arquetipo)\s*\|\s*(.*?)\s*\|/i;
  const seniorityRegex = /\|\s*(?:Seniority|Nivel|Level)\s*\|\s*(.*?)\s*\|/i;
  const remoteRegex = /\|\s*(?:Remote|Remoto|Location)\s*\|\s*(.*?)\s*\|/i;
  const teamRegex = /\|\s*(?:Team|Team size|Equipo)\s*\|\s*(.*?)\s*\|/i;
  const compRegex = /\|\s*(?:Comp|Salary|Salario|Listed salary)\s*\|\s*(.*?)\s*\|/i;
  const domainRegex = /\|\s*(?:Domain|Dominio|Industry)\s*\|\s*(.*?)\s*\|/i;

  const headerArchRegex = REPORT_ARCHETYPE_RE;

  const urlMatch = plain.match(REPORT_URL_RE);
  if (urlMatch && !report.url) report.url = urlMatch[1].trim().replace(/[)>\].,]+$/, '');

  const archMatch = plain.match(blockARegex) || plain.match(headerArchRegex);
  if (archMatch && !report.archetype) report.archetype = archMatch[1].trim();

  const senMatch = plain.match(seniorityRegex);
  if (senMatch && !report.seniority) report.seniority = senMatch[1].trim();

  const remMatch = plain.match(remoteRegex);
  if (remMatch && !report.remote) report.remote = remMatch[1].trim();

  const teamMatch = plain.match(teamRegex);
  if (teamMatch && !report.teamSize) report.teamSize = teamMatch[1].trim();

  const compMatch = plain.match(compRegex);
  if (compMatch && !report.comp) report.comp = compMatch[1].trim();

  const domainMatch = plain.match(domainRegex);
  if (domainMatch && !report.domain) report.domain = domainMatch[1].trim();

  const scoreRegex = /\|\s*(?:CV Match|Match con CV)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const northStarRegex = /\|\s*(?:North Star)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const compScoreRegex = /\|\s*(?:Comp)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const culturalRegex = /\|\s*(?:Cultural signals|Cultural)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const redFlagsRegex = /\|\s*(?:Red flags)\s*\|\s*([-+]?[\d.]+)\s*\|/i;
  const globalRegex = /\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i;

  const cvScoreMatch = plain.match(scoreRegex);
  if (cvScoreMatch && report.scores.cvMatch === undefined) report.scores.cvMatch = parseFloat(cvScoreMatch[1]);

  const nsMatch = plain.match(northStarRegex);
  if (nsMatch && report.scores.northStar === undefined) report.scores.northStar = parseFloat(nsMatch[1]);

  const csMatch = plain.match(compScoreRegex);
  if (csMatch && report.scores.comp === undefined) report.scores.comp = parseFloat(csMatch[1]);

  const culMatch = plain.match(culturalRegex);
  if (culMatch && report.scores.cultural === undefined) report.scores.cultural = parseFloat(culMatch[1]);

  const rfMatch = plain.match(redFlagsRegex);
  if (rfMatch && report.scores.redFlags === undefined) report.scores.redFlags = parseFloat(rfMatch[1]);

  const glMatch = plain.match(globalRegex);
  if (glMatch && report.scores.global === undefined) report.scores.global = parseFloat(glMatch[1]);

  const gapTableRegex = /\|\s*Gap\s*\|\s*Severity\s*\|.*?\n\|[-|\s]+\n([\s\S]*?)(?:\n\n|\n##|\n\*\*|$)/i;
  const gapTableMatch = content.match(gapTableRegex);
  if (gapTableMatch) {
    const gapRows = gapTableMatch[1].split('\n').filter(r => r.startsWith('|'));
    for (const row of gapRows) {
      const cols = row.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const duplicate = report.gaps.some(g => g.description.toLowerCase() === cols[0].toLowerCase());
        if (!duplicate) {
          report.gaps.push({
            description: cols[0],
            severity: cols[1].toLowerCase(),
            mitigation: cols[2] || '',
          });
        }
      }
    }
  }

  return report;
}

function classifyRemote(raw) {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (/\b(us[- ]?only|canada[- ]?only|residents only|usa only|us residents|canada residents)\b/.test(lower)) return 'geo-restricted';
  if (/\bargentina\s+remote\s+only\b/.test(lower)) return 'geo-restricted';
  if (/\b(hybrid|on-?site|office|columbus|cape town|relocat)\b/.test(lower)) return 'hybrid/onsite';
  if (/(?<!\w)(global|anywhere|worldwide|no restrict|70\+|work from anywhere)(?!\w)/.test(lower)) return 'global remote';
  if (/\b(remote|latam|americas|brazil|fully remote)\b/.test(lower)) return 'regional remote';
  return 'unknown';
}

function classifyCompanySize(teamSize) {
  if (!teamSize) return 'unknown';
  const lower = teamSize.toLowerCase();
  const nums = lower.match(/[\d,]+/g);
  if (nums) {
    const max = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''))));
    if (max <= 50) return 'startup';
    if (max <= 500) return 'scaleup';
    return 'enterprise';
  }
  if (/\b(small|elite|tiny|founding)\b/.test(lower)) return 'startup';
  if (/\b(large|enterprise|global)\b/.test(lower)) return 'enterprise';
  return 'unknown';
}

function extractBlockerType(gap) {
  const desc = gap.description.toLowerCase();
  const sev = gap.severity.toLowerCase();
  if (sev.includes('nice') || sev.includes('soft')) return null;
  if (/\b(residency|us[- ]only|canada|location|visa|geo|country|region)\b/.test(desc)) return 'geo-restriction';
  if (/\b(javascript|typescript|python|ruby|java|go|rust|node|react|angular|vue|django|flask|rails)\b/.test(desc)) return 'stack-mismatch';
  if (/\b(senior|staff|lead|principal|director|manager|head)\b/.test(desc)) return 'seniority-mismatch';
  if (/\b(hybrid|on-?site|office|relocat)\b/.test(desc)) return 'onsite-requirement';
  return 'other';
}

function recordedDiscardReasons(entry) {
  if (!REASON_BEARING.has(entry.outcome)) return new Set();
  const matches = (entry.notes || '').match(/(?:DISCARD|SKIP):\s*([^,;\n]+)/gi) || [];
  return new Set(matches
    .map(match => match.replace(/^(?:DISCARD|SKIP):\s*/i, '').trim().toLowerCase())
    .filter(Boolean));
}

const DISCARD_REASONS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'templates/discard-reasons.yml');

export function loadDiscardReasonVocabulary(file = DISCARD_REASONS_FILE) {
  try {
    const parsed = yamlLoad(readFileSync(file, 'utf8'));
    const reasons = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
    const ids = reasons.map(reason => reason?.id).filter(id => typeof id === 'string' && id);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

function discardReasonKey(label) {
  return label.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function buildPredictedDiscardReasonSignals(enriched, vocabulary = loadDiscardReasonVocabulary()) {
  const counts = new Map();
  const otherCounts = new Map();
  let entriesWithOther = 0;
  const coverage = {
    entriesWithReports: 0,
    entriesWithPredictionData: 0,
    entriesWithPredictions: 0,
    entriesWithRecordedReasons: 0,
    entriesWithBothSources: 0,
  };
  for (const entry of enriched) {
    const hasRecordedReasons = recordedDiscardReasons(entry).size > 0;
    if (hasRecordedReasons) coverage.entriesWithRecordedReasons++;
    if (!entry.report) continue;
    coverage.entriesWithReports++;
    const raw = entry.report.machineSummary?.discard_reasons;
    if (typeof raw !== 'string'
        && !(Array.isArray(raw) && raw.every(reason => typeof reason === 'string'))) continue;
    coverage.entriesWithPredictionData++;
    if (hasRecordedReasons) coverage.entriesWithBothSources++;
    const reasons = new Set((entry.report.discardReasons || [])
      .map(reason => reason.trim().toLowerCase()).filter(Boolean));
    if (reasons.size > 0) coverage.entriesWithPredictions++;
    const canonical = new Set();
    const other = new Set();
    for (const reason of reasons) {
      const key = discardReasonKey(reason);
      if (vocabulary?.has(key)) canonical.add(key);
      else other.add(reason);
    }
    for (const reason of canonical) counts.set(reason, (counts.get(reason) || 0) + 1);
    for (const reason of other) otherCounts.set(reason, (otherCounts.get(reason) || 0) + 1);
    if (other.size > 0) entriesWithOther++;
  }
  const base = coverage.entriesWithPredictionData;
  const byFrequency = (a, b) => b.frequency - a.frequency || a.reason.localeCompare(b.reason);
  return {
    predictedDiscardReasonStats: [...counts.entries()]
      .map(([reason, frequency]) => ({ reason, frequency, percentage: Math.round(frequency / base * 100) }))
      .sort(byFrequency),
    predictedDiscardReasonOther: {
      vocabularyLoaded: vocabulary !== null,
      entries: entriesWithOther,
      percentage: base ? Math.round(entriesWithOther / base * 100) : 0,
      reasons: [...otherCounts.entries()]
        .map(([reason, frequency]) => ({ reason, frequency }))
        .sort(byFrequency),
    },
    predictedDiscardReasonBase: base,
    discardReasonCoverage: coverage,
  };
}

function buildPatternSignals(enriched) {
  const blockerCounts = new Map();
  const blockerBase = gapBearingBase(enriched);
  for (const e of enriched) {
    if (!e.report?.gaps) continue;
    const entryBlockers = new Set();
    for (const gap of e.report.gaps) {
      const type = extractBlockerType(gap);
      if (type) entryBlockers.add(type);
    }
    for (const type of entryBlockers) {
      blockerCounts.set(type, (blockerCounts.get(type) || 0) + 1);
    }
  }
  const blockerAnalysis = [...blockerCounts.entries()]
    .map(([blocker, frequency]) => ({
      blocker,
      frequency,
      percentage: blockerBase ? Math.round((frequency / blockerBase) * 100) : 0,
    }))
    .sort((a, b) => b.frequency - a.frequency);

  const discardReasonCounts = new Map();
  for (const e of enriched) {
    for (const key of recordedDiscardReasons(e)) {
      discardReasonCounts.set(key, (discardReasonCounts.get(key) || 0) + 1);
    }
  }
  const discardReasonBase = discardableBase(enriched);
  const discardReasonStats = [...discardReasonCounts.entries()]
    .map(([reason, frequency]) => ({
      reason,
      frequency,
      percentage: discardReasonBase ? Math.round((frequency / discardReasonBase) * 100) : 0,
    }))
    .sort((a, b) => b.frequency - a.frequency);

  const stackGapCounts = new Map();
  for (const e of enriched) {
    if (!REASON_BEARING.has(e.outcome)) continue;
    if (!e.report?.gaps) continue;
    const entryTechs = new Set();
    for (const gap of e.report.gaps) {
      for (const tech of extractTechMentions(gap.description)) entryTechs.add(tech);
    }
    for (const tech of entryTechs) {
      stackGapCounts.set(tech, (stackGapCounts.get(tech) || 0) + 1);
    }
  }
  const techStackGaps = [...stackGapCounts.entries()]
    .map(([skill, frequency]) => ({ skill, frequency }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 15);

  const topDiscardReason = discardReasonStats[0];
  const discardReasonRecommendation = topDiscardReason
    && topDiscardReason.frequency >= Math.max(3, Math.ceil(discardReasonBase * 0.15))
    ? {
      action: `Add "${topDiscardReason.reason}" filter to modes/_custom.md to avoid wasting evaluation effort`,
      reasoning: `"${topDiscardReason.reason}" is the most frequent discard reason (${topDiscardReason.frequency}x, ${topDiscardReason.percentage}% of ${discardReasonBase} eligible entries with self-filtered or negative outcomes).`,
      impact: 'high',
    }
    : null;

  return {
    blockerBase,
    blockerAnalysis,
    discardReasonBase,
    discardReasonStats,
    techStackGaps,
    discardReasonRecommendation,
  };
}

export function analyze(entries = parseTracker()) {
  if (entries.length === 0) {
    return { error: 'No applications found in tracker.', noData: true };
  }

  const enriched = entries.map(e => {
    const reportMatch = e.report.match(/\]\(([^)]+)\)/);
    let reportData = null;
    if (reportMatch) {
      const candidates = new Set([
        join(dirname(APPS_FILE), reportMatch[1]),
        join(CAREER_OPS, reportMatch[1]),
      ]);
      for (const candidate of candidates) {
        if (!withinReports(candidate)) continue;
        reportData = parseReport(candidate);
        if (reportData) break;
      }
    }
    const outcome = classifyOutcome(e.status);
    const trackerScore = parseFloat(e.score);
    const score = Number.isFinite(trackerScore)
      ? trackerScore
      : (Number.isFinite(reportData?.scores?.global) ? reportData.scores.global : 0);

    const remoteSource = reportData?.remote || e.notes || '';
    const teamSource = reportData?.teamSize || '';

    return {
      ...e,
      normalizedStatus: normalizeStatus(e.status),
      outcome,
      score,
      report: reportData,
      remoteBucket: classifyRemote(remoteSource),
      companySize: classifyCompanySize(teamSource),
      vendor: knownAtsVendorOf(reportData?.url),
    };
  });

  const sent = enriched.filter(e => SUBMITTED_STATUSES.has(e.normalizedStatus));
  if (sent.length < MIN_THRESHOLD) {
    return {
      error: `Not enough data: ${sent.length}/${MIN_THRESHOLD} applications sent. Keep applying and come back later.`,
      current: sent.length,
      threshold: MIN_THRESHOLD,
    };
  }

  const funnel = {};
  for (const e of enriched) {
    const s = e.normalizedStatus;
    funnel[s] = (funnel[s] || 0) + 1;
  }

  const scoresByOutcome = Object.fromEntries(OUTCOME_BUCKETS.map((b) => [b, []]));
  for (const e of enriched) {
    if (e.score > 0) scoresByOutcome[e.outcome].push(e.score);
  }

  const scoreStats = (arr) => {
    if (arr.length === 0) return { avg: 0, min: 0, max: 0, count: 0 };
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      avg: Math.round(avg * 100) / 100,
      min: Math.min(...arr),
      max: Math.max(...arr),
      count: arr.length,
    };
  };

  const scoreComparison = Object.fromEntries(
    OUTCOME_BUCKETS.map((bucket) => [bucket, scoreStats(scoresByOutcome[bucket])])
  );

  const archetypeBreakdown = breakdownBy(enriched, 'archetype', e => e.report?.archetype || 'Unknown');

  const {
    blockerBase,
    blockerAnalysis,
    discardReasonBase,
    discardReasonStats,
    techStackGaps,
    discardReasonRecommendation,
  } = buildPatternSignals(enriched);

  const remotePolicy = breakdownBy(enriched, 'policy', e => e.remoteBucket);

  const companySizeBreakdown = breakdownBy(enriched, 'size', e => e.companySize);

  const isAdvanced = (e) => ADVANCED_STATUSES.has(e.normalizedStatus);

  const submitted = enriched.filter(e => SUBMITTED_STATUSES.has(e.normalizedStatus));
  const overallAdvanced = submitted.filter(isAdvanced).length;
  const overallAdvanceRate = submitted.length > 0
    ? Math.round((overallAdvanced / submitted.length) * 100) : 0;

  const vendorMap = new Map();
  for (const e of submitted) {
    const v = e.vendor || 'unknown';
    if (!vendorMap.has(v)) vendorMap.set(v, { total: 0, advanced: 0 });
    const entry = vendorMap.get(v);
    entry.total++;
    if (isAdvanced(e)) entry.advanced++;
  }

  const vendorBreakdown = [...vendorMap.entries()]
    .filter(([v]) => v !== 'unknown')
    .map(([vendor, data]) => ({
      vendor,
      total: data.total,
      advanced: data.advanced,
      advanceRate: data.total > 0 ? Math.round((data.advanced / data.total) * 100) : 0,
      sharePct: submitted.length > 0 ? Math.round((data.total / submitted.length) * 100) : 0,
      sufficientSample: data.total >= MIN_VENDOR_N,
    }))
    .sort((a, b) => b.total - a.total);

  const identifiedCount = submitted.length - (vendorMap.get('unknown')?.total || 0);
  const vendorAnalysis = {
    scope: [...VENDOR_ANALYSIS_SCOPE],
    minSampleForClaim: MIN_VENDOR_N,
    submitted: submitted.length,
    identified: identifiedCount,
    coveragePct: submitted.length > 0 ? Math.round((identifiedCount / submitted.length) * 100) : 0,
    overallAdvanceRate,
    breakdown: vendorBreakdown,
    citation: 'Bommasani et al., Algorithmic Monocultures in Hiring, FAccT 2026 (arXiv:2605.27371)',
  };

  const viaChannelAnalysis = buildViaChannelAnalysis(submitted, isAdvanced);

  const scoreThreshold = scoreThresholdFrom(scoresByOutcome.positive, scoresByOutcome.negative);

  const recommendations = [];

  if (discardReasonRecommendation) recommendations.push(discardReasonRecommendation);

  const geoBlocker = blockerAnalysis.find(b => b.blocker === 'geo-restriction');
  if (geoBlocker && geoBlocker.percentage >= 20) {
    recommendations.push({
      action: `Review location and work-authorization filters in portals.yml -- ${geoBlocker.frequency}/${blockerBase} entries carrying gaps (${geoBlocker.percentage}%) hit a geo-restriction blocker`,
      reasoning: `${geoBlocker.frequency} of ${blockerBase} entries carrying gaps are affected by a location or work-authorization restriction. Review these filters before applying to similar roles.`,
      impact: 'high',
    });
  }

  const stackBlocker = blockerAnalysis.find(b => b.blocker === 'stack-mismatch');
  if (stackBlocker && stackBlocker.percentage >= 15) {
    const topGaps = techStackGaps.slice(0, 3).map(g => g.skill).join(', ');
    recommendations.push({
      action: `Filter out roles requiring ${topGaps} as primary stack -- ${stackBlocker.percentage}% hit stack mismatch`,
      reasoning: `Core stack gaps (${topGaps}) are the most common technical blockers in negative outcomes.`,
      impact: 'high',
    });
  }

  if (scoreThreshold.recommended !== null && scoreThreshold.recommended > 3.0) {
    recommendations.push({
      action: `Set minimum score threshold at ${scoreThreshold.recommended}/5 before generating PDFs`,
      reasoning: scoreThreshold.reasoning,
      impact: 'medium',
    });
  }

  const bestArchetype = bestDecidedSegment(archetypeBreakdown);
  if (bestArchetype) {
    recommendations.push({
      action: `Double down on "${bestArchetype.archetype}" roles (${bestArchetype.decidedRate}% of decided outcomes advanced, ${bestArchetype.conversionRate}% of all sent)`,
      reasoning: `${bestArchetype.positive} of ${bestArchetype.decided} decided applications in this archetype advanced (${bestArchetype.awaiting} still awaiting a reply).`,
      impact: 'medium',
    });
  }

  const worstRemote = worstDecidedSegment(remotePolicy);
  if (worstRemote) {
    recommendations.push({
      action: `Avoid "${worstRemote.policy}" roles (0 of ${worstRemote.decided} decided outcomes advanced, ${worstRemote.submitted} sent)`,
      reasoning: `None of the ${worstRemote.decided} decided applications with "${worstRemote.policy}" policy led to progress.`,
      impact: 'medium',
    });
  }

  let deadChannel = null;
  for (const v of vendorBreakdown) {
    if (!v.sufficientSample || v.sharePct < 25) continue;
    const others = submitted.filter(e => (e.vendor || 'unknown') !== v.vendor);
    if (others.length === 0) continue;
    const othersRate = Math.round((others.filter(isAdvanced).length / others.length) * 100);
    if (v.advanceRate < othersRate && othersRate - v.advanceRate >= 10) {
      if (!deadChannel || v.advanceRate < deadChannel.advanceRate) deadChannel = { ...v, othersRate };
    }
  }
  if (deadChannel) {
    recommendations.push({
      action: `Route ${deadChannel.vendor} companies through referral / direct contact -- ${deadChannel.sharePct}% of your applications flow through it at a ${deadChannel.advanceRate}% advance rate (vs ${deadChannel.othersRate}% through other channels)`,
      reasoning: `${deadChannel.advanced}/${deadChannel.total} ${deadChannel.vendor} applications advanced past screening, well below your other channels. Under algorithmic monoculture (Bommasani et al., FAccT 2026) a shared screener's rejections are correlated -- re-applying the same profile through the same engine has diminishing returns; a human channel bypasses it. Channel yield, not a discrimination claim.`,
      impact: 'high',
    });
  }

  const topAgency = viaChannelAnalysis.breakdown
    .filter(a => a.sufficientSample && a.advanced > 0 && a.advanceRate >= overallAdvanceRate + 10)
    .sort((a, b) => b.advanceRate - a.advanceRate)[0];
  if (topAgency) {
    recommendations.push({
      action: `Prioritize roles via ${topAgency.agency} -- ${topAgency.advanceRate}% advance rate across ${topAgency.total} submissions (overall: ${overallAdvanceRate}%)`,
      reasoning: `${topAgency.advanced}/${topAgency.total} applications through ${topAgency.agency} advanced past screening, well above your overall rate. In an agency-mediated search the highest-leverage decision is which recruiter relationships to invest in -- this one converts. Channel yield, not a causal claim.`,
      impact: 'medium',
    });
  }

  const dates = enriched.map(e => e.date).filter(Boolean).sort();

  const byOutcome = Object.fromEntries(
    OUTCOME_BUCKETS.map((bucket) => [bucket, enriched.filter(e => e.outcome === bucket).length])
  );

  return {
    metadata: {
      total: enriched.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: localToday(),
      byOutcome,
      outcomeRates: withOutcomeRates({ total: enriched.length, ...byOutcome }),
    },
    funnel,
    scoreComparison,
    archetypeBreakdown,
    blockerAnalysis,
    remotePolicy,
    companySizeBreakdown,
    vendorAnalysis,
    viaChannelAnalysis,
    scoreThreshold,
    techStackGaps,
    discardReasonStats,
    ...buildPredictedDiscardReasonSignals(enriched),
    discardReasonBase,
    blockerBase,
    recommendations,
  };
}

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }

  const { metadata, funnel, scoreComparison, archetypeBreakdown, blockerAnalysis, remotePolicy, scoreThreshold, techStackGaps, discardReasonStats, recommendations } = result;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Pattern Analysis — ${metadata.analysisDate}`);
  console.log(`  ${metadata.total} applications (${metadata.dateRange.from} to ${metadata.dateRange.to})`);
  console.log(`${'='.repeat(60)}\n`);

  console.log('CONVERSION FUNNEL');
  console.log('-'.repeat(40));
  for (const status of FUNNEL_ORDER) {
    if (funnel[status]) {
      const pct = Math.round((funnel[status] / metadata.total) * 100);
      console.log(`  ${status.padEnd(15)} ${String(funnel[status]).padStart(3)} (${pct}%)`);
    }
  }

  console.log('\nSCORE BY OUTCOME');
  console.log('-'.repeat(40));
  for (const [group, stats] of Object.entries(scoreComparison)) {
    if (stats.count > 0) {
      console.log(`  ${group.padEnd(15)} avg ${stats.avg}/5  (${stats.count} entries, range ${stats.min}-${stats.max})`);
    }
  }

  if (blockerAnalysis.length > 0) {
    console.log(`\nTOP BLOCKERS (of ${result.blockerBase} entries carrying gaps)`);
    console.log('-'.repeat(40));
    for (const b of blockerAnalysis) {
      console.log(`  ${b.blocker.padEnd(20)} ${String(b.frequency).padStart(2)}x (${b.percentage}%)`);
    }
  }

  console.log('\nREMOTE POLICY');
  console.log('-'.repeat(40));
  for (const r of remotePolicy) {
    const decidedLabel = r.decidedRate === null ? 'n/a' : `${r.decidedRate}%`;
    console.log(`  ${r.policy.padEnd(20)} ${String(r.submitted).padStart(2)} sent, ${r.awaiting} awaiting, ${r.positive} positive of ${r.decided} decided (${decidedLabel})`);
  }

  if (techStackGaps.length > 0) {
    console.log('\nTOP TECH STACK GAPS (negative / discarded outcomes)');
    console.log('-'.repeat(40));
    for (const g of techStackGaps.slice(0, 10)) {
      console.log(`  ${g.skill.padEnd(20)} ${g.frequency}x`);
    }
  }

  if (discardReasonStats && discardReasonStats.length > 0) {
    console.log(`\nTOP DISCARD / SKIP REASONS (of ${result.discardReasonBase} self-filtered / discarded / negative entries)`);
    console.log('-'.repeat(40));
    for (const d of discardReasonStats.slice(0, 10)) {
      console.log(`  ${d.reason.padEnd(30)} ${String(d.frequency).padStart(2)}x (${d.percentage}%)`);
    }
  }

  const coverage = result.discardReasonCoverage;
  console.log(`\nPREDICTED DISCARD / SKIP REASONS (of ${result.predictedDiscardReasonBase} entries with prediction data)`);
  console.log('-'.repeat(40));
  console.log(`  Prediction data: ${coverage.entriesWithPredictionData}/${coverage.entriesWithReports} entries with linked reports; ${coverage.entriesWithPredictions} contain reasons.`);
  console.log(`  Recorded reasons: ${coverage.entriesWithRecordedReasons}/${result.discardReasonBase} eligible entries; ${coverage.entriesWithBothSources} entries have both sources.`);
  console.log('  Forecasts cover all statuses; recorded reasons cover skipped, discarded, and rejected entries.');
  console.log('  Predictions are not outcomes. Missing data is unknown; canonical ids are matched by spelling, not meaning.');
  const other = result.predictedDiscardReasonOther;
  if (!other.vocabularyLoaded) {
    console.log('  templates/discard-reasons.yml could not be read; every predicted reason is listed as other.');
  }
  if (result.predictedDiscardReasonBase === 0) {
    console.log('  No prediction data recorded yet.');
  } else if (result.predictedDiscardReasonStats.length === 0 && other.reasons.length === 0) {
    console.log('  No reasons predicted in the recorded data.');
  } else {
    for (const d of result.predictedDiscardReasonStats.slice(0, 10)) {
      console.log(`  ${d.reason.padEnd(30)} ${String(d.frequency).padStart(2)}x (${d.percentage}%)`);
    }
    if (other.entries > 0) {
      console.log(`  other (outside the vocabulary, not counted above): ${other.entries} entries (${other.percentage}%)`);
      for (const d of other.reasons.slice(0, 10)) {
        console.log(`    ${d.reason.padEnd(28)} ${String(d.frequency).padStart(2)}x`);
      }
    }
  }

  const va = result.vendorAnalysis;
  if (va && va.breakdown.length > 0) {
    console.log('\nATS CHANNEL ANALYSIS (community ATS only)');
    console.log('-'.repeat(40));
    console.log(`  vendor identified for ${va.identified}/${va.submitted} submissions (${va.coveragePct}% coverage); overall advance rate ${va.overallAdvanceRate}%`);
    for (const v of va.breakdown) {
      const flag = v.sufficientSample ? '' : '  (n too small for a claim)';
      console.log(`  ${v.vendor.padEnd(12)} ${String(v.total).padStart(3)} apps  ${String(v.sharePct).padStart(3)}% share  ${String(v.advanceRate).padStart(3)}% advance${flag}`);
    }
    console.log('  Channel yield, not discrimination — see Bommasani et al., FAccT 2026.');
  }

  const via = result.viaChannelAnalysis;
  if (via && (via.breakdown.length > 0 || via.directSubmitted > 0)) {
    console.log('\nVIA CHANNEL ANALYSIS (agency vs direct, #1596)');
    console.log('-'.repeat(40));
    console.log(`  direct  ${String(via.directSubmitted).padStart(3)} apps  ${String(via.directAdvanceRate).padStart(3)}% advance`);
    console.log(`  agency  ${String(via.agencySubmitted).padStart(3)} apps  ${String(via.agencyAdvanceRate).padStart(3)}% advance`);
    if (via.unknownVia > 0) {
      console.log(`  unknown ${String(via.unknownVia).padStart(3)} apps  (no Via recorded — not counted in either channel)`);
    }
    for (const a of via.breakdown) {
      const flag = a.sufficientSample ? '' : '  (n too small for a claim)';
      console.log(`    ${a.agency.padEnd(16)} ${String(a.total).padStart(3)} apps  ${String(a.advanceRate).padStart(3)}% advance${flag}`);
    }
  }

  if (scoreThreshold.recommended !== null) {
    console.log(`\nSCORE THRESHOLD: ${scoreThreshold.recommended}/5`);
  } else {
    console.log(`\nSCORE OBSERVATION: lowest positive ${scoreThreshold.observedMinimum ?? 'n/a'}/5 (n=${scoreThreshold.sampleSize}; not a threshold yet)`);
  }
  console.log(`  ${scoreThreshold.reasoning}`);

  if (recommendations.length > 0) {
    console.log(`\nRECOMMENDATIONS`);
    console.log('='.repeat(60));
    for (let i = 0; i < recommendations.length; i++) {
      const r = recommendations[i];
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`);
      console.log(`     ${r.reasoning}`);
    }
  }

  console.log('');
}

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });

  const rawMinThreshold = flagValue(args, '--min-threshold');
  const rawMinVendorN = flagValue(args, '--min-vendor-n');

  if (hasFlag(args, '--min-threshold')) {
    if (rawMinThreshold === undefined || !/^\d+$/.test(String(rawMinThreshold)) ||
        !Number.isSafeInteger(Number(rawMinThreshold))) {
      console.error(`Error: --min-threshold requires a non-negative integer, got "${rawMinThreshold ?? ''}"`);
      process.exit(1);
    }
    MIN_THRESHOLD = Number(rawMinThreshold);
  }

  if (hasFlag(args, '--min-vendor-n')) {
    if (rawMinVendorN === undefined || !/^\d+$/.test(String(rawMinVendorN)) ||
        !Number.isSafeInteger(Number(rawMinVendorN)) || Number(rawMinVendorN) < 1) {
      console.error(`Error: --min-vendor-n requires a positive integer, got "${rawMinVendorN ?? ''}"`);
      process.exit(1);
    }
    MIN_VENDOR_N = Number(rawMinVendorN);
  }

  if (args.includes('--self-test')) {
    runSelfTest();
  }

  const result = analyze();

  if (summaryMode) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.error && !result.noData) process.exit(1);
}
