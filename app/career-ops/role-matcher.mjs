export const SENIORITY_TOKENS = new Set([
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry'
]);

export const SUB_BASELINE_SENIORITY = new Set([
  'associate', 'junior', 'entry', 'intern',
]);

export const LEVEL_TOKENS = new Map([
  ['i', 1], ['ii', 2], ['iii', 3], ['iv', 4], ['v', 5], ['vi', 6],
  ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6],
]);

const LEVEL_RE = /(?:^|[\s,(\/\-\u2013\u2014])(?:level|lvl|grade|tier)?\s*(i{1,3}|iv|vi?|[1-6])(?=$|[\s,)\/\-\u2013\u2014])/giu;

export const ROLE_STOPWORDS = new Set([
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'intern', 'internship',
  'role', 'position', 'opportunity', 'team', 'based',
  'repost', 'reposted', 'relisted',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  'with', 'from', 'into', 'over', 'this', 'that',
]);

const MTS_PREFIX = /\bmember\s+of\s+technical\s+staff\b/g;

export const SHORT_SPECIALTY = new Set([
  'api', 'sre', 'sdk', 'cli', 'gpu', 'cpu',
  'ios', 'qa', 'ux', 'ui', 'ar', 'vr',
  'ocr', 'crm', 'erp',
]);

export const BASELINE_TOKENS = new Set([
  'software', 'engineer', 'developer', 'manager', 'architect',
  'analyst', 'designer', 'consultant', 'specialist',
  'platform', 'systems', 'services',
  'backend', 'frontend', 'full', 'stack', 'fullstack',
  'product',
]);

function normalizeTitle(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/(?<=[a-z])\p{Mn}/gu, '')
    .normalize('NFC');
}

export function roleTokens(role) {
  return normalizeTitle(role)
    .replace(MTS_PREFIX, ' engineer ')
    .replace(/\b([a-z0-9]{1,3})\/([a-z0-9]{1,3})\b/g, '$1$2')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => (w.length > 3 || SHORT_SPECIALTY.has(w)) && !ROLE_STOPWORDS.has(w));
}

export function extractLevels(title) {
  const levels = new Set();
  for (const m of normalizeTitle(title).matchAll(LEVEL_RE)) {
    const level = LEVEL_TOKENS.get(m[1]);
    if (level !== undefined) levels.add(level);
  }
  return levels;
}

function extractSeniorities(title) {
  return new Set(
    normalizeTitle(title)
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => SENIORITY_TOKENS.has(w))
  );
}

export function roleFuzzyMatch(a, b) {
  const textA = String(a ?? '').trim().toLowerCase();
  const textB = String(b ?? '').trim().toLowerCase();
  if (textA && textA === textB) return true;

  const senA = extractSeniorities(a);
  const senB = extractSeniorities(b);

  if (senA.size > 0 && senB.size > 0) {
    const hasOverlap = [...senA].some(s => senB.has(s));
    if (!hasOverlap) return false;
  } else if (senA.size > 0 || senB.size > 0) {
    const lone = senA.size > 0 ? senA : senB;
    if ([...lone].some(s => SUB_BASELINE_SENIORITY.has(s))) return false;
  }

  const lvlA = extractLevels(a);
  const lvlB = extractLevels(b);
  if (lvlA.size > 0 && lvlB.size > 0 && ![...lvlA].some(l => lvlB.has(l))) return false;

  const wordsA = [...new Set(roleTokens(a))];
  const wordsB = [...new Set(roleTokens(b))];
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w));
  if (overlap.length < 2) return false;

  const discriminating = overlap.filter(w => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  const smaller = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const larger = wordsA.length <= wordsB.length ? wordsB : wordsA;
  const isProperSubset = larger.length > smaller.length && overlap.length === smaller.length;
  if (isProperSubset) {
    const smallerSet = new Set(smaller);
    const extraTokens = larger.filter(w => !smallerSet.has(w));
    if (extraTokens.some(w => !BASELINE_TOKENS.has(w))) return false;
  }

  if ((lvlA.size > 0) !== (lvlB.size > 0)) {
    const setA = new Set(wordsA);
    const uniqueA = wordsA.filter(w => !setB.has(w));
    const uniqueB = wordsB.filter(w => !setA.has(w));
    if (uniqueA.some(w => !BASELINE_TOKENS.has(w)) &&
        uniqueB.some(w => !BASELINE_TOKENS.has(w))) return false;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return overlap.length / union >= 0.6;
}
