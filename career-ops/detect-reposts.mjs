#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { roleFuzzyMatch } from './role-matcher.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { flagValue, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { parseDate } from './lib/parse-date.mjs';
import { parseScanHistoryLine, scanHistoryLineHasColumn } from './lib/scan-history-columns.mjs';

const CAREER_OPS = getCareerOpsRoot();
const SCAN_HISTORY_PATH = join(CAREER_OPS, 'data/scan-history.tsv');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(CAREER_OPS, 'portals.yml');
const DEFAULT_WINDOW_DAYS = 90;

const MIN_REPOST_SPAN_DAYS = 1;

const KNOWN_FLAGS = ['--window', '--min-span', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--window', '--min-span'];

const USAGE = `Usage:
  node detect-reposts.mjs                       # full JSON repost clusters to stdout
  node detect-reposts.mjs --summary             # human-readable table
  node detect-reposts.mjs --window 60           # override the default 90-day window
  node detect-reposts.mjs --min-span 7          # override the default 1-day minimum span
  node detect-reposts.mjs --self-test           # run the in-memory test suite
  node detect-reposts.mjs --help                # print this usage block and exit`;

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const intFlag = (flag, fallback) => safeIntFlag(flagValue(args, flag), fallback);
const windowDays = intFlag('--window', DEFAULT_WINDOW_DAYS);
const minSpanDays = intFlag('--min-span', MIN_REPOST_SPAN_DAYS);

function daysBetween(d1, d2) {
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

export function parseScanHistory(content) {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  const rows = [];
  const hasHeader = /^\s*url\s*\t/i.test(lines[0]);
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    if (!scanHistoryLineHasColumn(line, 'company')) continue;
    const row = parseScanHistoryLine(line);
    const date = parseDate(row.first_seen);
    if (!row.url || !date) continue;
    rows.push({
      url: row.url.trim(),
      date,
      dateStr: row.first_seen.trim(),
      portal: row.portal.trim(),
      title: row.title.trim(),
      company: row.company.trim(),
      status: (row.status || 'added').trim(),
      location: row.location.trim(),
      normCompany: row.normalized_company.trim(),
    });
  }
  return rows;
}

export function companyKey(row) {
  const stored = typeof row.normCompany === 'string' ? row.normCompany.trim() : '';
  const raw = typeof row.company === 'string' ? row.company.trim() : '';
  return stored || normalizeCompanyName(raw) || raw.toLowerCase();
}

export function loadAggregatorCompanies(portalsPath = PORTALS_PATH) {
  const found = new Map();
  try {
    if (!existsSync(portalsPath)) return found;
    const doc = yaml.load(readFileSync(portalsPath, 'utf-8'));
    for (const entries of [doc?.tracked_companies, doc?.job_boards]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || entry.aggregator !== true) continue;
        const raw = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!raw) continue;
        const key = normalizeCompanyName(raw) || raw.toLowerCase();
        if (key && !found.has(key)) found.set(key, raw);
      }
    }
  } catch {
    return found;
  }
  return found;
}

export function isKeyLookup(value) {
  return value instanceof Set || value instanceof Map;
}

export function titleIdentityKey(title) {
  const raw = String(title ?? '').trim();
  const words = raw
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return raw.toLowerCase();
  return [...new Set(words)].sort().join(' ');
}

function loadScanHistory(path = SCAN_HISTORY_PATH) {
  if (!existsSync(path)) return [];
  return parseScanHistory(readFileSync(path, 'utf-8'));
}

export function detectReposts(rows, windowDays = DEFAULT_WINDOW_DAYS, minSpan = MIN_REPOST_SPAN_DAYS, aggregators = null) {
  if (!Array.isArray(rows)) return [];
  const valid = rows
    .filter(r =>
      r &&
      typeof r === 'object' &&
      r.status === 'added' &&
      typeof r.url === 'string' && r.url.trim() &&
      r.date instanceof Date &&
      !Number.isNaN(r.date.getTime()) &&
      typeof r.company === 'string' && r.company.trim() &&
      typeof r.title === 'string' && r.title.trim()
    )
    .map(r => ({
      ...r,
      url: r.url.trim(),
      company: r.company.trim(),
      title: r.title.trim(),
    }));
  if (valid.length < 2) return [];

  const byCompany = new Map();
  for (const row of valid) {
    const key = companyKey(row);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }

  const skip = isKeyLookup(aggregators) ? aggregators : null;

  const clusters = [];
  for (const [key, groupRows] of byCompany) {
    if (groupRows.length < 2) continue;
    if (skip && skip.has(key)) continue;
    clusters.push(...detectRepostsInGroup(groupRows, windowDays, minSpan));
  }
  return clusters.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

function detectRepostsInGroup(rows, windowDays, minSpan = MIN_REPOST_SPAN_DAYS) {
  const titleGroups = groupRowsByTitle(rows);

  const results = [];
  for (const group of titleGroups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));
    let cluster = [];

    for (const row of sorted) {
      if (cluster.length === 0) {
        cluster = [row];
        continue;
      }
      const first = cluster[0];
      const span = daysBetween(first.date, row.date);
      if (span <= windowDays) {
        cluster.push(row);
      } else {
        if (cluster.length >= 2) {
          const result = buildRepostCluster(cluster, windowDays, minSpan);
          if (result) results.push(result);
        }
        cluster = cluster.filter(c => daysBetween(c.date, row.date) <= windowDays);
        cluster.push(row);
      }
    }
    if (cluster.length >= 2) {
      const result = buildRepostCluster(cluster, windowDays, minSpan);
      if (result) results.push(result);
    }
  }
  return results;
}

function groupRowsByTitle(rows) {
  const groups = [];
  const groupOfKey = new Map();
  for (const row of rows) {
    const key = titleIdentityKey(row.title);
    let idx = groupOfKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groupOfKey.set(key, idx);
      groups.push([]);
    }
    groups[idx].push(row);
  }
  return groups;
}

function buildRepostCluster(clusterRows, windowDays, minSpan = MIN_REPOST_SPAN_DAYS) {
  const byUrl = new Map();
  for (const row of clusterRows) {
    if (!byUrl.has(row.url) || row.date < byUrl.get(row.url).date) {
      byUrl.set(row.url, row);
    }
  }
  const deduped = [...byUrl.values()];

  if (deduped.length < 2) return null;

  const sorted = [...deduped].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = daysBetween(first.date, last.date);
  if (span > windowDays) return null;
  if (span < minSpan) return null;

  const role = last.title;
  const appearances = sorted.map(r => ({ url: r.url, date: r.dateStr, title: r.title }));

  return {
    company: clusterRows[0].company,
    role,
    repostCount: appearances.length,
    firstSeen: first.dateStr,
    lastSeen: last.dateStr,
    daysSpan: span,
    appearances,
  };
}

function printSummary(clusters, aggregatorCount = 0) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Repost Detector — career-ops');
  console.log(`  window: ${windowDays} days | min span: ${minSpanDays} day(s) | aggregators skipped: ${aggregatorCount} | clusters: ${clusters.length}`);
  console.log(`${'='.repeat(78)}\n`);

  if (clusters.length === 0) {
    console.log('  No reposted roles detected.\n');
    return;
  }

  const header =
    '  ' +
    'Company'.padEnd(22) +
    'Role'.padEnd(34) +
    'Reposts'.padEnd(9) +
    'Span'.padEnd(12) +
    'First → Last';
  console.log(header);
  console.log('  ' + '-'.repeat(90));

  for (const c of clusters) {
    const company = (c.company || '').substring(0, 20).padEnd(22);
    const role = (c.role || '').substring(0, 32).padEnd(34);
    const reposts = String(c.repostCount).padEnd(9);
    const span = `${c.daysSpan}d`.padEnd(12);
    const range = `${c.firstSeen} → ${c.lastSeen}`;
    console.log('  ' + company + role + reposts + span + range);
  }
  console.log('');
}

function runSelfTest() {
  const baseRows = [
    { url: 'https://acme.com/jobs/sre-1', date: parseDate('2024-01-10'), dateStr: '2024-01-10', title: 'Senior Site Reliability Engineer', company: 'Acme', status: 'added', portal: 'greenhouse', location: '' },
    { url: 'https://acme.com/jobs/sre-2', date: parseDate('2024-03-01'), dateStr: '2024-03-01', title: 'Senior Site Reliability Engineer', company: 'Acme', status: 'added', portal: 'greenhouse', location: '' },
    { url: 'https://acme.com/jobs/eng-mgr', date: parseDate('2024-02-15'), dateStr: '2024-02-15', title: 'Engineering Manager Platform', company: 'Acme', status: 'added', portal: 'greenhouse', location: '' },
    { url: 'https://acme.com/jobs/sre-1', date: parseDate('2024-03-20'), dateStr: '2024-03-20', title: 'Senior Site Reliability Engineer', company: 'Acme', status: 'added', portal: 'greenhouse', location: '' },
    { url: 'https://acme.com/jobs/sre-3', date: parseDate('2024-12-01'), dateStr: '2024-12-01', title: 'Senior Site Reliability Engineer', company: 'Acme', status: 'added', portal: 'greenhouse', location: '' },
    { url: 'https://acme.com/jobs/sre-4', date: parseDate('2024-02-01'), dateStr: '2024-02-01', title: 'Senior Site Reliability Engineer', company: 'Acme', status: 'skipped_expired', portal: 'greenhouse', location: '' },
  ];

  const clusters = detectReposts(baseRows, DEFAULT_WINDOW_DAYS);

  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const repostClusters = clusters.filter(c =>
    c.company === 'Acme' &&
    /Site Reliability/.test(c.role) &&
    c.appearances.some(a => a.url === 'https://acme.com/jobs/sre-1') &&
    c.appearances.some(a => a.url === 'https://acme.com/jobs/sre-2')
  );
  check(repostClusters.length === 1, 'genuine repost (same role, different URL, within 90d) should be flagged');

  if (repostClusters.length === 1) {
    const urls = repostClusters[0].appearances.map(a => a.url);
    check(new Set(urls).size === urls.length, 'appearances should not duplicate the same URL within one cluster');
    check(repostClusters[0].repostCount === 2, 'repostCount should be 2 for the genuine cluster (sre-1, sre-2)');
  }

  const mgrClusters = clusters.filter(c => /Engineering Manager/.test(c.role));
  check(mgrClusters.length === 0, 'distinct role at the same company should NOT be flagged');

  const sre3Clusters = clusters.filter(c => c.appearances.some(a => a.url === 'https://acme.com/jobs/sre-3'));
  check(sre3Clusters.length === 0, 'same role + different URL but outside 90-day window should NOT be flagged');

  const expiredClusters = clusters.filter(c => c.appearances.some(a => a.url === 'https://acme.com/jobs/sre-4'));
  check(expiredClusters.length === 0, 'rows with skipped_expired status must be ignored');

  check(detectReposts([], DEFAULT_WINDOW_DAYS).length === 0, 'empty input should return no clusters');
  check(detectReposts(baseRows.filter(r => r.status !== 'added'), DEFAULT_WINDOW_DAYS).length === 0, 'only-skipped rows should return no clusters');

  const scanRow = (url, dateStr, title, company) =>
    ({ url, date: parseDate(dateStr), dateStr, title, company, status: 'added', portal: 'ashby-full', location: '' });

  const perCity = [
    scanRow('https://jobs.example.com/acme/a', '2026-01-10', 'Commercial Solutions Engineer - Munich', 'Acme'),
    scanRow('https://jobs.example.com/acme/b', '2026-01-10', 'Commercial Solutions Engineer - Berlin', 'Acme'),
    scanRow('https://jobs.example.com/acme/c', '2026-01-10', 'Commercial Solutions Engineer - EMEA', 'Acme'),
  ];
  check(detectReposts(perCity, DEFAULT_WINDOW_DAYS).length === 0, 'per-city variants seen in one sweep are not reposts');
  check(
    detectReposts(perCity, DEFAULT_WINDOW_DAYS, 0).length === 0,
    'per-city variants are rejected on title identity even with the span floor disabled',
  );

  const sameSweep = [
    scanRow('https://jobs.example.com/globex/r1', '2026-01-10', 'Regional Sales Engineer (Remote, CHE)', 'Globex'),
    scanRow('https://jobs.example.com/globex/r2', '2026-01-10', 'Regional Sales Engineer (Remote, CHE)', 'Globex'),
  ];
  check(detectReposts(sameSweep, DEFAULT_WINDOW_DAYS).length === 0, 'two concurrent requisitions in one sweep are not a repost');
  check(
    detectReposts(sameSweep, DEFAULT_WINDOW_DAYS, 0).length === 1,
    'the same-sweep fixture is rejected by the span floor specifically (it survives with the floor disabled)',
  );

  const perCountry = [
    scanRow('https://jobs.example.com/initech/1', '2026-01-10', 'Channel Account Manager', 'Initech'),
    scanRow('https://jobs.example.com/initech/2', '2026-01-10', 'Channel Account Manager - Spain', 'Initech'),
  ];
  check(detectReposts(perCountry, DEFAULT_WINDOW_DAYS).length === 0, 'two countries\' requisitions are not a repost');
  check(
    detectReposts(perCountry, DEFAULT_WINDOW_DAYS, 0).length === 0,
    'a trailing country word splits the titles even with the span floor disabled',
  );

  const genuine = [
    scanRow('https://jobs.example.com/umbrella/4066969101', '2026-01-08', 'Senior Customer Success Manager', 'Umbrella'),
    scanRow('https://jobs.example.com/umbrella/4948414101', '2026-02-11', 'Senior Customer Success Manager', 'Umbrella'),
  ];
  const genuineClusters = detectReposts(genuine, DEFAULT_WINDOW_DAYS);
  check(genuineClusters.length === 1, 'genuine repost across two scan dates is still flagged');
  check(genuineClusters[0]?.daysSpan === 34, 'genuine repost keeps its real 34-day span');

  check(
    detectReposts(genuine, DEFAULT_WINDOW_DAYS, MIN_REPOST_SPAN_DAYS, new Set(['umbrella'])).length === 0,
    'a company marked aggregator produces no clusters',
  );
  check(
    detectReposts(genuine, DEFAULT_WINDOW_DAYS, MIN_REPOST_SPAN_DAYS, new Set(['someoneelse'])).length === 1,
    'flagging a DIFFERENT company leaves this one detected (the skip is keyed, not global)',
  );
  check(
    detectReposts(genuine, DEFAULT_WINDOW_DAYS, MIN_REPOST_SPAN_DAYS, new Set()).length === 1,
    'an empty aggregator set changes nothing',
  );
  check(
    detectReposts(genuine, DEFAULT_WINDOW_DAYS, MIN_REPOST_SPAN_DAYS, null).length === 1,
    'a null aggregator set changes nothing (pre-#2703 behaviour)',
  );
  check(
    detectReposts(
      [
        scanRow('https://jobs.example.com/acme/1', '2026-01-08', 'Data Engineer', 'Acme Inc.'),
        scanRow('https://jobs.example.com/acme/2', '2026-02-11', 'Data Engineer', 'ACME, INC'),
      ],
      DEFAULT_WINDOW_DAYS,
      MIN_REPOST_SPAN_DAYS,
      new Set([normalizeCompanyName('Acme Inc.')]),
    ).length === 0,
    'the aggregator key is normalized the same way companyKey normalizes rows',
  );

  const reworded = [
    scanRow('https://jobs.example.com/hooli/a', '2026-01-28', 'Forward Deployed Engineer - Sweden', 'Hooli'),
    scanRow('https://jobs.example.com/hooli/b', '2026-02-11', 'Forward Deployed Engineer, Sweden', 'Hooli'),
  ];
  check(detectReposts(reworded, DEFAULT_WINDOW_DAYS).length === 1, 'punctuation-only retitling still counts as the same role');

  const mixedSpan = [
    ...genuine,
    scanRow('https://jobs.example.com/umbrella/4948414102', '2026-02-11', 'Senior Customer Success Manager', 'Umbrella'),
  ];
  const mixedClusters = detectReposts(mixedSpan, DEFAULT_WINDOW_DAYS);
  check(mixedClusters.length === 1 && mixedClusters[0].repostCount === 3, 'a same-day third sighting joins the real cluster rather than suppressing it');

  check(
    titleIdentityKey('Forward Deployed Engineer - Sweden') === titleIdentityKey('Forward Deployed Engineer, Sweden'),
    'titleIdentityKey ignores punctuation',
  );
  check(
    titleIdentityKey('Senior Backend Engineer Payments') === titleIdentityKey('Backend Engineer Payments Senior'),
    'titleIdentityKey ignores word order',
  );
  check(
    titleIdentityKey('Solutions Engineer - UK') !== titleIdentityKey('Solutions Engineer - US'),
    'titleIdentityKey keeps short country words that roleTokens would have dropped',
  );
  check(
    titleIdentityKey('Operations Manager') !== titleIdentityKey('Senior Operations Manager'),
    'titleIdentityKey keeps seniority words distinct',
  );
  {
    const fixtures = mkdtempSync(join(tmpdir(), 'co-aggr-'));
    try {
      const tmp = join(fixtures, 'portals.yml');
      writeFileSync(tmp, [
        'tracked_companies:',
        '  - name: Plain Co',
        '    provider: lever',
        '  - name: Board One',
        '    provider: lever',
        '    aggregator: true',
        '  - name: Board Two Inc.',
        '    aggregator: true',
        '  - name: Explicitly Not',
        '    aggregator: false',
        '  - name: Stringy',
        '    aggregator: "true"',
        'job_boards:',
        '  - name: Board Under Boards',
        '    aggregator: true',
        '',
      ].join('\n'), 'utf-8');
      const keys = loadAggregatorCompanies(tmp);
      check(keys.has(normalizeCompanyName('Board One')), 'aggregator: true is picked up');
      check(keys.has(normalizeCompanyName('Board Two Inc.')), 'a suffixed name is normalized into the companyKey space');
      check(keys.has(normalizeCompanyName('Board Under Boards')), 'a flagged entry under job_boards counts too');
      check(!keys.has(normalizeCompanyName('Plain Co')), 'an entry without the flag is not an aggregator');
      check(!keys.has(normalizeCompanyName('Explicitly Not')), 'aggregator: false is not an aggregator');
      check(!keys.has(normalizeCompanyName('Stringy')), 'a quoted "true" is not the boolean true');
      check(keys.size === 3, 'exactly the three flagged entries are returned');

      check(loadAggregatorCompanies(join(fixtures, 'does-not-exist.yml')).size === 0, 'a missing portals.yml yields no aggregators, no crash');

      const bad = join(fixtures, 'malformed.yml');
      writeFileSync(bad, 'tracked_companies: [unclosed\n', 'utf-8');
      check(loadAggregatorCompanies(bad).size === 0, 'a malformed portals.yml yields no aggregators, no crash');

      const unflagged = join(fixtures, 'unflagged.yml');
      writeFileSync(unflagged, 'job_boards:\n  - name: Somewhere\n', 'utf-8');
      check(loadAggregatorCompanies(unflagged).size === 0, 'a config whose entries carry no flag yields no aggregators');
    } finally {
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  check(titleIdentityKey('—') === '—', 'a title that folds to nothing falls back to its raw text rather than an empty key');
  check(
    titleIdentityKey('シニアエンジニア') !== titleIdentityKey('データアナリスト'),
    'non-Latin titles keep distinct keys instead of both folding to empty (#2429 reasoning)',
  );
  check(
    titleIdentityKey('Ingénieur Données') === titleIdentityKey('Ingenieur Donnees'),
    'titleIdentityKey folds accents, so a re-listing that drops them is still the same role',
  );

  console.log(`\n  detect-reposts self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (selfTestMode) {
    runSelfTest();
  }

  const rows = loadScanHistory();
  const aggregators = loadAggregatorCompanies();
  const clusters = detectReposts(rows, windowDays, minSpanDays, aggregators);

  if (summaryMode) {
    printSummary(clusters, aggregators.size);
  } else {
    console.log(JSON.stringify({
      metadata: {
        windowDays,
        minSpanDays,
        totalRows: rows.length,
        aggregatorCompanies: aggregators.size,
        clusters: clusters.length,
      },
      clusters,
    }, null, 2));
  }
}
