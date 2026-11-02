import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";

type TrackerUtils = {
  resolveTrackerPath: (rootDir: string) => string;
  resolvePdfIndexPath: (trackerPath: string) => string;
};

const modCache = new Map<string, TrackerUtils>();

let warned = false;

export async function resolvePdfIndexPath(): Promise<string | null> {
  const root = careerOpsRoot();
  const file = path.join(root, "tracker-utils.mjs");
  const hit = modCache.get(file);
  if (hit) return hit.resolvePdfIndexPath(hit.resolveTrackerPath(root));
  try {
    const mod = (await import(/* webpackIgnore: true */ pathToFileURL(file).href)) as Partial<TrackerUtils>;
    if (typeof mod.resolveTrackerPath === "function" && typeof mod.resolvePdfIndexPath === "function") {
      const utils = mod as TrackerUtils;
      modCache.set(file, utils);
      return utils.resolvePdfIndexPath(utils.resolveTrackerPath(root));
    }
    if (!warned) {
      warned = true;
      console.warn(`[career-ops] ${file} has no resolveTrackerPath/resolvePdfIndexPath export — update career-ops to enable the tailored-CV viewer.`);
    }
  } catch {
    if (!warned) {
      warned = true;
      console.warn(`[career-ops] could not load ${file} — update career-ops to enable the tailored-CV viewer.`);
    }
  }
  return null;
}
