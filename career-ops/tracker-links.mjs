import { join, relative, sep } from 'path';

export function normalizeReportLink(reportField, trackerDir, repoRoot) {
  return reportField.replace(/\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (whole, linkPath) => {
    const m = linkPath.match(/^(?:\.\.\/)*(reports\/.+)$/);
    if (!m) return whole;
    const reportAbs = join(repoRoot, m[1]);
    const rel = relative(trackerDir, reportAbs).split(sep).join('/');
    return `](${rel})`;
  });
}
