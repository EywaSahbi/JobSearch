import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { normalizeTextKey as fallbackKey } from "./normalize-text-key.mjs";

type NormalizeTextKey = (value: unknown, separator?: string) => string;

const modCache = new Map<string, NormalizeTextKey>();

let warned = false;

export async function getNormalizeTextKey(): Promise<NormalizeTextKey> {
  const file = path.join(careerOpsRoot(), "tracker-parse.mjs");
  const hit = modCache.get(file);
  if (hit) return hit;
  try {
    const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
    const fn = mod?.normalizeTextKey;
    if (typeof fn === "function") {
      modCache.set(file, fn);
      return fn;
    }
    if (!warned) {
      warned = true;
      console.warn(
        `[career-ops] ${file} has no normalizeTextKey export — company matching falls back to a local Unicode-safe key. Update career-ops to keep web dedup identical to CLI dedup.`,
      );
    }
  } catch {
    if (!warned) {
      warned = true;
      console.warn(
        `[career-ops] could not load ${file} — company matching falls back to a local Unicode-safe key. Update career-ops to keep web dedup identical to CLI dedup.`,
      );
    }
  }
  return fallbackKey;
}
