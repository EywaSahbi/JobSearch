export const SCAN_SUMMARY_MARKER = '::career-ops:scan-summary::';

export function scanSummaryHeaderLines(title, date) {
  const rule = '━'.repeat(45);
  return ['', SCAN_SUMMARY_MARKER, rule, `${title} — ${date}`, rule];
}

export function printScanSummaryHeader(title, date, emit = console.log) {
  for (const line of scanSummaryHeaderLines(title, date)) emit(line);
}
