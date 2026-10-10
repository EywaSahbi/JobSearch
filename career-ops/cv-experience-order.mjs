const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);
const START_TAG_RE = /<([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const DISPLAY_PERIOD_MAX = 60;

export function parseExperienceStart(period) {
  if (typeof period !== 'string') return null;
  const text = period.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ').trim();
  const year = text.match(/\b(19|20)\d{2}\b/);
  if (!year) return null;
  const before = text.slice(0, year.index);
  const month = before.match(/\b([a-z]{3})[a-z]*\.?\s*$/i);
  return {
    year: Number(year[0]),
    month: month ? (MONTHS.get(month[1].toLowerCase()) ?? null) : null,
  };
}

function displayPeriod(text) {
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = [...clean];
  if (points.length <= DISPLAY_PERIOD_MAX) return clean;
  const kept = points.slice(0, DISPLAY_PERIOD_MAX - 1);
  while (kept.length > 0 && /\p{M}/u.test(kept[kept.length - 1])) kept.pop();
  return `${kept.join('')}…`;
}

function startsLater(a, b) {
  if (a.year !== b.year) return a.year > b.year;
  return a.month !== null && b.month !== null && a.month > b.month;
}

function hasJobPeriodClass(attributes) {
  for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(ATTRIBUTE_RE)) {
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    if (name.toLowerCase() === 'class' && value.toLowerCase().split(/\s+/).includes('job-period')) return true;
  }
  return false;
}

function jobPeriodContents(html) {
  const contents = [];
  const tags = new RegExp(START_TAG_RE);
  let tag;
  while ((tag = tags.exec(html)) !== null) {
    if (!hasJobPeriodClass(tag[2])) continue;
    const sameTag = new RegExp(`<(/?)${tag[1]}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
    sameTag.lastIndex = tags.lastIndex;
    let depth = 1;
    let end;
    while (depth > 0 && (end = sameTag.exec(html)) !== null) {
      if (end[1]) depth--;
      else if (!end[2].trimEnd().endsWith('/')) depth++;
    }
    if (depth > 0) continue;
    contents.push(html.slice(tags.lastIndex, end.index));
    tags.lastIndex = sameTag.lastIndex;
  }
  return contents;
}

export function validateCvExperienceOrder(html, { allowNonChronological = false } = {}) {
  if (typeof html !== 'string') return;

  const entries = [];
  for (const content of jobPeriodContents(html)) {
    let text = content;
    let prev;
    do { prev = text; text = text.replace(/<[^>]*>/g, ''); } while (text !== prev);
    const raw = text.trim();
    const start = parseExperienceStart(raw);
    if (start !== null) entries.push({ shown: displayPeriod(raw), start });
  }
  if (entries.length < 2) return;

  for (let i = 1; i < entries.length; i++) {
    if (startsLater(entries[i].start, entries[i - 1].start)) {
      const order = entries.map(e => e.shown).join(' -> ');
      const message =
        `CV work experience is not in reverse-chronological order: "${entries[i].shown}" ` +
        `appears after "${entries[i - 1].shown}" but starts later. Rendered order: ${order}. ` +
        `Tailor via the summary, competencies, and bullet selection — not by reordering roles.`;
      if (allowNonChronological) {
        console.warn(`⚠️  ${message} (proceeding — --allow-nonchronological set)`);
        return;
      }
      throw new Error(
        `${message} List the roles newest-first and regenerate, or pass ` +
        `--allow-nonchronological if the candidate asked for this order.`);
    }
  }
}
