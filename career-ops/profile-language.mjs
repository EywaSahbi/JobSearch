import * as yaml from 'js-yaml';

const DEFAULT_OUTPUT_LANGUAGE = 'en';

function normalizeOutputLanguage(value) {
  if (typeof value !== 'string') return DEFAULT_OUTPUT_LANGUAGE;
  const language = value.trim();
  if (!language || language.length > 64 || /[\r\n\0]/.test(language)) {
    return DEFAULT_OUTPUT_LANGUAGE;
  }
  return language;
}

export function describeOutputLanguage(profileYaml) {
  let profile;
  try {
    profile = yaml.load(String(profileYaml ?? '')) || {};
  } catch {
    return { language: DEFAULT_OUTPUT_LANGUAGE, source: 'unparseable' };
  }
  const raw = profile?.language?.output;
  const language = normalizeOutputLanguage(raw);
  const configured = typeof raw === 'string' && raw.trim() === language;
  return { language, source: configured ? 'configured' : 'default' };
}

export function parseOutputLanguage(profileYaml) {
  return describeOutputLanguage(profileYaml).language;
}

export function outputLanguageInstruction(language) {
  const outputLanguage = normalizeOutputLanguage(language);
  return [
    `Write all human-facing output in ${outputLanguage}, including the full A–G`,
    `evaluation and the machine-readable summary's free-text fields, regardless`,
    `of the language of these instructions or the job description. Keep`,
    `market-specific terms when relevant, but explain them in ${outputLanguage}`,
    `when needed. The configured language.output always wins over the job`,
    `description's language.`,
  ].join(' ');
}
