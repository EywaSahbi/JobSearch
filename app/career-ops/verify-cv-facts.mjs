#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, basename } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_SOURCES = [join(DATA_ROOT, 'cv.md'), join(DATA_ROOT, 'article-digest.md')];
const DEFAULT_CONFIG = join(DATA_ROOT, 'config', 'cv-facts.json');
const TOOL_PROSE_WORDS = new Set([
  'a', 'an', 'and', 'at', 'built', 'by', 'containerized', 'deployment',
  'deployments', 'delivery', 'diagnosing', 'efficiency', 'feedback', 'for', 'from', 'improve',
  'improving', 'in', 'of', 'on', 'on-time', 'operations', 'production', 'project',
  'recurring', 'resolving', 'submission', 'team', 'the', 'to', 'using', 'with',
]);
const DETERMINER_LEAD_RE = /^(?:the|that|this|these|those|our|your|their|its|his|her|my)(?:\s+|$)/i;
const DECLARED_TOOL_TRIGGER_RE = /^(?:technologies?|tech stack)\s*:/i;
const TOOL_PHRASE_PATTERN = /^(?=.{1,80}$)[\p{L}\p{N}.][\p{L}\p{N}+#./-]*(?:\s+[\p{L}\p{N}.][\p{L}\p{N}+#./-]*){0,2}$/u;
const DELEGATED_PARTY_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b/i;
const DELEGATION_RE = /\b(?:commissioned|coordinated|directed|engaged|hired|managed|oversaw|partnered with|supervised)\b/i;
const DIRECT_AUTHORSHIP_SIGNAL_RE = /\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const THIRD_PARTY_EXECUTION_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b[^.;!?]{0,120}\b(?:which|who|that)\b[^.;!?]{0,120}\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const DIRECT_AUTHORSHIP_CLAIM_RE = /\b(authored|built|coded|developed|engineered|implemented|programmed|wrote)\b\s+(?:the\s+|an?\s+|my\s+|our\s+)?([^.;!?]{1,160})/giu;
const ATTRIBUTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'authored', 'build', 'built', 'by', 'coded',
  'commissioned', 'coordinated', 'created', 'developed', 'directed', 'engineered',
  'engaged', 'for', 'from', 'hired', 'implemented', 'in', 'managed', 'my', 'of',
  'on', 'our', 'oversaw', 'partnered', 'programmed', 'supervised', 'the', 'through',
  'to', 'vendor', 'vendors', 'with', 'wrote',
]);
const METRIC_NOUNS = [
  'users', 'customers', 'clients', 'employees', 'engineers', 'teams', 'companies',
  'partners', 'organizations', 'organisations', 'brands', 'countries',
  'hours', 'days', 'weeks', 'months', 'years', 'minutes', 'seconds',
  'requests', 'tokens', 'documents', 'workflows', 'pipelines', 'agents',
  'interviews', 'applications', 'offers', 'reports', 'cvs', 'resumes',
  'enrollments', 'enrolments', 'completions', 'courses', 'certifications',
  'certificates', 'sessions', 'responses', 'surveys', 'cohorts',
  'commits', 'contributions', 'repositories', 'repos', 'modules', 'tools',
  'servers', 'guides', 'articles', 'datasets', 'examples', 'deployments',
  'services', 'downloads', 'stars', 'lines', 'projects', 'integrations', 'tests',
  'staff', 'personnel', 'people', 'technicians', 'operators', 'contractors',
  'vendors', 'scientists', 'researchers', 'volunteers', 'students', 'patients',
  'crew',
  'facilities', 'sites', 'buildings', 'rooms', 'labs', 'laboratories', 'plants',
  'machines', 'devices', 'instruments', 'vehicles', 'units', 'locations',
  'acres', 'hectares', 'shifts', 'rounds', 'inspections', 'audits', 'incidents',
  'alarms', 'tickets',
  'candidates', 'trainees', 'learners', 'participants', 'attendees',
  'graduates', 'alumni', 'teachers', 'instructors', 'educators', 'faculty',
  'schools', 'districts', 'campuses', 'classrooms', 'programs', 'programmes',
  'workshops', 'assessments', 'exams',
];
const MODIFIER_WINDOW = 4;
const SPELLED_MAGNITUDES = new Map([
  ['thousand', 'k'],
  ['million', 'm'],
  ['billion', 'b'],
]);
const SPELLED_MAGNITUDE_ALT = [...SPELLED_MAGNITUDES.keys()].join('|');

const COUNT_CLAIM_RE = new RegExp(
  String.raw`(?<![A-Za-z]-)\b(\d[\d,.]*(?:[kKmMbB]\b|\s+(?:${SPELLED_MAGNITUDE_ALT})\b)?)\s*\+?\s*(?:[A-Za-z][A-Za-z-]*\s+){0,${MODIFIER_WINDOW}}?(${METRIC_NOUNS.join('|')})\b`,
  'gi'
);
const NOUN_SYNONYMS = new Map([
  ['repos', 'repositories'],
  ['enrolments', 'enrollments'],
  ['organisations', 'organizations'],
  ['cvs', 'resumes'],
  ['certificates', 'certifications'],
  ['articles', 'guides'],
  ['personnel', 'staff'],
  ['labs', 'laboratories'],
]);
const SIMPLE_CLAIM_PATTERNS = [
  /\b\d+(?:\.\d+)?\s?%/g,
  /(?<![\w$€£])[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB])?/g,
  /\b\d+(?:\.\d+)?\s?x\b/gi,
];

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

const DIGIT_ZEROS = [
  0x0660,
  0x06f0,
  0x0966,
  0x09e6,
  0x0a66,
  0x0ae6,
  0x0b66,
  0x0be6,
  0x0c66,
  0x0ce6,
  0x0d66,
  0x0e50,
  0x0ed0,
  0x0f20,
  0x1040,
  0x17e0,
  0x1810,
];

export function foldDigits(text) {
  let out = text.normalize('NFKC');
  out = out.replace(/\p{Nd}/gu, (char) => {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0x30 && cp <= 0x39) return char;
    for (const zero of DIGIT_ZEROS) {
      const value = cp - zero;
      if (value >= 0 && value <= 9) return String(value);
    }
    return char;
  });
  out = out
    .replace(/\u066a/g, '%')
    .replace(/\u066b/g, '.')
    .replace(/\u066c/g, ',');
  return out.replace(/(?<!\d)(\d{1,3})[\s\u00a0\u202f](?=\d{3}(?!\d))/g, '$1');
}

export function stripMarkup(text, { keepLineBreaks = false } = {}) {
  return foldDigits(String(text))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<\/?(?:li|p|div|tr|h[1-6]|section|article|ul|ol|table|br)\b[^>\n]*>/gi, '. ')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, ' $1 ')
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, ' $1 ')
    .replace(/__(\S(?:[\s\S]*?\S)?)__/g, ' $1 ')
    .replace(/\*(\S(?:[^\n*]*\S)?)\*/g, ' $1 ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(keepLineBreaks ? /[^\S\n]+/g : /\s+/g, ' ')
    .replace(/ *\n+ */g, keepLineBreaks ? '\n' : ' ')
    .trim();
}

export function normalizeClaim(claim) {
  return String(claim)
    .toLowerCase()
    .replace(/(\d)[,.\s\u00a0\u202f](?=\d{3}(?!\d))/g, '$1')
    .replace(/[,\s]+/g, ' ')
    .trim();
}

function normalizeFact(value) {
  return normalizeClaim(value).replace(/[.;:,]+$/g, '').trim();
}

function looksToolShaped(rawValue) {
  const trimmed = String(rawValue).trim();
  if (!trimmed) return false;
  if (/\d/.test(trimmed)) return true;
  return trimmed.split(/\s+/).every(word => /^[\p{Lu}]/u.test(word));
}

function isLikelyTool(value, sourceNormalized) {
  const normalized = normalizeFact(value);
  const words = normalized.split(' ');
  if (!normalized || words.length > 3) return false;
  if (!TOOL_PHRASE_PATTERN.test(value.trim())) return false;
  if (looksToolShaped(value)) return true;
  if (sourceNormalized != null && sourceContainsFact(sourceNormalized, normalized)) return true;
  if (sourceNormalized != null && words.every(word => sourceContainsFact(sourceNormalized, word))) return false;
  return !words.some(word => TOOL_PROSE_WORDS.has(word));
}

export function factClaims(text, sourceNormalized = null) {
  const clean = stripMarkup(text);
  const claims = [];
  const patterns = [
    ['employer', /\b(?:[Ww]orked [Aa]t|[Jj]oined|[Ee]mployer\s*:\s*|[Cc]ompany\s*:\s*)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g],
    ['title', /\b(?:[Ss]erved [Aa]s|[Ww]orked [Aa]s|[Tt]itle\s*:\s*|[Rr]ole\s*:\s*)\s*(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})|\b(?:[Ww]orked [Aa]t|[Jj]oined)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}\s+[Aa]s\s+(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})/g],
    ['tool', /\b(?:using|built with|worked with|technologies?\s*:\s*|tech stack\s*:\s*)([^.;\n]+?)(?=\s+\bfor\b|[.;\n]|$)/gi],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const rawText = kind === 'tool' ? match[1].trim() : '';
      const declaredList = kind === 'tool' && DECLARED_TOOL_TRIGGER_RE.test(match[0]);
      const rawValues = kind === 'tool'
        ? ((!declaredList && DETERMINER_LEAD_RE.test(rawText))
          ? []
          : rawText.split(/,|\band\b|\bwith\b|\bin\b/i).filter(raw => !DETERMINER_LEAD_RE.test(raw.trim())))
        : [match[1] || match[2]];
      for (const raw of rawValues) {
        const value = normalizeFact(raw);
        if (value && (kind !== 'tool' || isLikelyTool(raw, sourceNormalized))) claims.push({ kind, value });
      }
    }
  }
  return claims;
}

function factStatements(text) {
  const withLineBoundaries = String(text ?? '').replace(/\r?\n+/g, '. ');
  return stripMarkup(withLineBoundaries)
    .split(/(?:[.!?]\s+|[.!?]$)/u)
    .map(statement => statement.trim())
    .filter(Boolean);
}

function attributionTokens(text) {
  return normalizeFact(text)
    .split(/[^\p{L}\p{N}+#./-]+/u)
    .filter(token => token.length >= 3 && !ATTRIBUTION_STOP_WORDS.has(token));
}

export function delegatedAuthorshipClaims(targetText, sourceText) {
  const sourceStatements = factStatements(sourceText);
  const directSources = sourceStatements
    .filter(statement => DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement))
    .filter(statement => !THIRD_PARTY_EXECUTION_RE.test(statement))
    .map(statement => new Set(attributionTokens(statement)));
  const delegatedSources = sourceStatements
    .filter(statement => DELEGATED_PARTY_RE.test(statement) && DELEGATION_RE.test(statement))
    .filter(statement => (
      !DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement) || THIRD_PARTY_EXECUTION_RE.test(statement)
    ))
    .map(statement => ({
      statement,
      tokens: new Set(attributionTokens(statement)),
    }));
  if (!delegatedSources.length) return [];

  const claims = [];
  for (const statement of factStatements(targetText)) {
    if (DELEGATED_PARTY_RE.test(statement)) continue;
    DIRECT_AUTHORSHIP_CLAIM_RE.lastIndex = 0;
    for (const match of statement.matchAll(DIRECT_AUTHORSHIP_CLAIM_RE)) {
      const value = normalizeFact(`${match[1]} ${match[2]}`);
      const tokens = [...new Set(attributionTokens(match[2]))];
      if (tokens.length < 2) continue;
      if (directSources.some(source => tokens.filter(token => source.has(token)).length >= 2)) {
        continue;
      }
      const delegatedSource = delegatedSources.find(source => (
        tokens.filter(token => source.tokens.has(token)).length >= 2
      ));
      if (delegatedSource) {
        claims.push({ kind: 'authorship', value });
      }
    }
  }
  return claims.filter((claim, index, all) => (
    all.findIndex(other => other.value === claim.value) === index
  ));
}

const TIME_NOUNS = new Set(['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds']);
const HORIZON_LEAD_RE = /\b(?:the|my|our|your)?\s*(?:first|next)\s+$/i;
const FORWARD_MARKER_RE = /\b(?:would|will|shall|should)\b|['\u2019]d\b(?!\s+[A-Za-z]+ed\b)|['\u2019]ll\b|\b(?:plan|plans|planning|intend|intends)\s+to\b|\bgoing to\b|\blooking forward\b/i;

const REQUIREMENT_CITATION_RE = /\b(?:role|posting|position|job)\b[^.,;:!?\n]{0,30}\b(?:calls?\s+for|requires?|asks?\s+for|wants?)\b/gi;
const NEGATION_LEAD_RE = /\b(?:without(?:\s+the)?|lack(?:ing)?(?:\s+the)?|don['\u2019]?t\s+have(?:\s+the)?|doesn['\u2019]?t\s+have(?:\s+the)?|do\s+not\s+have(?:\s+the)?)\s*$/i;

function clauseBounds(text, index) {
  const isBoundary = (i) => {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== '.' && c !== '!' && c !== '?' && c !== ',' && c !== ';' && c !== ':') return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  const isSentenceEnd = (i) => {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== '.' && c !== '!' && c !== '?') return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  let start = 0;
  for (let i = index - 1; i >= 0; i--) if (isBoundary(i)) { start = i + 1; break; }
  let end = text.length;
  for (let i = index; i < text.length; i++) if (isBoundary(i)) { end = i; break; }
  if (/^\s*(?:and|or|then|plus)\b/i.test(text.slice(start, end))) {
    let sentenceStart = 0;
    for (let i = start - 1; i >= 0; i--) if (isSentenceEnd(i)) { sentenceStart = i + 1; break; }
    return { start: sentenceStart, end };
  }
  return { start, end };
}

function clauseAround(text, index) {
  const { start, end } = clauseBounds(text, index);
  return text.slice(start, end);
}

function isDisclosedRequirement(clean, match, allMatches) {
  const lead = clean.slice(Math.max(0, match.index - 40), match.index);
  if (NEGATION_LEAD_RE.test(lead)) return true;

  const { start, end } = clauseBounds(clean, match.index);
  const clause = clean.slice(start, end);
  REQUIREMENT_CITATION_RE.lastIndex = 0;
  const citations = [...clause.matchAll(REQUIREMENT_CITATION_RE)];
  if (!citations.length) return false;

  const numbersInClause = allMatches.filter((m) => m.index >= start && m.index < end);
  if (!numbersInClause.length) return false;

  return citations.some((citation) => {
    const citationStart = start + citation.index;
    const citationEnd = start + citation.index + citation[0].length;
    const preceding = numbersInClause.filter((m) => m.index < citationStart).at(-1);
    const precedingEnd = preceding ? preceding.index + preceding[0].length : citationStart;
    const precedingGap = clean.slice(precedingEnd, citationStart);
    const precedesCitation = preceding && (
      /^\s*(?:this|that|the)?\s*$/i.test(precedingGap)
      || (
        /\b(?:this|that)\s*$/i.test(precedingGap)
        && !/[,;:]|\b(?:and|but)\b/i.test(precedingGap)
      )
    );
    const following = numbersInClause.find((m) => m.index >= citationEnd);
    const cited = precedesCitation ? preceding : (following ?? preceding);
    return cited?.index === match.index;
  });
}

function countMatches(clean) {
  COUNT_CLAIM_RE.lastIndex = 0;
  const allMatches = [...clean.matchAll(COUNT_CLAIM_RE)];
  return allMatches.filter((match) => {
    if (isDisclosedRequirement(clean, match, allMatches)) return false;
    if (!TIME_NOUNS.has(match[2].toLowerCase())) return true;
    const lead = clean.slice(Math.max(0, match.index - 40), match.index);
    if (!HORIZON_LEAD_RE.test(lead)) return true;
    return !FORWARD_MARKER_RE.test(clauseAround(clean, match.index));
  });
}

const SCOPE_VERB_TIERS = new Map([
  ['contribute', 1], ['contributed', 1], ['contributes', 1], ['contributing', 1],
  ['help', 1], ['helped', 1], ['helps', 1], ['helping', 1],
  ['support', 1], ['supported', 1], ['supports', 1], ['supporting', 1],
  ['build', 2], ['built', 2], ['builds', 2], ['building', 2],
  ['implement', 2], ['implemented', 2], ['implements', 2], ['implementing', 2],
  ['design', 2], ['designed', 2], ['designs', 2], ['designing', 2],
  ['lead', 3], ['led', 3], ['leads', 3], ['leading', 3],
  ['own', 3], ['owned', 3], ['owns', 3], ['owning', 3],
  ['architect', 3], ['architected', 3], ['architects', 3], ['architecting', 3],
  ['drive', 3], ['drove', 3], ['drives', 3], ['driving', 3],
]);

const LIST_MARKER_RE = /^[\s•‣◦⁃∙*+-]+/u;

function stripListMarker(statement) {
  return String(statement ?? '').replace(LIST_MARKER_RE, '').trim();
}

function openingScopeVerb(statement) {
  const text = stripListMarker(statement);
  const opening = text.match(/^([\p{L}]+)/u);
  if (!opening) return null;
  const verb = opening[1].toLowerCase();
  const tier = SCOPE_VERB_TIERS.get(verb);
  if (!tier) return null;
  if (/^(?:lead|leads|leading|led)\s+to\b/i.test(text)) return null;
  if (opensWithJobTitle(text)) return null;
  return { verb, tier };
}

const TITLE_BARE_FORM_RE = /^(?:lead|architect)$/iu;
const TITLE_PREPOSITIONS = new Set(['for', 'on', 'of', 'at', 'in', 'with']);
const TITLE_DETERMINERS = new Set([
  'the', 'a', 'an', 'our', 'my', 'their', 'its', 'his', 'her', 'this', 'that',
  'these', 'those', 'all', 'every', 'each', 'both', 'two', 'three', 'four', 'five',
]);
const TITLE_ROLE_NOUNS = new Set([
  'engineer', 'developer', 'designer', 'architect', 'manager', 'scientist',
  'analyst', 'consultant', 'programmer', 'researcher', 'administrator',
  'specialist', 'strategist', 'technologist', 'tester', 'writer',
]);
const TITLE_LOOKAHEAD_WORDS = 3;

function opensWithJobTitle(text) {
  const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 2 || !TITLE_BARE_FORM_RE.test(words[0])) return false;
  if (TITLE_PREPOSITIONS.has(words[1])) return true;
  for (const word of words.slice(1, 1 + TITLE_LOOKAHEAD_WORDS)) {
    if (TITLE_DETERMINERS.has(word) || /^\p{N}/u.test(word)) return false;
    if (TITLE_ROLE_NOUNS.has(word)) return true;
  }
  return false;
}

const SCOPE_PHRASE_TIERS = [
  [/^worked\s+on\b/iu, 1],
  [/^part\s+of\s+the\s+team\b/iu, 1],
];

const HEADING_RE = /^#{1,6}\s+/u;
const SUBJECT_PRONOUN_RE = /^(?:i|we)\s+/iu;

const SCOPE_CLAUSE_SPLIT_RE = /\s*[,;:]\s*|\s+(?:and|then|plus|while|before|after)\s+/iu;

function scopeClauses(statement) {
  return String(statement ?? '')
    .split(SCOPE_CLAUSE_SPLIT_RE)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function sourceClauseTier(clause, heading) {
  const text = stripListMarker(clause).replace(HEADING_RE, '');
  if (heading) {
    let tier = 0;
    for (const match of text.matchAll(/[\p{L}]+/gu)) {
      tier = Math.max(tier, SCOPE_VERB_TIERS.get(match[0].toLowerCase()) ?? 0);
    }
    return tier;
  }
  const opening = text.replace(SUBJECT_PRONOUN_RE, '');
  for (const [pattern, tier] of SCOPE_PHRASE_TIERS) {
    if (pattern.test(opening)) return tier;
  }
  return openingScopeVerb(opening)?.tier ?? Infinity;
}

function scopeObjectTokens(text) {
  return attributionTokens(text).filter(token => !SCOPE_VERB_TIERS.has(token));
}

export function scopeInflationClaims(targetText, sourceText) {
  const sourceClauses = factStatements(sourceText)
    .map(stripListMarker)
    .flatMap((statement) => {
      const heading = HEADING_RE.test(statement);
      return scopeClauses(statement).map(clause => ({
        statement,
        heading,
        tier: sourceClauseTier(clause, heading),
        tokens: new Set(scopeObjectTokens(clause)),
      }));
    })
    .filter(source => source.tokens.size);
  if (!sourceClauses.length) return [];

  const claims = [];
  for (const raw of factStatements(targetText)) {
    const statement = stripListMarker(raw);
    for (const clause of scopeClauses(statement)) {
      const opening = openingScopeVerb(clause);
      if (!opening || opening.tier < 2) continue;
      const tokens = [...new Set(scopeObjectTokens(clause))];
      if (!tokens.length) continue;

      const required = Math.min(2, tokens.length);
      const overlaps = sourceClauses.map(source => ({
        source,
        overlap: tokens.filter(token => source.tokens.has(token)).length,
      }));

      const linked = overlaps.filter(({ overlap, source }) => overlap >= required && !source.heading);
      if (!linked.length) continue;
      const vouched = overlaps.some(({ overlap, source }) => overlap > 0 && source.tier >= opening.tier);
      if (vouched) continue;

      const closest = linked.reduce((best, next) => (next.overlap > best.overlap ? next : best));
      claims.push({
        kind: 'scope',
        value: normalizeFact(clause),
        line: statement,
        sourceLine: closest.source.statement,
      });
    }
  }
  return claims.filter((claim, index, all) => (
    all.findIndex(other => other.value === claim.value) === index
  ));
}

const ADOPTION_CHECKS = [
  {
    target: /\bused\s+daily\b/giu,
    source: /\bdaily\b/iu,
  },
  {
    target: /\bacross\s+the\s+(?:[\p{L}-]+\s+){0,2}org(?:ani[sz]ations?)?\b/giu,
    source: /\bacross\s+the\b[^.;!?]{0,40}\b(?:org|organi[sz]ations?|company|business)\b|\b(?:company|org(?:ani[sz]ation)?)[-\s]?wide\b/iu,
  },
  {
    target: /\b(?:company|org(?:ani[sz]ation)?)[-\s]?wide\b/giu,
    source: /\b(?:company|org(?:ani[sz]ation)?)[-\s]?wide\b|\bacross\s+the\s+(?:whole\s+|entire\s+)?(?:company|org(?:ani[sz]ation)?)\b/iu,
  },
  {
    target: /\badopted\s+by\b/giu,
    source: /\badopt(?:ed|s|ing|ion)?\b/iu,
  },
  {
    target: /\bstandard\s+across\b/giu,
    source: /\bstandards?\b|\bstandardi[sz](?:e|es|ed|ing|ation)\b/iu,
  },
];

export function adoptionClaims(targetText, sourceText) {
  const source = stripMarkup(sourceText);
  const statements = factStatements(targetText).map(stripListMarker);
  const claims = [];
  for (const { target, source: evidence } of ADOPTION_CHECKS) {
    if (evidence.test(source)) continue;
    for (const statement of statements) {
      target.lastIndex = 0;
      for (const match of statement.matchAll(target)) {
        claims.push({
          kind: 'adoption',
          value: normalizeFact(match[0]),
          line: statement,
          sourceLine: null,
        });
      }
    }
  }
  return claims.filter((claim, index, all) => (
    all.findIndex(other => other.value === claim.value) === index
  ));
}

function compactMagnitude(raw) {
  return raw.replace(/\s+([A-Za-z]+)$/, (whole, word) => {
    const suffix = SPELLED_MAGNITUDES.get(word.toLowerCase());
    return suffix === undefined ? whole : suffix;
  });
}

export function metricClaims(text) {
  const clean = stripMarkup(text, { keepLineBreaks: true });
  const claims = new Set();
  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    for (const match of clean.matchAll(pattern)) claims.add(normalizeClaim(match[0]));
  }
  for (const match of countMatches(clean)) {
    const noun = match[2].toLowerCase();
    claims.add(normalizeClaim(`${compactMagnitude(match[1])} ${NOUN_SYNONYMS.get(noun) ?? noun}`));
  }
  return claims;
}

const GENERIC_COUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(\d[\d,.]*)\s*\+?\s*(?:[\p{L}][\p{L}\p{M}-]*[\s]+){0,${MODIFIER_WINDOW}}([\p{L}][\p{L}\p{M}]{2,})`,
  'giu',
);
const YEAR_LIKE = /^(?:19|20)\d{2}$/;

function countShapedSpans(text) {
  const clean = stripMarkup(String(text ?? ''));

  const covered = [];
  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    for (const m of clean.matchAll(pattern)) covered.push([m.index, m.index + m[0].length]);
  }
  const alreadyChecked = (i) => covered.some(([from, to]) => i >= from && i < to);

  const out = [];
  for (const m of clean.matchAll(GENERIC_COUNT_RE)) {
    if (YEAR_LIKE.test(m[1].replace(/[,.]/g, ''))) continue;
    if (alreadyChecked(m.index) || alreadyChecked(m.index + m[0].indexOf(m[1]))) continue;
    out.push(m[0].trim());
  }
  return out;
}

export function diagnoseCoverage(targetText) {
  const spans = countShapedSpans(targetText);
  if (spans.length < 2) return null;
  COUNT_CLAIM_RE.lastIndex = 0;
  const recognized = [...stripMarkup(String(targetText ?? '')).matchAll(COUNT_CLAIM_RE)];
  if (recognized.length > 0) return null;
  return {
    reason: 'no-count-claims-recognized',
    message:
      `${spans.length} count-like claims are present but none matched the metric extractor, whose noun ` +
      'list is English-only — so no count in this document was checked against your sources. ' +
      'Percentages, currency and multipliers were still checked. Verify the counts by hand, or add ' +
      'them to allow_metrics in config/cv-facts.json once confirmed.',
    spans,
  };
}

function allowedMetricSet(sourceText, allowMetrics) {
  const allowed = new Set(metricClaims(sourceText));
  for (const entry of allowMetrics || []) {
    allowed.add(normalizeClaim(entry));
    for (const canonical of metricClaims(String(entry))) allowed.add(canonical);
  }
  return allowed;
}

export function auditClaims(targetText, sourceText, config = {}) {
  const allowed = allowedMetricSet(sourceText, config.allow_metrics);
  const invented = [...metricClaims(targetText)].filter(claim => !allowed.has(claim));
  const targetPlain = stripMarkup(targetText).toLowerCase();
  const forbidden = (config.forbidden_phrases || [])
    .filter(Boolean)
    .filter(phrase => targetPlain.includes(String(phrase).toLowerCase()));
  return { invented, forbidden };
}

export function loadFactConfig(path) {
  const keys = ['allow_metrics', 'allow_facts', 'forbidden_phrases', 'warn_phrases'];
  if (!existsSync(path)) return { missing: true, config: Object.fromEntries(keys.map(key => [key, []])) };
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  for (const key of keys) {
    if (config[key] == null) config[key] = [];
    else if (!Array.isArray(config[key])) throw new Error(`${key} must be an array in ${path}`);
  }
  return { missing: false, config };
}

const ENGLISH_FUNCTION_WORDS = new Set([
  'the', 'and', 'of', 'to', 'for', 'with', 'from', 'by', 'at', 'on', 'is', 'was',
  'were', 'are', 'that', 'this', 'which', 'into', 'over', 'our', 'my', 'their',
  'its', 'has', 'have', 'had', 'been', 'it', 'or', 'not', 'also',
]);
const OTHER_FUNCTION_WORDS = new Set([
  'el', 'la', 'los', 'las', 'del', 'y', 'en', 'para', 'con', 'por', 'una', 'que', 'se', 'al', 'su', 'sus', 'como', 'es', 'de',
  'le', 'les', 'des', 'du', 'et', 'pour', 'avec', 'par', 'une', 'dans', 'sur', 'au', 'aux', 'est', 'qui',
  'der', 'die', 'das', 'den', 'dem', 'und', 'für', 'mit', 'von', 'zu', 'ein', 'eine', 'auf', 'bei', 'im', 'ist', 'sich', 'nicht',
  'os', 'da', 'dos', 'em', 'com', 'um', 'na', 'ao', 'não',
  'il', 'gli', 'di', 'nel', 'della', 'che', 'è',
  've', 'bir', 'ile', 'için', 'bu', 'olarak', 'daha',
]);

function looksEnglish(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  const nonLatin = text.match(/(?!\p{Script=Latin})\p{L}/gu) ?? [];
  if (letters.length && nonLatin.length / letters.length > 0.3) return false;
  let english = 0;
  let other = 0;
  for (const [word] of text.matchAll(/[\p{L}]+/gu)) {
    if (word.length > 1 && word === word.toUpperCase()) continue;
    const lower = word.toLowerCase();
    if (ENGLISH_FUNCTION_WORDS.has(lower)) english++;
    else if (OTHER_FUNCTION_WORDS.has(lower)) other++;
  }
  return !(other >= 2 && other > english);
}

function scopeLanguageGap(targetText, sourceText) {
  const targetEnglish = looksEnglish(stripMarkup(targetText));
  const sourceEnglish = looksEnglish(stripMarkup(sourceText));
  if (targetEnglish && sourceEnglish) return null;
  const subject = !targetEnglish && !sourceEnglish
    ? 'The document and its sources are'
    : !targetEnglish ? 'The document is' : 'Its sources are';
  return `${subject} not in English, so the scope-verb and adoption checks did not run: their word lists ` +
    'are English-only. Check ownership verbs and adoption claims by hand.';
}

function resolveInputPath(path, cwd = process.cwd()) {
  return isAbsolute(path) ? path : join(cwd, path);
}

function sourceContainsFact(sourceText, value) {
  const escaped = value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#/-])${escaped}(?=$|[^\\p{L}\\p{N}+#/-])`, 'iu').test(sourceText);
}

export function verifyFacts(targetText, {
  sourcePaths = DEFAULT_SOURCES,
  configPath = DEFAULT_CONFIG,
  cwd = process.cwd(),
} = {}) {
  const sourceText = sourcePaths.map(path => readIfExists(resolveInputPath(path, cwd))).join('\n');
  const { missing: configMissing, config } = loadFactConfig(resolveInputPath(configPath, cwd));
  const allowed = allowedMetricSet(sourceText, config.allow_metrics);
  const targetClaims = metricClaims(targetText);
  const invented = [...targetClaims].filter(claim => !allowed.has(claim));
  const sourceNormalized = normalizeFact(stripMarkup(sourceText));
  const allowedFacts = new Set(config.allow_facts.map(normalizeFact));
  const namedFacts = [...factClaims(targetText, sourceNormalized), ...delegatedAuthorshipClaims(targetText, sourceText)]
    .filter(({ value }) => !sourceContainsFact(sourceNormalized, value) && !allowedFacts.has(value));
  const languageGap = scopeLanguageGap(targetText, sourceText);
  const comparedFacts = (languageGap ? [] : scopeInflationClaims(targetText, sourceText))
    .filter(({ value }) => !allowedFacts.has(value));
  const advisoryFacts = (languageGap ? [] : adoptionClaims(targetText, sourceText))
    .filter(({ value }) => !allowedFacts.has(value));
  const unsupportedFacts = [...namedFacts, ...comparedFacts]
    .filter((claim, index, claims) => claims.findIndex(other => other.kind === claim.kind && other.value === claim.value) === index);
  const forbidden = config.forbidden_phrases
      .filter(Boolean)
      .filter(phrase => stripMarkup(targetText).toLowerCase().includes(String(phrase).toLowerCase()));
  const warnings = config.warn_phrases
      .filter(Boolean)
      .filter(phrase => stripMarkup(targetText).toLowerCase().includes(String(phrase).toLowerCase()));
  const countGap = diagnoseCoverage(targetText);
  const coverage = !languageGap ? countGap
    : countGap ? { ...countGap, message: `${countGap.message} ${languageGap}` }
      : { reason: 'scope-not-checked', message: languageGap, spans: [] };
  const blocked = invented.length || unsupportedFacts.length || forbidden.length;
  return {
    verdict: blocked ? 'block' : (warnings.length || advisoryFacts.length || coverage) ? 'warn' : 'pass',
    invented,
    unsupportedFacts,
    advisoryFacts,
    forbidden,
    warnings,
    coverage,
    configMissing,
  };
}

export function scopeClaimAdvice({ value }) {
  return `the source gives this work a weaker verb than the CV. If the CV is right, add "${value}" to allow_facts in config/cv-facts.json`;
}

export function assertFacts(targetText, options = {}) {
  const result = verifyFacts(targetText, options);
  if (result.verdict === 'block') {
    const details = [];
    if (result.invented.length) details.push(`metric-like claims absent from sources: ${result.invented.join(', ')}`);
    if (result.unsupportedFacts.length) details.push(`non-metric facts absent from sources: ${result.unsupportedFacts.map((claim) => {
      const { kind, value, sourceLine } = claim;
      if (kind === 'scope') return `${kind}=${value} (source says: ${sourceLine}; ${scopeClaimAdvice(claim)})`;
      return sourceLine ? `${kind}=${value} (source says: ${sourceLine})` : `${kind}=${value}`;
    }).join(', ')}`);
    if (result.forbidden.length) details.push(`forbidden phrases found: ${result.forbidden.join(', ')}`);
    throw new Error(`Fact check failed${options.label ? ` for ${options.label}` : ''}: ${details.join('; ')}`);
  }
  return result;
}

function parseCliArgs(args) {
  const sourcePaths = [];
  let targetArg = '';
  let configPath = DEFAULT_CONFIG;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source' || arg === '--config') {
      if (!args[i + 1]) throw new Error(`${arg} requires a path`);
      if (arg === '--source') sourcePaths.push(args[++i]);
      else configPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!targetArg) {
      targetArg = arg;
    } else {
      throw new Error(`unexpected extra positional argument: ${arg}`);
    }
  }
  return { targetArg, sourcePaths, configPath, json, help: false };
}

function usage() {
  return `Usage: node verify-cv-facts.mjs <generated-document> [--source path] [--config path] [--json]
       node verify-cv-facts.mjs --self-test

Checks generated candidate-facing text for unsupported metrics and explicitly asserted
non-metric facts (employers, titles, tools, delegated-work authorship, scope-verb
inflation, and unsourced adoption claims) absent from source files.
Default sources: cv.md, article-digest.md
Default config:  config/cv-facts.json (optional)`;
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;
  const equal = (label, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      return;
    }
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  };
  const source = [
    'Reached 16,181 active users and 289,760 enrollments across 80 courses.',
    'Cut infrastructure cost 60%. Managed a $550K budget.',
    'Certified partners earned 2x more. Authored 80+ open-access technical guides.',
  ].join(' ');

  equal('truthful modifier restatement', auditClaims('Reached 16,181 users', source).invented, []);
  equal('inflated modifier count', auditClaims('Reached 94,772 active users', source).invented, ['94772 users']);
  equal('new training noun', auditClaims('Drove 900,000 enrollments', source).invented, ['900000 enrollments']);
  equal('truthful currency', auditClaims('Managed a $550K budget', source).invented, []);
  equal('inflated currency', auditClaims('Managed a $900K budget', source).invented, ['$900k']);
  equal('truthful multiplier', auditClaims('Partners earned 2x more', source).invented, []);
  equal('noun synonym', auditClaims('Authored 80 articles', source).invented, []);
  equal('ordinary year is ignored', auditClaims('Joined the team in 2013', source).invented, []);

  const claimsOf = (text) => [...metricClaims(text)].sort().join(' | ');
  equal('nearest noun wins over a farther one', claimsOf('15+ years scaling teams and platforms'), '15 years');
  equal('nearest noun wins across three modifiers', claimsOf('20+ years leading engineering organizations'), '20 years');
  equal('the plain phrasing of the same fact agrees', claimsOf('I have 15+ years of experience.'), '15 years');
  equal('a verbatim experience line is not invented',
    auditClaims('15+ years scaling teams and platforms', '15+ years of experience.').invented, []);
  equal('a 3-modifier single-noun phrase still resolves', claimsOf('~5 live Cloud Run deployments'), '5 deployments');
  equal('and its 2-modifier paraphrase agrees', claimsOf('~5 Cloud Run deployments'), '5 deployments');
  equal('two counts in one sentence stay distinct', claimsOf('8 years supporting 40 engineers'), '40 engineers | 8 years');

  equal('a proposed plan horizon is not a claim',
    claimsOf("I'd welcome the chance to talk through how I'd approach the first 90 days."), '');
  equal('the same closing in the fuller phrasing',
    claimsOf('I would welcome a conversation about the first 90 days.'), '');
  equal('an end-to-end audit stops reporting it',
    auditClaims("I'd approach the first 90 days by listening.", 'No numbers here.').invented, []);
  equal('a past-tense window behind the same lead is still a claim',
    claimsOf('Revenue grew in the first 12 months.'), '12 months');
  equal('a forward-looking sentence keeps a claim with no horizon lead',
    claimsOf('I would bring 20 years of experience.'), '20 years');
  equal('an ordinary time metric is untouched',
    claimsOf('Cut deployment time to 2 days.'), '2 days');
  equal('a marker in a neighbouring sentence does not reach',
    claimsOf('I would be glad to help. Revenue grew in the first 12 months.'), '12 months');
  equal('a non-time noun behind the same construction is unaffected',
    claimsOf("I'd start with the first 3 teams."), '3 teams');
  equal('a bare modal is a forward marker too',
    claimsOf('My first 90 days would centre on the pipeline.'), '');
  equal('a reader-facing plan question is one as well',
    claimsOf('How would you approach the first 90 days?'), '');
  equal('and a proposal framed with should',
    claimsOf('Glad to talk through how the first 90 days should go.'), '');
  equal('an ability modal is not a forward marker',
    claimsOf('Revenue could be traced to the first 12 months.'), '12 months');
  equal('a marker in a later clause does not suppress',
    claimsOf('Revenue grew in the first 99 months, and I would be glad to repeat it.'), '99 months');
  equal('a soft-wrapped line does not join two clauses',
    claimsOf('I would be glad to help\nRevenue grew in the first 99 months'), '99 months');
  equal('a past-perfect contraction is not a forward marker',
    claimsOf("I'd completed the migration in the first 12 months."), '12 months');
  equal("but 'd before a base verb still is", claimsOf("I'd approach the first 90 days."), '');
  equal('a decimal horizon is still a plan', claimsOf('My first 1.5 years would focus on the pipeline.'), '');
  const verdictOf = (t) => {
    const r = verifyFacts(t, { sourcePaths: [], configPath: '/nonexistent' });
    return `${r.verdict}${r.coverage ? ' +' + r.coverage.reason : ''}`;
  };
  equal('two plan horizons do not trigger a coverage warning',
    verdictOf("I'd approach the first 90 days by listening, and the first 30 days by shipping."), 'pass');
  equal(
    'allow_metrics override',
    auditClaims('Reached 94,772 users', source, { allow_metrics: ['94,772 users'] }).invented,
    []
  );
  equal('a synonym-spelled exception is honoured',
    auditClaims('Maintained 77 repositories', source, { allow_metrics: ['77 repos'] }).invented, []);
  equal('the canonical spelling still works',
    auditClaims('Maintained 77 repositories', source, { allow_metrics: ['77 repositories'] }).invented, []);
  equal('a currency exception survives the folding',
    auditClaims('Managed a $900K budget', source, { allow_metrics: ['$900K'] }).invented, []);
  equal('an unrelated exception still leaves the claim invented',
    auditClaims('Maintained 77 repositories', source, { allow_metrics: ['12 repos'] }).invented, ['77 repositories']);
  equal(
    'forbidden phrase',
    auditClaims('A proven track record', source, { forbidden_phrases: ['proven track record'] }).forbidden,
    ['proven track record']
  );

  const opsSource = [
    'Managed 20 staff across shift coverage: 8 scientists and 12 support personnel.',
    'Built out four facilities and ran a research program across 45 hectares.',
    'Held temperature setpoints across 3 production rooms.',
  ].join(' ');

  equal('truthful headcount', auditClaims('Managed 20 staff', opsSource).invented, []);
  equal('inflated headcount is caught', auditClaims('Managed 45 staff', opsSource).invented, ['45 staff']);
  equal('inflated specialist count is caught',
    auditClaims('Led 30 scientists', opsSource).invented, ['30 scientists']);
  equal('headcount paraphrase is not a fabrication',
    auditClaims('Managed 20 personnel', opsSource).invented, []);
  equal('inflated site count is caught',
    auditClaims('Built out 12 facilities', opsSource).invented, ['12 facilities']);
  equal('truthful area', auditClaims('Ran a program across 45 hectares', opsSource).invented, []);
  equal('inflated area is caught',
    auditClaims('Ran a program across 450 hectares', opsSource).invented, ['450 hectares']);
  equal('truthful room count', auditClaims('Setpoints across 3 rooms', opsSource).invented, []);
  equal('inflated room count is caught',
    auditClaims('Setpoints across 30 rooms', opsSource).invented, ['30 rooms']);

  const foldSource = 'Reached 16,181 active users across 80 courses. Cut cost 60%.';
  equal('fabricated full-width metric is caught', auditClaims('Reached ９４，７７２ users', foldSource).invented, ['94772 users']);
  equal('fabricated Arabic-Indic metric is caught', auditClaims('Reached ٩٤٧٧٢ users', foldSource).invented, ['94772 users']);
  equal('fabricated Devanagari metric is caught', auditClaims('Reached ९४७७२ users', foldSource).invented, ['94772 users']);
  equal('fabricated Arabic percentage is caught', auditClaims('Cut cost ٩٩٪', foldSource).invented, ['99%']);
  equal('truthful Arabic-Indic metric passes', auditClaims('Reached ١٦١٨١ users', foldSource).invented, []);
  equal('truthful full-width metric passes', auditClaims('Reached １６，１８１ users', foldSource).invented, []);

  equal('space-grouped thousands compare equal', auditClaims('Reached 16 181 users', foldSource).invented, []);
  equal('ungrouped compares equal to a grouped source', auditClaims('Reached 16181 users', foldSource).invented, []);
  equal('a fabricated space-grouped number is still caught', auditClaims('Reached 94 772 users', foldSource).invented, ['94772 users']);
  equal('a multi-group number folds completely', auditClaims('Reached 1 234 567 users', 'Reached 1234567 active users.').invented, []);
  equal('an eight-digit multi-group number folds too', auditClaims('Reached 12 345 678 users', 'Reached 12345678 active users.').invented, []);
  equal('a period-grouped CV matches a comma-grouped source',
    auditClaims('Reached 16.181 users', foldSource).invented, []);
  equal('a comma-grouped CV matches a period-grouped source',
    auditClaims('Reached 16,181 users', 'Reached 16.181 active users.').invented, []);
  equal('a fabricated period-grouped number is still caught',
    auditClaims('Reached 94.772 users', foldSource).invented, ['94772 users']);
  equal('a decimal is not read as grouping',
    auditClaims('Cut build time to 2.5 hours', 'Cut build time to 2.5 hours.').invented, []);
  equal('an ordinary decimal survives normalization',
    normalizeClaim('2.5 hours'), '2.5 hours');
  equal('a year is not glued to the next number', auditClaims('Joined in 2026 100 users', foldSource).invented, ['100 users']);

  const kinds = (text) => factClaims(text).map((f) => `${f.kind}:${f.value}`);
  equal('a capitalised CV bullet yields employer + title',
    kinds('- Worked at Initech as a Principal Engineer'),
    ['employer:initech', 'title:principal engineer']);
  equal('the lowercase phrasing still works',
    kinds('he worked at Initech as a Principal Engineer'),
    ['employer:initech', 'title:principal engineer']);
  equal('Joined, capitalised', kinds('Joined Globex in 2024'), ['employer:globex']);
  equal('Employer: label, capitalised', kinds('Employer: Initech'), ['employer:initech']);
  equal('a connector keeps the title whole', kinds('Served as Head of Data'), ['title:head of data']);
  equal('an inflated title is a different claim', kinds('Served as Head of Engineering'), ['title:head of engineering']);
  equal('a longer title survives too', kinds('Served as Vice President of Sales'), ['title:vice president of sales']);
  equal('the connector works on the worked-at branch too',
    kinds('Worked at Initech as Head of Data'),
    ['employer:initech', 'title:head of data']);
  equal('ordinary prose is not a claim', kinds('Worked at the office as a manager'), []);
  equal('ordinary prose, lowercase', kinds('joined the team as a contractor'), []);

  equal('a title does not chain across a list-item boundary',
    kinds('<ul><li>Worked at Initech as a Principal Engineer</li><li>Built pipelines</li></ul>'),
    ['employer:initech', 'title:principal engineer']);
  const modifierSource = 'Consolidated 25+ services down to ~5 live Cloud Run deployments.';
  equal(
    'same number, fewer modifiers in the CV',
    auditClaims('25+ services consolidated to ~5 Cloud Run deployments', modifierSource).invented,
    []
  );
  equal(
    'same number, more modifiers in the CV',
    auditClaims('Consolidated to ~5 live production Cloud Run deployments', modifierSource).invented,
    []
  );
  equal(
    'changed number behind three modifiers is caught',
    auditClaims('Consolidated to ~9 live Cloud Run deployments', modifierSource).invented,
    ['9 deployments']
  );
  equal(
    'changed number with the plain phrasing is still caught',
    auditClaims('Consolidated to ~9 Cloud Run deployments', modifierSource).invented,
    ['9 deployments']
  );
  const numericBarrierSource = 'Ran 7 tests. Logged 40 hours.';
  equal(
    'a figure still blocks the chain',
    auditClaims('Ran 7 tests over 40 hours', numericBarrierSource).invented,
    []
  );
  equal(
    'no cross-number binding invents evidence',
    auditClaims('Shipped 3 integrations', 'Shipped 3 features across 12 integrations').invented,
    ['3 integrations']
  );

  equal(
    'an inflated magnitude suffix is caught',
    auditClaims('Grew the product to 50k users', 'Reached 50 users.').invented,
    ['50k users']
  );
  equal(
    'a magnitude claim the source supports still passes',
    auditClaims('Grew to 50k users', 'Reached 50k users.').invented,
    []
  );
  equal(
    'a lowercase m suffix is caught too',
    auditClaims('Drove 1.5M downloads', 'Drove 50 downloads.').invented,
    ['1.5m downloads']
  );
  equal(
    'an uppercase B suffix is caught too',
    auditClaims('Reached 2B users', 'Reached 1B users.').invented,
    ['2b users']
  );
  equal(
    'a spelled-out magnitude joins the number',
    [...metricClaims('Reached 50 million users')],
    ['50m users']
  );
  equal(
    'the two spellings of one quantity compare equal',
    auditClaims('Reached 50M users', 'Reached 50 million users.').invented,
    []
  );
  equal(
    'a spelled-out inflation is caught',
    auditClaims('Reached 50 million users', 'Reached 50 users.').invented,
    ['50m users']
  );
  equal(
    'a decimal spelled-out magnitude joins the number',
    [...metricClaims('Served 1.5 million customers')],
    ['1.5m customers']
  );
  equal(
    'a thousand spelled-out magnitude joins the number',
    [...metricClaims('Served 50 thousand users')],
    ['50k users']
  );
  equal(
    'an ordinary modifier is still not a magnitude',
    [...metricClaims('Served 50 active users')],
    ['50 users']
  );
  equal(
    'a word merely starting with a magnitude word is not one',
    [...metricClaims('Served 50 millionaire users')],
    ['50 users']
  );
  equal(
    'a unit beginning with a suffix letter is unaffected',
    [...metricClaims('Shipped 50kg servers')],
    ['50 servers']
  );

  const scopeOf = (target, source) => scopeInflationClaims(target, source).map(claim => claim.value);
  const scopeSource = 'Contributed to the migration to a service architecture. Implemented the ingest pipeline.';

  equal('an upgraded scope verb is caught',
    scopeOf('Led the migration to a service architecture', scopeSource),
    ['led the migration to a service architecture']);
  equal('the bare phrasing of the same escalation is caught',
    scopeOf('Led the migration', 'Contributed to the migration'), ['led the migration']);
  equal('tier 3 over tier 2 is caught',
    scopeOf('Architected the ingest pipeline', scopeSource), ['architected the ingest pipeline']);
  equal('the closest source line is reported',
    scopeInflationClaims('Led the migration to a service architecture', scopeSource)
      .map(claim => claim.sourceLine),
    ['Contributed to the migration to a service architecture']);

  equal('an equal verb is not an escalation',
    scopeOf('Implemented the ingest pipeline', scopeSource), []);
  equal('a stronger source is not an escalation',
    scopeOf('Implemented the ingest pipeline', 'Architected the ingest pipeline.'), []);
  equal('a bullet with no matching source entry is left alone',
    scopeOf('Led the quarterly hiring committee', scopeSource), []);
  equal('a source stating the mandate in another sentence is respected',
    scopeOf('Led the payments rewrite',
      'Contributed to the payments rewrite. I led that payments effort end to end.'), []);
  equal('a source with no scope verb is not evidence of inflation',
    scopeOf('Built the billing migration', 'The billing migration shipped in March.'), []);
  equal('worked on is participation evidence',
    scopeOf('Built the billing migration', 'Worked on the billing migration.'),
    ['built the billing migration']);
  equal('and the issue\'s own pairing of it',
    scopeOf('Led the migration', 'Worked on the migration.'), ['led the migration']);
  equal('worked at is not scope evidence',
    scopeOf('Led the migration', 'Worked at Acme Labs on the migration.'), []);

  const compound = 'Contributed to the billing migration and led the payments rewrite.';
  equal('a compound source does not lend its strong verb to the weak half',
    scopeOf('Led the billing migration.', compound), ['led the billing migration']);
  equal('and the half that really is tier 3 still passes',
    scopeOf('Led the payments rewrite.', compound), []);
  equal('a compound TARGET bullet is checked clause by clause',
    scopeOf('Contributed to the billing migration and led the payments rewrite.',
      'Contributed to the payments rewrite.'),
    ['led the payments rewrite']);
  equal('a bullet opening with a modifier is still checked',
    scopeOf('As tech lead, drove the migration.', 'Contributed to the migration.'),
    ['drove the migration']);
  equal('the quoted CV line is the whole bullet, not the clause',
    scopeInflationClaims('As tech lead, drove the migration.', 'Contributed to the migration.')
      .map(claim => claim.line),
    ['As tech lead, drove the migration']);
  equal('led to is a result, not an ownership claim',
    scopeOf('Refactored the pipeline and led to a faster speedup.', 'Contributed to the speedup.'),
    []);
  equal('a leading job title is not an ownership claim',
    scopeOf('Lead backend engineer for the billing migration.', 'Contributed to the billing migration.'),
    []);
  equal('a title followed straight by a preposition is not an ownership claim',
    scopeOf('Architect for the payments platform.', 'Contributed to the payments platform.'),
    []);
  equal('present-tense "Lead the ..." is still an ownership claim',
    scopeOf('Lead the billing migration.', 'Contributed to the billing migration.'),
    ['lead the billing migration']);
  equal('a plural object after "Lead" is still the verb',
    scopeOf('Lead engineers through the billing migration.', 'Contributed to the billing migration.'),
    ['lead engineers through the billing migration']);

  equal('a noun homograph does not set the clause tier',
    scopeOf('Led the Google Drive integration.', 'Built the Google Drive integration.'),
    ['led the google drive integration']);

  equal('a single shared token does not link unrelated entries',
    scopeOf('Designed the onboarding automation.', 'Supported the onboarding revamp for new hires.'),
    []);
  equal('a repeated word is still one shared token',
    scopeOf('Owned the payments platform migration to payments v2.', 'Contributed to payments.'),
    []);
  equal('two distinct shared tokens still link',
    scopeOf('Owned the payments platform migration to payments v2.',
      'Contributed to the payments platform.'),
    ['owned the payments platform migration to payments v2']);
  equal('a participation verb is never flagged',
    scopeOf('Supported the billing migration', 'Worked on the billing migration.'), []);
  equal('a bulleted CV yields the same claim as a plain sentence',
    scopeOf('- Led the migration', '- Contributed to the migration'), ['led the migration']);
  equal('a bulleted source is still matched',
    scopeInflationClaims('* Led the migration', '• Contributed to the migration')
      .map(claim => claim.sourceLine),
    ['Contributed to the migration']);

  const adoptionOf = (target, source) => adoptionClaims(target, source).map(claim => claim.value).sort();

  equal('an unsourced adoption claim is caught',
    adoptionOf('Internal tooling used daily across the engineering org', scopeSource),
    ['across the engineering org', 'used daily']);
  equal('company-wide reach with no source is caught',
    adoptionOf('Rolled the linter out company-wide', scopeSource), ['company-wide']);
  equal('a sourced adoption claim passes',
    adoptionOf('Used daily by the team', 'The tool is used daily by the platform team.'), []);
  equal('a differently worded source adoption claim still supports it',
    adoptionOf('Used daily across the engineering org',
      'Used daily by six teams across the wider org.'), []);
  equal('organization-wide is caught',
    adoptionOf('Rolled the linter out organization-wide.', scopeSource), ['organization-wide']);
  equal('organisation-wide is caught too',
    adoptionOf('Rolled the linter out organisation-wide.', scopeSource), ['organisation-wide']);
  equal('a source that states adoption in its own words supports the claim',
    adoptionOf('Adopted by 3 teams.', 'Three teams adopted the tool.'), []);
  equal('and a reach claim the source words as a phrase, not a compound',
    adoptionOf('Rolled out company-wide.', 'The tool went out across the whole company.'), []);
  equal('a standardised source evidences a standard-across claim',
    adoptionOf('Became standard across the platform teams.',
      'Standardised the linter across every team.'), []);
  equal('and the plural noun does too',
    adoptionOf('Became standard across the platform teams.',
      'Set coding standards for every team.'), []);
  equal('but a source that claims no standard at all is still caught',
    adoptionOf('Became standard across the platform teams.', 'Implemented a linter.'),
    ['standard across']);
  equal('a phrase spanning two statements is not a claim',
    adoptionOf('...we used\nDaily standups ran on it.', 'nothing relevant here'), []);
  equal('every adoption claim carries the line it came from',
    adoptionClaims('Built internal tooling, used daily across the engineering org.', scopeSource)
      .every(claim => typeof claim.line === 'string' && claim.line.length > 0),
    true);

  console.log(`verify-cv-facts self-test: ${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

export function printAdvisoryFacts(facts = [], print = console.warn) {
  for (const { kind, value, line } of facts) {
    print(`  - unsourced ${kind} claim: ${value}`);
    if (line && line !== value) print(`      CV: ${line}`);
  }
}

export function runCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') return runSelfTest();
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return 1;
  }
  if (parsed.help || !parsed.targetArg) {
    console.log(usage());
    return parsed.help ? 0 : 1;
  }
  const targetPath = resolveInputPath(parsed.targetArg);
  if (!existsSync(targetPath)) {
    console.error(`ERROR: target file not found: ${parsed.targetArg}`);
    return 1;
  }
  try {
    const result = verifyFacts(readFileSync(targetPath, 'utf-8'), {
      sourcePaths: parsed.sourcePaths.length ? parsed.sourcePaths : DEFAULT_SOURCES,
      configPath: parsed.configPath,
    });
    if (result.configMissing) {
      console.error(`⚠️  fact-gate config not found: ${parsed.configPath} — forbidden/advisory phrase checks did not run.`);
    }
    if (parsed.json) {
      console.log(JSON.stringify(result));
      return result.verdict === 'block' ? 1 : 0;
    }
    if (result.verdict === 'pass') {
      console.log(`CV fact check passed: ${basename(targetPath)}`);
      return 0;
    }
    if (result.verdict === 'warn') {
      console.error(`CV fact check warning: ${basename(targetPath)}`);
      for (const phrase of result.warnings) console.error(`  - advisory phrase: ${phrase}`);
      printAdvisoryFacts(result.advisoryFacts, console.error);
      if (result.coverage) {
        console.error(`  - not checked: ${result.coverage.message}`);
        for (const span of result.coverage.spans.slice(0, 8)) console.error(`      ${span}`);
      }
      return 0;
    }
    console.error(`CV fact check failed: ${basename(targetPath)}`);
    if (result.invented.length) {
      console.error('\nMetric-like claims absent from sources:');
      for (const claim of result.invented) console.error(`  - ${claim}`);
    }
    if (result.unsupportedFacts.length) {
      console.error('\nNon-metric facts absent from sources:');
      for (const claim of result.unsupportedFacts) {
        const { kind, value, line, sourceLine } = claim;
        console.error(`  - ${kind}: ${value}`);
        if (line && line !== value) console.error(`      CV:     ${line}`);
        if (sourceLine) console.error(`      source: ${sourceLine}`);
        if (kind === 'scope') {
          const advice = scopeClaimAdvice(claim);
          console.error(`      ${advice[0].toUpperCase()}${advice.slice(1)}`);
        }
      }
    }
    if (result.forbidden.length) {
      console.error('\nForbidden phrases found:');
      for (const phrase of result.forbidden) console.error(`  - ${phrase}`);
    }
    console.error('\nAdd real evidence to cv.md/article-digest.md, or allow a verified exception in config/cv-facts.json.');
    return 1;
  } catch (err) {
    if (parsed.json) {
      console.log(JSON.stringify({ verdict: 'block', invented: [], unsupportedFacts: [], advisoryFacts: [], forbidden: [], warnings: [], coverage: null, errors: [err.message] }));
      return 1;
    }
    console.error(`ERROR: ${err.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli();
}
