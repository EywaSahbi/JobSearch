#!/usr/bin/env node

import { readFileSync, existsSync, statSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { load as yamlLoad } from 'js-yaml';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(CAREER_OPS);
const CV_FILE = join(CAREER_OPS, 'cv.md');
const PROFILE_FILE = join(CAREER_OPS, 'config/profile.yml');

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

export const SCHEMA_VERSION = 2;

const LOW_FIT_SCORE = 4.0;

import { extractSkills } from './skill-extract.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
export { extractSkills };

export function yamlValueText(raw, onParseFailure) {
  if (!raw) return '';
  let doc;
  try {
    doc = yamlLoad(raw);
  } catch (err) {
    if (onParseFailure) onParseFailure(err);
    return raw;
  }
  const out = [];
  const seen = new WeakSet();
  const walk = (node) => {
    if (node == null) return;
    const t = typeof node;
    if (t === 'string' || t === 'number' || t === 'boolean') { out.push(String(node)); return; }
    if (t !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) { out.push(String(k)); walk(v); }
  };
  walk(doc);
  return out.join('\n');
}

export function stripMarkdownComments(raw) {
  return String(raw ?? '').replace(/<!--[\s\S]*?-->/g, '\n');
}

export function knownSkillsText(cvRaw, profileRaw, onProfileParseFailure) {
  return [
    stripMarkdownComments(cvRaw),
    yamlValueText(profileRaw, onProfileParseFailure),
  ].join('\n');
}

function warnProfileUnparseable(err) {
  const detail = String(err?.message ?? '').split('\n')[0];
  console.error(
    `upskill: warning — config/profile.yml could not be parsed (${detail}). ` +
    'Falling back to its raw text, so comments in it may still register as ' +
    'known skills and be suppressed from the gap map. Fix the YAML to restore ' +
    'comment-aware extraction.'
  );
}

export function readOptionalText(filePath) {
  try {
    if (!statSync(filePath).isFile()) return '';
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function parseMachineSummary(content) {
  const fenceMatch = content.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (!fenceMatch) return null;
  const raw = fenceMatch[1].trim();
  if (!raw) return null;
  try {
    const parsed = yamlLoad(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') return [];
  return [String(value).trim()].filter(Boolean);
}

export function parseReportGaps(content) {
  const gapDescriptions = [];
  let score = null;
  let hasMachineSummary = false;

  const summary = parseMachineSummary(content);
  if (summary) {
    hasMachineSummary = true;
    if (typeof summary.score === 'number' && Number.isFinite(summary.score)) score = summary.score;
    gapDescriptions.push(...normalizeList(summary.hard_stops));
    gapDescriptions.push(...normalizeList(summary.soft_gaps));
  }

  const plain = content.replace(/\*\*/g, '');
  if (score === null) {
    const glMatch = plain.match(/\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i);
    if (glMatch) score = parseFloat(glMatch[1]);
  }

  const gapTableMatch = content.match(/\|\s*Gap\s*\|\s*Severity\s*\|.*?\n\|[-|\s]+\n([\s\S]*?)(?:\n\n|\n##|\n\*\*|$)/i);
  if (gapTableMatch) {
    for (const row of gapTableMatch[1].split('\n').filter(r => r.startsWith('|'))) {
      const cols = row.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) gapDescriptions.push(cols[0]);
    }
  }

  return { score, gapText: gapDescriptions.join('\n'), hasMachineSummary };
}

export function companyKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function aggregateGaps(reports, knownSkills, companyNames = new Set()) {
  const scored = reports.filter(r => Number.isFinite(r.score));
  const lowFit = scored.filter(r => r.score < LOW_FIT_SCORE);
  const totalLowFit = lowFit.length;

  const companyLookup = new Set([...companyNames].map(companyKey).filter(Boolean));

  const bySkill = new Map();
  const excludedCounts = new Map();
  const companyCounts = new Map();

  for (const report of reports) {
    const skills = extractSkills(report.gapText);
    for (const skill of skills) {
      if (knownSkills.has(skill)) {
        excludedCounts.set(skill, (excludedCounts.get(skill) || 0) + 1);
        continue;
      }
      if (companyLookup.has(companyKey(skill))) {
        companyCounts.set(skill, (companyCounts.get(skill) || 0) + 1);
        continue;
      }
      if (!bySkill.has(skill)) {
        bySkill.set(skill, { skill, reports: 0, lowFitReports: 0, weightedScore: 0, sources: [] });
      }
      const entry = bySkill.get(skill);
      entry.reports += 1;
      entry.sources.push(report.num);
      const weight = Number.isFinite(report.score) ? Math.max(0, 5.0 - report.score) : 1.0;
      entry.weightedScore += weight;
      if (Number.isFinite(report.score) && report.score < LOW_FIT_SCORE) entry.lowFitReports += 1;
    }
  }

  const gaps = [...bySkill.values()].map(g => {
    const share = totalLowFit > 0 ? g.lowFitReports / totalLowFit : 0;
    let tier = 'Low';
    if (share >= 0.5 && g.lowFitReports >= 3) tier = 'Critical';
    else if (share >= 0.3 && g.lowFitReports >= 2) tier = 'High';
    else if (g.lowFitReports >= 2) tier = 'Medium';
    return {
      ...g,
      lowFitShare: Math.round(share * 100) / 100,
      weightedScore: Math.round(g.weightedScore * 100) / 100,
      tier,
    };
  }).sort((a, b) => b.weightedScore - a.weightedScore || b.reports - a.reports);

  const excludedAsKnown = [...excludedCounts.entries()]
    .map(([skill, reports]) => ({ skill, reports }))
    .sort((a, b) => b.reports - a.reports);

  const excludedAsCompanyName = [...companyCounts.entries()]
    .map(([skill, reports]) => ({ skill, reports }))
    .sort((a, b) => b.reports - a.reports);

  return { gaps, excludedAsKnown, excludedAsCompanyName, totalLowFit };
}

export function computeTargetedGaps(jdText, knownText) {
  const known = extractSkills(knownText);
  const gaps = [];
  const excludedAsKnown = [];
  for (const skill of extractSkills(jdText)) {
    (known.has(skill) ? excludedAsKnown : gaps).push(skill);
  }
  return { gaps, excludedAsKnown, knownSkills: [...known].sort() };
}

function analyze(minReports) {
  if (!existsSync(APPS_FILE)) {
    return { error: 'No applications tracker found. Run some evaluations first.' };
  }

  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  const rows = lines.map(l => parseTrackerRow(l, colmap)).filter(Boolean);

  let reportsLinked = 0;
  let reportsRead = 0;
  let reportsWithMachineSummary = 0;
  const parsedReports = [];
  const companyNames = new Set(
    rows.map(r => companyKey(r.company)).filter(name => name && name !== '?')
  );

  for (const row of rows) {
    const linkMatch = (row.report || '').match(/\]\(([^)]+)\)/);
    if (!linkMatch) continue;
    reportsLinked += 1;
    const candidates = new Set([join(dirname(APPS_FILE), linkMatch[1]), join(CAREER_OPS, linkMatch[1])]);
    let content = null;
    for (const p of candidates) {
      if (!withinReports(p)) continue;
      content = readTextIfExists(p);
      if (content !== null) break;
    }
    if (content === null) continue;
    reportsRead += 1;
    const { score, gapText, hasMachineSummary } = parseReportGaps(content);
    if (hasMachineSummary) reportsWithMachineSummary += 1;
    const trackerScore = parseFloat(row.score);
    parsedReports.push({
      num: row.num,
      score: Number.isFinite(trackerScore) ? trackerScore : score,
      gapText,
    });
  }

  const scoredCount = parsedReports.filter(r => Number.isFinite(r.score)).length;
  if (scoredCount < minReports) {
    return {
      error: `Not enough data: ${scoredCount}/${minReports} scored reports. Evaluate more offers and come back.`,
      current: scoredCount,
      threshold: minReports,
    };
  }

  const knownText = knownSkillsText(
    readOptionalText(CV_FILE),
    readOptionalText(PROFILE_FILE),
    warnProfileUnparseable,
  );
  const knownSkills = extractSkills(knownText);

  const { gaps, excludedAsKnown, excludedAsCompanyName, totalLowFit } =
    aggregateGaps(parsedReports, knownSkills, companyNames);

  return {
    schema_version: SCHEMA_VERSION,
    metadata: {
      reportsLinked,
      reportsRead,
      reportsWithMachineSummary,
      reportsScored: scoredCount,
      lowFitReports: totalLowFit,
      lowFitScoreThreshold: LOW_FIT_SCORE,
      knownSkillCount: knownSkills.size,
      trackedCompanyCount: companyNames.size,
    },
    gaps,
    excludedAsKnown,
    excludedAsCompanyName,
    knownSkills: [...knownSkills].sort(),
  };
}

function printSummary(result) {
  if (result.error) {
    console.log(`upskill: ${result.error}`);
    return;
  }
  const m = result.metadata;
  console.log(`UPSKILL GAP MAP (schema v${result.schema_version})`);
  console.log(`Reports: ${m.reportsRead}/${m.reportsLinked} read, ${m.reportsScored} scored, ${m.lowFitReports} low-fit (<${m.lowFitScoreThreshold}), ${m.reportsWithMachineSummary} with Machine Summary`);
  console.log('');
  if (result.gaps.length === 0) {
    console.log('No skill gaps detected across your evaluated reports.');
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('TIER', 10)}${pad('SKILL', 22)}${pad('REPORTS', 9)}${pad('LOW-FIT', 9)}WEIGHTED`);
    for (const g of result.gaps) {
      console.log(`${pad(g.tier, 10)}${pad(g.skill, 22)}${pad(g.reports, 9)}${pad(`${g.lowFitReports}/${result.metadata.lowFitReports}`, 9)}${g.weightedScore}`);
    }
  }
  if (result.excludedAsKnown.length > 0) {
    console.log('');
    console.log(`Excluded (already in cv.md/profile): ${result.excludedAsKnown.map(e => e.skill).join(', ')}`);
  }
  if (result.excludedAsCompanyName?.length > 0) {
    console.log('');
    console.log(`Excluded (company in your tracker, not a skill): ${result.excludedAsCompanyName.map(e => e.skill).join(', ')}`);
  }
}

function runSelfTest() {
  const failures = [];

  const cvSkills = extractSkills('Expert in Java and AWS.');
  if (cvSkills.has('JavaScript')) failures.push('cv "Java" wrongly matched JavaScript');
  const { gaps: g1 } = aggregateGaps(
    [{ num: 1, score: 2.0, gapText: 'Missing JavaScript and GCP experience' }],
    cvSkills
  );
  const gapNames = g1.map(g => g.skill);
  if (!gapNames.includes('JavaScript')) failures.push('JavaScript gap suppressed by cv "Java"');
  if (!gapNames.includes('GCP')) failures.push('GCP gap suppressed by cv "AWS"');

  const { gaps: g2, excludedAsKnown: ex2 } = aggregateGaps(
    [{ num: 2, score: 3.0, gapText: 'Needs Java and Kubernetes' }],
    extractSkills('Java developer')
  );
  if (g2.some(g => g.skill === 'Java')) failures.push('known skill Java appeared as gap');
  if (!ex2.some(e => e.skill === 'Java')) failures.push('excludedAsKnown missing Java');
  if (!g2.some(g => g.skill === 'Kubernetes')) failures.push('Kubernetes gap missing');

  const { gaps: g3 } = aggregateGaps(
    [
      { num: 3, score: 2.0, gapText: 'Kubernetes Kubernetes Kubernetes' },
      { num: 4, score: 4.5, gapText: 'Kubernetes' },
    ],
    new Set()
  );
  const k = g3.find(g => g.skill === 'Kubernetes');
  if (!k) failures.push('Kubernetes not aggregated');
  else {
    if (k.reports !== 2) failures.push(`presence not deduped per report (reports=${k.reports})`);
    if (Math.abs(k.weightedScore - 3.5) > 1e-9) failures.push(`weightedScore expected 3.5, got ${k.weightedScore}`);
  }

  const lowFitReports = [
    { num: 10, score: 2.0, gapText: 'Terraform' },
    { num: 11, score: 2.5, gapText: 'Terraform' },
    { num: 12, score: 3.0, gapText: 'Terraform and Spark' },
    { num: 13, score: 3.5, gapText: 'nothing here' },
    { num: 14, score: 3.9, gapText: 'nothing here' },
  ];
  const { gaps: g4 } = aggregateGaps(lowFitReports, new Set());
  const terraform = g4.find(g => g.skill === 'Terraform');
  const spark = g4.find(g => g.skill === 'Spark');
  if (terraform?.tier !== 'Critical') failures.push(`Terraform tier expected Critical, got ${terraform?.tier}`);
  if (spark?.tier !== 'Low') failures.push(`Spark tier expected Low, got ${spark?.tier}`);

  const parsed = parseReportGaps(`
# 042 - Acme

| Gap | Severity | Mitigation |
|-----|----------|------------|
| No Kafka experience | soft gap | Learn it |

## Machine Summary

\`\`\`yaml
score: 3.2
hard_stops: []
soft_gaps:
  - "Limited Airflow exposure"
\`\`\`
`);
  if (parsed.score !== 3.2) failures.push(`report score expected 3.2, got ${parsed.score}`);
  if (!parsed.hasMachineSummary) failures.push('hasMachineSummary false');
  if (!/Kafka/.test(parsed.gapText)) failures.push('Gap table row not captured');
  if (!/Airflow/.test(parsed.gapText)) failures.push('soft_gaps not captured');

  {
    const { gaps, excludedAsKnown } = computeTargetedGaps(
      'Kubernetes, C++, .NET, Java, SQL, Go, LLMs',
      'k8s, C++, .NET, JavaScript, PostgreSQL, MongoDB, LLMs'
    );
    const gapSet = new Set(gaps);
    const exSet = new Set(excludedAsKnown);
    for (const g of ['Java', 'SQL', 'Go']) {
      if (!gapSet.has(g)) failures.push(`targeted: ${g} should be a gap (got ${gaps.join(',')})`);
      if (exSet.has(g)) failures.push(`targeted: real gap ${g} wrongly suppressed as known`);
    }
    for (const k of ['Kubernetes', 'C++', '.NET', 'LLMs']) {
      if (!exSet.has(k)) failures.push(`targeted: ${k} should be excluded as known (got ${excludedAsKnown.join(',')})`);
      if (gapSet.has(k)) failures.push(`targeted: known skill ${k} wrongly reported as gap`);
    }
  }

  {
    const jdText = 'Requirements:\n- Kubernetes and Go\n- 5+ years experience';
    const { gaps } = computeTargetedGaps(jdText, 'Python, AWS');
    if (!gaps.includes('Kubernetes') || !gaps.includes('Go')) {
      failures.push(`url-text: multi-line JD string should yield Kubernetes+Go gaps (got ${gaps.join(',')})`);
    }
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    if (/normalizeJd\(\s*targetText/.test(selfSrc)) {
      failures.push('url-text: upskill.mjs still passes the raw fetched string to normalizeJd (regression, #1894)');
    }
    if (!/compactText\(targetText\)/.test(selfSrc)) {
      failures.push('url-text: fetched text should be normalized with compactText (string->string), #1894');
    }
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
            console.log(`upskill self-test: skipping symlink-escape assertion (platform refused symlink creation: ${err.code})`);
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

  {
    const profile = [
      'candidate:',
      '  full_name: "Test User"',
      '# We dropped Kubernetes last year and never picked up Terraform.',
      'skills:',
      '  - Python',
    ].join('\n');
    const cv = '# CV\n\n<!-- template note: list Snowflake if you have used it -->\n\n## Skills\nSQL, AWS\n';

    const leaked = extractSkills([cv, profile].join('\n'));
    if (!leaked.has('Kubernetes') || !leaked.has('Snowflake')) {
      failures.push('known-skills: fixture no longer reproduces the raw-concat leak — rewrite it, not the fix');
    }

    const fixed = extractSkills(knownSkillsText(cv, profile));
    for (const ghost of ['Kubernetes', 'Terraform', 'Snowflake']) {
      if (fixed.has(ghost)) failures.push(`known-skills: "${ghost}" leaked from a comment`);
    }
    for (const real of ['Python', 'SQL', 'AWS']) {
      if (!fixed.has(real)) failures.push(`known-skills: real skill "${real}" was dropped`);
    }

    if (!extractSkills(yamlValueText('skills:\n  Python: expert\n')).has('Python')) {
      failures.push('known-skills: key-position skill dropped');
    }

    if (!extractSkills(yamlValueText('note: "uses C# daily"\n')).has('C#')) {
      failures.push('known-skills: "#" inside a quoted string was treated as a comment');
    }

    if (!yamlValueText('key: [unclosed\n  bad: : :').includes('unclosed')) {
      failures.push('known-skills: unparseable YAML should fall back to raw text');
    }

    {
      const badProfile = '# We dropped Kubernetes.\nkey: [unclosed\n  bad: : :';
      let notified = 0;
      const text = yamlValueText(badProfile, () => { notified++; });
      if (notified !== 1) {
        failures.push(`known-skills: unparseable YAML must notify the caller exactly once (got ${notified})`);
      }
      if (!text.includes('unclosed')) {
        failures.push('known-skills: notifying must not change the raw-text fallback');
      }
      if (!extractSkills(text).has('Kubernetes')) {
        failures.push('known-skills: malformed-YAML fixture no longer leaks — rewrite it, not the warning');
      }
      let spurious = 0;
      yamlValueText('skills:\n  - Python\n', () => { spurious++; });
      if (spurious !== 0) {
        failures.push('known-skills: valid YAML must not emit a parse-failure warning');
      }
      let forwarded = 0;
      knownSkillsText('# CV\n', badProfile, () => { forwarded++; });
      if (forwarded !== 1) {
        failures.push(`known-skills: knownSkillsText must forward the parse-failure callback (got ${forwarded})`);
      }
    }

    if (stripMarkdownComments('a <!-- x --> b').includes('x')) {
      failures.push('known-skills: markdown comment not stripped');
    }

    const cyclicYaml = 'root: &a\n  name: Python\n  self: *a\n';
    const cyclicDoc = yamlLoad(cyclicYaml);
    if (cyclicDoc?.root?.self !== cyclicDoc?.root) {
      failures.push('known-skills: cyclic fixture no longer produces a cycle — rewrite it, not the guard');
    }
    try {
      if (!extractSkills(yamlValueText(cyclicYaml)).has('Python')) {
        failures.push('known-skills: cyclic YAML lost a real value');
      }
    } catch (e) {
      failures.push(`known-skills: cyclic YAML alias threw (${e.constructor.name}) instead of terminating`);
    }

    if (readOptionalText(join(CAREER_OPS, 'no-such-file-xyz.md')) !== '') {
      failures.push('readOptionalText: a missing file should read as empty');
    }
    if (readOptionalText(CAREER_OPS) !== '') {
      failures.push('readOptionalText: a DIRECTORY should read as empty, not throw EISDIR');
    }
  }

  if (failures.length > 0) {
    console.error(`upskill self-test failed: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('upskill self-test OK (extraction, suppression guards, weighting, tiering, report parsing, known-skills comment handling)');
  process.exit(0);
}

const dnsCache = new Map();

async function validateUrlSecurity(urlString) {
  const dns = await import('dns/promises');
  const url = new URL(urlString.endsWith('.') ? urlString.slice(0, -1) : urlString);
  const hostname = url.hostname;

  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Access denied: Localhost or internal domain target detected.');
  }

  let addresses;
  if (dnsCache.has(hostname)) {
    addresses = dnsCache.get(hostname);
  } else {
    addresses = await dns.resolve(hostname).catch(() => []);
    const lookupRes = await dns.lookup(hostname).catch(() => null);
    if (lookupRes) addresses.push(lookupRes.address);
    dnsCache.set(hostname, addresses);
  }

  for (const ip of addresses) {
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/.test(ip)) {
      throw new Error(`Access denied: Egress guard blocked private target IP ${ip}`);
    }
    if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) {
      throw new Error(`Access denied: Egress guard blocked private target IPv6 ${ip}`);
    }
  }
  return url.toString();
}

const isMain = isMainModule(import.meta.url);

const KNOWN_FLAGS = ['--min-reports', '--summary', '--url-text', '--self-test', '--help', '-h'];

const VALUE_FLAGS = ['--min-reports', '--url-text'];

const USAGE = `Usage:
  node upskill.mjs                        # aggregate skill-gap map (JSON)
  node upskill.mjs --summary              # human-readable table
  node upskill.mjs --min-reports <n>      # minimum scored reports required (default 5)
  node upskill.mjs --url-text <url|path>  # targeted gap analysis vs one JD (URL or local file)
  node upskill.mjs <url>                  # same as --url-text <url>
  node upskill.mjs --self-test            # run the pure-function self-tests
  node upskill.mjs --help                 # show this message`;

if (isMain) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  if (args.includes('--self-test')) runSelfTest();

  const urlTextIdx = args.indexOf('--url-text');
  const directUrl = args.find(arg => arg.startsWith('http://') || arg.startsWith('https://'));

  if (urlTextIdx !== -1 || directUrl) {
    (async () => {
      let targetText = '';
      const inputSource = urlTextIdx !== -1 ? args[urlTextIdx + 1] : directUrl;

      if (!inputSource) {
        console.error('Error: Please provide a valid URL or file path after --url-text');
        process.exit(1);
      }

      if (inputSource.startsWith('http://') || inputSource.startsWith('https://')) {
        let browser;
        try {
          const secureUrl = await validateUrlSecurity(inputSource);
          const { chromium } = await import('playwright');
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();

          await page.route('**/*', async (route) => {
            const requestUrl = route.request().url();
            try {
              await validateUrlSecurity(requestUrl);
              await route.continue();
            } catch (err) {
              console.error(`Security Violation on Redirect: ${err.message}`);
              await route.abort('blockedbyclient');
              process.exit(1);
            }
          });

          await page.goto(secureUrl, { waitUntil: 'networkidle', timeout: 30000 });
          targetText = await page.innerText('body');
        } catch (err) {
          console.warn('Playwright extraction failed or blocked, trying fallback WebFetch...', err.message);
          try {
            const secureUrl = await validateUrlSecurity(inputSource);
            const res = await fetch(secureUrl, { signal: AbortSignal.timeout(30000), redirect: 'error' });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            targetText = await res.text();
          } catch (fetchErr) {
            console.error(`Fatal: Failed to fetch JD from URL: ${fetchErr.message}`);
            process.exit(1);
          }
        } finally {
          if (browser) await browser.close();
        }

        try {
          const { compactText } = await import('./browser-extract.mjs');
          targetText = compactText(targetText);
        } catch (e) {}
      } else {
        targetText = readOptionalText(inputSource);
        if (!targetText.trim()) {
          console.error(`Fatal: Target file is missing, unreadable, or empty: ${inputSource}`);
          process.exit(1);
        }
      }

      const profileRaw = readOptionalText(PROFILE_FILE);
      let cvRaw = readOptionalText(CV_FILE);
      if (!cvRaw) cvRaw = readOptionalText(join(CAREER_OPS, 'cv-example.md'));

      const { gaps: gapList, excludedAsKnown, knownSkills } =
        computeTargetedGaps(
          targetText,
          knownSkillsText(cvRaw, profileRaw, warnProfileUnparseable),
        );

      console.log(JSON.stringify({
        mode: 'targeted',
        source: inputSource,
        gaps: gapList.map(skill => ({ skill })),
        excludedAsKnown: excludedAsKnown.map(skill => ({ skill })),
        knownSkills,
      }, null, 2));

      process.exit(0);
    })().catch((err) => {
      console.error(`Fatal: targeted analysis failed: ${err?.message ?? err}`);
      process.exit(1);
    });
  } else {
    const minReportsIdx = args.indexOf('--min-reports');
    const MIN_REPORTS = (() => {
      if (minReportsIdx === -1 || args[minReportsIdx + 1] === undefined) return 5;
      const n = parseInt(args[minReportsIdx + 1], 10);
      return Number.isNaN(n) || n < 1 ? 5 : n;
    })();

    const result = analyze(MIN_REPORTS);
    if (args.includes('--summary')) {
      printSummary(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
}
