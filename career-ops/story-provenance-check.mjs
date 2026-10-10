#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { splitStoryBlocks, isValidStory, getField, STORY_FIELDS } from './lib/story-bank.mjs';

const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_STORY_BANK_PATH = join(DATA_ROOT, 'interview-prep', 'story-bank.md');
const DEFAULT_CV_PATH = join(DATA_ROOT, 'cv.md');

const CLAIM_PATTERNS = [
  {
    kind: 'percent',
    re: /\d+(?:\.\d+)?%/g,
    values: (m) => [parseFloat(m[0])],
  },
  {
    kind: 'plus-noun',
    re: /\b(\d+)\+\s+[a-zA-Z]+/g,
    values: (m) => [parseFloat(m[1])],
  },
  {
    kind: 'hour-range',
    re: /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:→|->|to)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi,
    values: (m) => [parseFloat(m[1]), parseFloat(m[2])],
  },
  {
    kind: 'scale-hyphen',
    re: /\b(\d+)-(?:person|member)\b/gi,
    values: (m) => [parseFloat(m[1])],
  },
  {
    kind: 'scale-noun',
    re: /\b(\d+)\s+(?:students?|employees?|people|staff|learners?|instructors?|departments?|cohorts?)\b/gi,
    values: (m) => [parseFloat(m[1])],
  },
];

const NUMBER_SCAN_RE = /\d+(?:\.\d+)?/g;

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto', 'over',
  'were', 'have', 'that', 'were', 'while', 'about', 'their', 'there',
  'which', 'through', 'across', 'within', 'without', 'after', 'before',
  'during', 'being', 'been', 'each', 'every', 'other', 'than', 'then',
  'them', 'they', 'when', 'where', 'what', 'more', 'most', 'some', 'such',
  'only', 'also', 'just', 'like', 'very', 'used', 'using',
]);

function provenanceIn(text) {
  const m = text.match(/^[ \t]*(?:[-*+>][ \t]+)?\*\*Provenance:\*\*[ \t]*(.+)$/im);
  return m ? m[1].trim().toLowerCase() : null;
}

function parseStoryBlocks(content) {
  const { blocks, tableRows, trailing } = splitStoryBlocks(content);

  const unitProvenance = blocks.map((b, i) => [b.raw, ...trailing.filter((t) => t.story === i).map((t) => t.text)]
    .map(provenanceIn).find((p) => p) ?? null);

  const stories = blocks.map((b, i) => {
    const cut = trailing.find((t) => t.story === i && getField(t.text, STORY_FIELDS.action));
    return {
      kind: 'story',
      title: b.title || `(untitled, line ${b.line})`,
      provenance: unitProvenance[i],
      body: b.raw,
      valid: isValidStory(b),
      line: b.line,
      ...(cut ? { actionAfterCut: cut.after } : {}),
    };
  });

  const cutOff = trailing.map((t) => ({
    kind: 'trailing',
    title: `(after ${t.after}, line ${t.line}) in "${stories[t.story].title}"`,
    provenance: unitProvenance[t.story],
    body: t.text,
    valid: false,
    line: t.line,
    after: t.after,
  }));

  const rows = tableRows.map((r) => ({
    kind: 'table-row',
    title: `(table row, line ${r.line}) ${r.label}`.trim(),
    provenance: r.story >= 0 && unitProvenance[r.story] === 'user-cannot-confirm' ? 'user-cannot-confirm' : null,
    body: r.text,
    valid: false,
    line: r.line,
  }));

  return [...stories, ...cutOff, ...rows];
}

function malformedEntries(entries) {
  const reason = (e) => {
    if (e.kind === 'table-row') return 'table row: not a ### block';
    if (e.kind === 'trailing') return `text after a ${e.after} inside a story: the readers stop at the ${e.after}`;
    if (e.actionAfterCut) return `its **A (Action):** line comes after a ${e.actionAfterCut}, where the readers stop`;
    return 'no **A (Action):** line';
  };
  return entries.filter((e) => !e.valid).map((e) => ({ title: e.title, kind: e.kind, line: e.line, reason: reason(e) }));
}

function extractClaims(body) {
  const claims = [];
  for (const { kind, re, values } of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      claims.push({ kind, text: m[0], index: m.index, values: values(m) });
    }
  }
  claims.sort((a, b) => a.index - b.index);
  return claims;
}

function extractNumbers(text) {
  const out = new Set();
  let m;
  const re = new RegExp(NUMBER_SCAN_RE);
  while ((m = re.exec(text)) !== null) out.add(parseFloat(m[0]));
  return out;
}

function buildCvNumberContexts(cvText) {
  const map = new Map();
  const re = new RegExp(NUMBER_SCAN_RE);
  let m;
  while ((m = re.exec(cvText)) !== null) {
    const value = parseFloat(m[0]);
    const words = contextWords(cvText, m.index, m[0].length);
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(words);
  }
  return map;
}

function foldForContext(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u0307/gu, '');
}

function contextWords(body, matchIndex, matchLength, windowChars = 90) {
  const start = Math.max(0, matchIndex - windowChars);
  const end = Math.min(body.length, matchIndex + matchLength + windowChars);
  const snippet = foldForContext(body.slice(start, end))
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  const words = snippet.split(/\s+/).filter(Boolean);
  return [...new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\p{N}+$/u.test(w)))];
}

function hasContextOverlap(words, cvText) {
  const haystack = foldForContext(cvText);
  const bounded = (w) => new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}])`,
    'u',
  );
  return words.some((w) => bounded(w).test(haystack));
}

function hasScopedNumberMatch(claimWords, cvContextLists) {
  return cvContextLists.some((cvWords) => cvWords.some((w) => claimWords.includes(w)));
}

const USER_STATED_RE = /^user-stated\s+\d{4}-\d{2}-\d{2}$/;

function classifyStoryBank(storyBankText, cvText) {
  const cvNumberContexts = buildCvNumberContexts(cvText);
  const stories = parseStoryBlocks(storyBankText);

  const buckets = { existing: [], supportedByResume: [], derivedUnverified: [], userCannotConfirm: [] };

  for (const story of stories) {
    const claims = extractClaims(story.body);
    for (const claim of claims) {
      const entry = { story: story.title, claim: claim.text, pattern: claim.kind };

      if (story.provenance === 'user-cannot-confirm') {
        buckets.userCannotConfirm.push({
          ...entry,
          reason: 'explicit Provenance marker (user-cannot-confirm) — durable, never reclassified',
        });
        continue;
      }

      if (story.provenance && (USER_STATED_RE.test(story.provenance) || story.provenance === 'source: cv.md')) {
        buckets.existing.push({
          ...entry,
          reason: `confirmed via Provenance marker (${story.provenance})`,
        });
        continue;
      }

      const claimWords = contextWords(story.body, claim.index, claim.text.length);

      const matchesCv = claim.values.every((v) => {
        const cvContextLists = cvNumberContexts.get(v);
        return cvContextLists ? hasScopedNumberMatch(claimWords, cvContextLists) : false;
      });
      if (matchesCv) {
        buckets.existing.push(entry);
        continue;
      }

      if (hasContextOverlap(claimWords, cvText)) {
        buckets.supportedByResume.push({ ...entry, contextWords: claimWords });
        continue;
      }

      buckets.derivedUnverified.push(entry);
    }
  }

  return buckets;
}

function diagnose(storyBankExists, cvExists, storyCount, claimCount, storyBankPath = DEFAULT_STORY_BANK_PATH, cvPath = DEFAULT_CV_PATH) {
  if (!storyBankExists) {
    return { reason: 'no-story-bank', message: `${storyBankPath} not found — nothing was checked.` };
  }
  if (!cvExists) {
    return { reason: 'no-cv', message: `${cvPath} not found — claims cannot be checked against a primary source.` };
  }
  if (storyCount === 0) {
    return { reason: 'no-stories-parsed', message: 'story-bank.md exists but no `### ` story blocks were parsed from it.' };
  }
  if (claimCount === 0) {
    return {
      reason: 'no-numeric-claims-found',
      message: 'Stories were parsed but no numeric claims matched the covered patterns. This is not the same as "no risk" — see the pattern-coverage note in this script\'s header for what is not scanned.',
    };
  }
  return null;
}

export { parseStoryBlocks, malformedEntries, extractClaims, extractNumbers, classifyStoryBank, diagnose };

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const storyBankPath = flagValue(args, '--story-bank') || DEFAULT_STORY_BANK_PATH;
const cvPath = flagValue(args, '--cv') || DEFAULT_CV_PATH;

function runSelfTest() {
  let passed = 0, failed = 0;
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
      passed++;
    } else {
      failed++;
      console.log(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
    }
  };

  const fakeCv = `
# Experience

## Instructional Designer — Acme University (2022-2025)
- Reduced onboarding ramp time from 8 hours to 2 hours per cohort by automating manual configuration steps.
- Led a cross-functional team through a full LMS migration with zero data loss.

# Filler

Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

# Summary

Brings 15 years of unrelated professional background in adult education prior to instructional design work.
`;

  const fakeStoryBank = `
### [Automation] Onboarding Workflow
**Situation:** New hires spent too long configuring onboarding tools manually.
**Task:** Cut ramp time without losing quality.
**Action:** Built an automated workflow using a custom LMS integration.
**Result:** Ramp time dropped from 8 hours to 2 hours per cohort.
**Best for questions about:** automation, process improvement

### [Leadership] LMS Migration Team
**Situation:** The LMS migration needed dedicated team leadership.
**Task:** Keep the migration on schedule with no data loss.
**Action:** Led a 15-person team through the full migration.
**Result:** Migration completed on time with zero data loss.
**Best for questions about:** leadership, project management

### [Scale] Statewide Rollout
**Situation:** Leadership wanted a large-scale training rollout.
**Task:** Reach as many staff as possible within one quarter.
**Action:** Built self-paced modules and distributed them broadly.
**Result:** 500+ employees completed the rollout within the quarter.
**Best for questions about:** scale, training design

### [Budget] Vendor Negotiation
**Provenance:** user-cannot-confirm
**Situation:** The training budget needed renegotiation with a vendor.
**Task:** Cut licensing costs without losing seats.
**Action:** Renegotiated the vendor contract.
**Result:** Estimated 40% savings on licensing costs, though the original invoice could not be located to confirm the exact figure.
**Best for questions about:** negotiation, cost savings
`;

  const result = classifyStoryBank(fakeStoryBank, fakeCv);
  eq(
    'hour-range claim matching cv.md verbatim numbers is existing',
    result.existing.some((c) => c.story === 'Onboarding Workflow' && c.pattern === 'hour-range'),
    true
  );

  eq(
    'scale-hyphen claim not in cv.md, but cv.md prose supports the fact, is supportedByResume',
    result.supportedByResume.some((c) => c.story === 'LMS Migration Team' && c.pattern === 'scale-hyphen'),
    true
  );

  eq(
    'a claim number matching cv.md only via an unrelated coincidental occurrence is NOT existing',
    result.existing.some((c) => c.story === 'LMS Migration Team' && c.pattern === 'scale-hyphen'),
    false
  );

  eq(
    'plus-noun claim with no cv.md trace is derived-unverified',
    result.derivedUnverified.some((c) => c.story === 'Statewide Rollout' && c.pattern === 'plus-noun'),
    true
  );

  eq(
    'percent claim under an explicit user-cannot-confirm marker is user-cannot-confirm, not derived-unverified',
    result.userCannotConfirm.some((c) => c.story === 'Vendor Negotiation' && c.pattern === 'percent'),
    true
  );
  eq(
    'the user-cannot-confirm claim does NOT also land in derivedUnverified',
    result.derivedUnverified.some((c) => c.story === 'Vendor Negotiation'),
    false
  );

  const rerun1 = classifyStoryBank(fakeStoryBank, fakeCv);
  const rerun2 = classifyStoryBank(fakeStoryBank, fakeCv);
  eq('repeated classification of the same story-bank is byte-identical (idempotent)', rerun1, rerun2);
  eq(
    'user-cannot-confirm entry is stable across repeated runs, not just present once',
    rerun2.userCannotConfirm.some((c) => c.story === 'Vendor Negotiation'),
    true
  );

  const userStatedBank = `
### [Scale] Conference Talk
**Provenance:** user-stated 2026-01-15
**Situation:** Was asked to present at a regional conference.
**Task:** Design a session for a large mixed audience.
**Action:** Delivered a workshop attended by roughly 300 students.
**Result:** Session feedback scores were among the highest of the day.
**Best for questions about:** public speaking
`;
  const userStatedResult = classifyStoryBank(userStatedBank, fakeCv);
  eq(
    'a user-stated marker promotes an otherwise-unverified claim to existing',
    userStatedResult.existing.some((c) => c.story === 'Conference Talk' && c.pattern === 'scale-noun'),
    true
  );

  const userStatedOverlapBank = `
### [Scale] Certification Program
**Provenance:** user-stated 2026-02-01
**Situation:** New hires needed a scalable certification path.
**Task:** Build a training program covering core software skills.
**Action:** Delivered training to 275 employees across each cohort rotation.
**Result:** All participants passed the certification assessment.
**Best for questions about:** training delivery, certification design
`;
  const userStatedOverlapResult = classifyStoryBank(userStatedOverlapBank, fakeCv);
  eq(
    'user-stated marker + overlapping cv.md context still classifies as existing, not supportedByResume',
    userStatedOverlapResult.existing.some((c) => c.story === 'Certification Program' && c.pattern === 'scale-noun'),
    true
  );
  eq(
    'user-stated marker claim does NOT land in supportedByResume despite the context overlap',
    userStatedOverlapResult.supportedByResume.some((c) => c.story === 'Certification Program'),
    false
  );

  const noMarkerOverlapBank = userStatedOverlapBank.replace(/\*\*Provenance:\*\* user-stated 2026-02-01\n/, '');
  const noMarkerOverlapResult = classifyStoryBank(noMarkerOverlapBank, fakeCv);
  eq(
    'control: the same story body WITHOUT a provenance marker lands in supportedByResume — proves the heuristic would fire absent the marker',
    noMarkerOverlapResult.supportedByResume.some((c) => c.story === 'Certification Program'),
    true
  );

  const sourceCvOverlapBank = `
### [Scale] Certification Program
**Provenance:** source: cv.md
**Situation:** New hires needed a scalable certification path.
**Task:** Build a training program covering core software skills.
**Action:** Delivered training to 275 employees across each cohort rotation.
**Result:** All participants passed the certification assessment.
**Best for questions about:** training delivery, certification design
`;
  const sourceCvOverlapResult = classifyStoryBank(sourceCvOverlapBank, fakeCv);
  eq(
    'literal "source: cv.md" marker + overlapping cv.md context still classifies as existing, not supportedByResume',
    sourceCvOverlapResult.existing.some((c) => c.story === 'Certification Program' && c.pattern === 'scale-noun'),
    true
  );
  eq(
    '"source: cv.md" marker claim does NOT land in supportedByResume despite the context overlap',
    sourceCvOverlapResult.supportedByResume.some((c) => c.story === 'Certification Program'),
    false
  );

  const noMarkerOverlapBank2 = sourceCvOverlapBank.replace(/\*\*Provenance:\*\* source: cv\.md\n/, '');
  const noMarkerOverlapResult2 = classifyStoryBank(noMarkerOverlapBank2, fakeCv);
  eq(
    'control: the same story body WITHOUT the "source: cv.md" marker lands in supportedByResume — proves the heuristic would fire absent the marker',
    noMarkerOverlapResult2.supportedByResume.some((c) => c.story === 'Certification Program'),
    true
  );

  eq('missing story-bank.md is diagnosed as no-story-bank', diagnose(false, true, 0, 0).reason, 'no-story-bank');
  eq('missing cv.md is diagnosed as no-cv', diagnose(true, false, 0, 0).reason, 'no-cv');
  eq('zero parsed stories is diagnosed as no-stories-parsed', diagnose(true, true, 0, 0).reason, 'no-stories-parsed');
  eq('stories parsed but zero claims is diagnosed as no-numeric-claims-found', diagnose(true, true, 3, 0).reason, 'no-numeric-claims-found');
  eq('a conclusive run (claims found) is not diagnosed', diagnose(true, true, 3, 2), null);

  const blocks = parseStoryBlocks(fakeStoryBank);
  eq('parses all four story blocks', blocks.length, 4);
  eq('strips the [Theme] prefix from the title', blocks[0].title, 'Onboarding Workflow');
  eq('provenance is null when the field is absent', blocks[0].provenance, null);
  eq('provenance is parsed and lowercased when present', blocks[3].provenance, 'user-cannot-confirm');

  console.log(`\nstory-provenance-check self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  if (selfTestMode) {
    runSelfTest();
  } else {
    const storyBankExists = existsSync(storyBankPath);
    const cvExists = existsSync(cvPath);
    const storyBankText = storyBankExists ? readFileSync(storyBankPath, 'utf-8') : '';
    const cvText = cvExists ? readFileSync(cvPath, 'utf-8') : '';

    const result = classifyStoryBank(storyBankText, cvText);
    const entries = storyBankExists ? parseStoryBlocks(storyBankText) : [];
    const storyCount = entries.filter((e) => e.kind === 'story').length;
    const malformed = malformedEntries(entries);
    const claimCount = result.existing.length + result.supportedByResume.length
      + result.derivedUnverified.length + result.userCannotConfirm.length;
    const diagnosis = diagnose(storyBankExists, cvExists, storyCount, claimCount, storyBankPath, cvPath);

    if (summaryMode) {
      console.log(`\nStory Provenance Check`);
      console.log('─'.repeat(40));
      console.log(`Story bank: ${storyBankPath}${storyBankExists ? '' : ' (not found)'}`);
      console.log(`CV:         ${cvPath}${cvExists ? '' : ' (not found)'}`);
      console.log(`Claims checked: ${claimCount}\n`);

      const printBucket = (label, emoji, items) => {
        console.log(`  ${emoji} ${label} (${items.length})`);
        for (const item of items) {
          console.log(`     - [${item.story}] "${item.claim}" (${item.pattern})${item.reason ? ` — ${item.reason}` : ''}`);
        }
      };
      printBucket('existing (traces to cv.md or an explicit marker)', '✅', result.existing);
      printBucket('supportedByResume (cv.md supports the fact, not this precision)', '📝', result.supportedByResume);
      printBucket('derived-unverified (only in story-bank.md, unconfirmed)', '⚠️', result.derivedUnverified);
      printBucket('user-cannot-confirm (explicitly marked, durable)', '🔒', result.userCannotConfirm);

      if (malformed.length) {
        console.log('');
        console.log(`  🧩 malformed — invisible to npm run star / negotiation-roi (${malformed.length})`);
        for (const m of malformed) console.log(`     - ${m.title} — ${m.reason}`);
        console.log('     Convert to the format in templates/story-bank.template.md.');
      }

      if (diagnosis) {
        console.log('');
        console.log('  🚨 LOW CONFIDENCE: this is not a clean result.');
        console.log(`     ${diagnosis.message}`);
        console.log(`     (reason: ${diagnosis.reason})`);
      }
    } else {
      console.log(JSON.stringify({ ...result, malformed, lowConfidence: diagnosis }, null, 2));
    }
  }
}
