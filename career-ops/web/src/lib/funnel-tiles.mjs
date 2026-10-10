import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCodeRoot } from './core/code-root.mjs';
import { statusToken } from './pipeline-sankey.mjs';

function countOf(canonStatuses, keys) {
  return canonStatuses.filter((s) => keys.some((k) => s.includes(k))).length;
}

export function cumulativeTiles(canonStatuses) {
  const list = Array.isArray(canonStatuses) ? canonStatuses : [];
  return {
    interviews: countOf(list, ["INTERVIEW", "OFFER", "HIRED"]),
    offers: countOf(list, ["OFFER", "HIRED"]),
  };
}

export async function cumulativeTilesWithHistory(applications, content, coreRoot = resolveCodeRoot(process.cwd())) {
  const file = path.join(coreRoot, 'funnel-stages.mjs');
  const { parseStatusLogStages, recoverFunnelStages } = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  const statuses = new Map();
  for (const app of applications) {
    const id = /^\d+$/.test(app.n) ? Number(app.n) : Symbol();
    statuses.set(id, statusToken(app.status));
  }
  const values = [...recoverFunnelStages(statuses, parseStatusLogStages(content)).values()];
  return { interviews: values.filter(n => n >= 3).length, offers: values.filter(n => n >= 4).length };
}
