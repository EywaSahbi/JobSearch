export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const effectiveChars = text.replace(/\s+/g, ' ').length;
  return Math.ceil(effectiveChars / 4);
}

export const SECTION_PRIORITY = {
  'scoring system': 0,
  'archetype detection': 0,
  'posting legitimacy': 0,
  'global rules': 0,
  'data root & path resolution': 0,

  'company type and compensation reliability': 1,
  'spend tier': 1,

  'sources of truth': 2,
  'voice dna': 2,
  'writing style calibration': 2,
  'writing style': 2,
  'professional writing & ats compatibility': 2,
};

export const DEFAULT_PRIORITY = 2;

export const DEFAULT_MAX_TOKENS = 128000;

const MODEL_CONTEXT_WINDOWS = new Map(Object.entries({
  'MiniMax-M3': 1000000,
  'MiniMax-M2.7': 204800,
}));

export function contextWindowForModel(modelName) {
  return MODEL_CONTEXT_WINDOWS.get(modelName) ?? DEFAULT_MAX_TOKENS;
}

export const DEFAULT_SAFETY_MARGIN = 8192;

function parseSections(sharedContent) {
  const sections = [];
  const parts = sharedContent.split(/^## (.+)$/gm);

  if (parts[0] && parts[0].trim()) {
    sections.push({ name: '', content: parts[0] });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] || '').trim();
    const body = parts[i + 1] || '';
    if (name) {
      sections.push({ name, content: `## ${name}${body}` });
    }
  }

  return sections;
}

const _warnedSections = new Set();

function getPriority(sectionName) {
  const key = sectionName.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!(key in SECTION_PRIORITY) && !_warnedSections.has(key)) {
    _warnedSections.add(key);
    console.warn(`⚠️  Unrecognized _shared.md section "${sectionName}" → defaulting to P${DEFAULT_PRIORITY} (compressible). Update SECTION_PRIORITY in lib/context-budget.mjs if this section is evaluation-critical.`);
  }
  return SECTION_PRIORITY[key] ?? DEFAULT_PRIORITY;
}

export function compressSharedContext(sharedContent, targetReduction) {
  if (!sharedContent || targetReduction <= 0) {
    return { compressed: sharedContent || '', removed: [] };
  }

  const sections = parseSections(sharedContent);
  if (sections.length === 0) {
    return { compressed: sharedContent, removed: [] };
  }

  const classified = sections.map(s => ({
    ...s,
    priority: s.name ? getPriority(s.name) : -1,
    tokens: estimateTokens(s.content),
  }));

  const removable = classified
    .filter(s => s.priority >= 1)
    .sort((a, b) => b.priority - a.priority);

  let tokensRemoved = 0;
  const removed = [];

  for (const section of removable) {
    if (tokensRemoved >= targetReduction) break;
    tokensRemoved += section.tokens;
    removed.push(section.name);
  }

  const removedSet = new Set(removed);
  const compressed = classified
    .filter(s => !removedSet.has(s.name))
    .map(s => s.content)
    .join('');

  return { compressed, removed };
}

export function buildBudgetedPrompt(opts = {}) {
  const safeOpts = opts ?? {};
  const {
    sharedContent = '',
    ofertaContent = '',
    cvContent = '',
    profileYml = '',
    profileContent = '',
    jdText = '',
    modelName,
    maxTokens = contextWindowForModel(modelName),
    safetyMargin = DEFAULT_SAFETY_MARGIN,
    noCompress = false,
  } = safeOpts;

  const budget = maxTokens - safetyMargin;

  const sectionDefs = [
    { name: '_shared.md', content: sharedContent, compressible: true },
    { name: 'oferta.md', content: ofertaContent, compressible: false },
    { name: 'cv.md', content: cvContent, compressible: false },
  ];

  if (profileYml) {
    sectionDefs.push({ name: 'profile.yml', content: profileYml, compressible: false });
  }
  if (profileContent) {
    sectionDefs.push({ name: '_profile.md', content: profileContent, compressible: false });
  }

  sectionDefs.push({ name: 'JD', content: jdText, compressible: false });

  const sections = sectionDefs.map(s => ({
    ...s,
    tokens: estimateTokens(s.content),
  }));

  const estimatedTotal = sections.reduce((sum, s) => sum + s.tokens, 0);

  const report = {
    totalTokens: estimatedTotal,
    budget,
    compressed: false,
    removed: [],
    beforeTokens: estimatedTotal,
    afterTokens: estimatedTotal,
    overBudget: false,
  };

  if (estimatedTotal <= budget || noCompress) {
    report.overBudget = estimatedTotal > budget;
    const contextBody = assembleContext(sections.map(s => ({
      name: s.name,
      content: s.content,
    })));
    return { contextBody, budgetReport: report };
  }

  const reductionNeeded = estimatedTotal - budget;
  const sharedSection = sections.find(s => s.name === '_shared.md');
  const { compressed, removed } = compressSharedContext(sharedSection.content, reductionNeeded);

  report.compressed = removed.length > 0;
  report.removed = removed;

  const compressedSections = sections.map(s => {
    if (s.name === '_shared.md') {
      const compressedTokens = estimateTokens(compressed);
      return { ...s, content: compressed, tokens: compressedTokens };
    }
    return s;
  });

  report.afterTokens = compressedSections.reduce((sum, s) => sum + s.tokens, 0);
  report.overBudget = report.afterTokens > budget;

  const contextBody = assembleContext(compressedSections.map(s => ({
    name: s.name,
    content: s.content,
  })));

  return { contextBody, budgetReport: report };
}

function assembleContext(sections) {
  const labels = {
    '_shared.md':   'SYSTEM CONTEXT (_shared.md)',
    'oferta.md':    'EVALUATION MODE (oferta.md)',
    'cv.md':        'CANDIDATE RESUME (cv.md)',
    'profile.yml':  'CANDIDATE PROFILE & TARGETS (config/profile.yml)',
    '_profile.md':  'USER ARCHETYPES & NARRATIVE (_profile.md)',
    'JD':           'JOB DESCRIPTION',
  };

  const parts = [];
  for (const s of sections) {
    if (!s.content) continue;
    const label = labels[s.name] || s.name;
    parts.push(
      `═══════════════════════════════════════════════════════\n` +
      `${label}\n` +
      `═══════════════════════════════════════════════════════\n` +
      `${s.content}`
    );
  }

  return parts.join('\n\n');
}
