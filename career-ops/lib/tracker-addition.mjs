export function tsvSafe(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function slugifyCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

export function isPostingUrl(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export function normalizedTrackerScore(value) {
  const clean = tsvSafe(value);
  const parsed = clean.match(/^(\d+(?:\.\d+)?)/);
  if (!parsed) return 'N/A';
  const score = parseFloat(parsed[1]);
  const denominator = clean.match(/\/\s*(\d+(?:\.\d+)?)/);
  const scale = denominator ? parseFloat(denominator[1]) : 5;
  if (!Number.isFinite(score) || scale !== 5 || score < 0 || score > 5) return 'N/A';
  return `${score}/5`;
}
