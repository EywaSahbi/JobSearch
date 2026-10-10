export const WORD_PREFIX = 'word:';

export const STEM_PREFIX = 'stem:';

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = String.raw`(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{M}\p{N}_])`;
const anchoredPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u');
const stemPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}`, 'u');

function compilePrefixedKeyword(kw) {
  if (kw.startsWith(WORD_PREFIX)) {
    const bare = kw.slice(WORD_PREFIX.length).trim();
    if (!bare) return () => false;
    const re = anchoredPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  if (kw.startsWith(STEM_PREFIX)) {
    const bare = kw.slice(STEM_PREFIX.length).trim();
    if (!bare) return () => false;
    const re = stemPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  return null;
}

export function foldAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function compileKeyword(kw) {
  const prefixed = compilePrefixedKeyword(kw);
  if (prefixed) return prefixed;
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = anchoredPattern(kw);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

export function compileContentKeyword(kw) {
  return compilePrefixedKeyword(kw) ?? ((lower) => lower.includes(kw));
}

export const AND_SEPARATOR = /\s+\+\s+/;

export function compilePositiveKeyword(keyword) {
  return compileAndGroup(keyword, compileKeyword);
}

function compileAndGroup(keyword, compileTerm) {
  if (!AND_SEPARATOR.test(keyword)) return compileTerm(keyword);
  const terms = keyword.split(AND_SEPARATOR).map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileTerm(keyword);
  const matchers = terms.map(compileTerm);
  return (lower) => matchers.every(m => m(lower));
}

function normalizeKeywords(arr, compile) {
  return (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => foldAccents(k.trim().toLowerCase()))
    .filter(k => k.length > 0)
    .map(compile);
}

export function compileDomainKeyword(kw) {
  return compileAndGroup(kw, compileDomainTerm);
}

function compileDomainTerm(term) {
  if (term.startsWith(WORD_PREFIX) || term.startsWith(STEM_PREFIX)) return compileKeyword(term);
  return compileKeyword(WORD_PREFIX + term);
}

export function barePrefixDomainKeywords(domainKeywords) {
  if (!Array.isArray(domainKeywords)) return [];
  const bare = (t) => [WORD_PREFIX, STEM_PREFIX].some((p) => t.startsWith(p) && t.slice(p.length).trim() === '');
  return domainKeywords.flatMap((item, idx) => (
    typeof item === 'string' && item.split(AND_SEPARATOR).map((t) => t.trim().toLowerCase()).some(bare) ? [idx] : []
  ));
}

export function buildDomainFilter(domainKeywords) {
  const matchers = normalizeKeywords(domainKeywords, compileDomainKeyword);
  if (matchers.length === 0) return null;
  return (title) => {
    const lower = foldAccents(String(title ?? '').toLowerCase());
    return matchers.some(m => m(lower));
  };
}

export function buildTitleFilter(titleFilter) {
  const positive = normalizeKeywords(titleFilter?.positive, compilePositiveKeyword);
  const negative = normalizeKeywords(titleFilter?.negative, compileKeyword);

  return (title) => {
    const lower = foldAccents(String(title ?? '').toLowerCase());
    const hasPositive = positive.length === 0 || positive.some(m => m(lower));
    const hasNegative = negative.some(m => m(lower));
    return hasPositive && !hasNegative;
  };
}
