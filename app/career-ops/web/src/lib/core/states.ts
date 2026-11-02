import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { CANONICAL_STATES } from "@/lib/format";

export type CanonicalState = {
  id: string;
  label: string;
  aliases: string[];
  description: string;
  group: string;
};

const FALLBACK: CanonicalState[] = CANONICAL_STATES.map((label) => ({
  id: label.toLowerCase(),
  label,
  aliases: [],
  description: "",
  group: label.toLowerCase(),
}));

const statesCache = new Map<string, { mtimeMs: number; size: number; states: CanonicalState[] }>();

export function readCanonicalStates(): CanonicalState[] {
  const file = path.join(careerOpsRoot(), "templates", "states.yml");
  try {
    const { mtimeMs, size } = fs.statSync(file);
    const cached = statesCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.states;
    const raw = fs.readFileSync(file, "utf8");
    const doc = yaml.load(raw) as { states?: unknown };
    const list = Array.isArray(doc?.states) ? doc.states : null;
    if (list && list.length) {
      const parsed: CanonicalState[] = [];
      for (const s of list as Record<string, unknown>[]) {
        if (!s || typeof s.label !== "string") continue;
        parsed.push({
          id: typeof s.id === "string" ? s.id : s.label.toLowerCase(),
          label: s.label,
          aliases: Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === "string") : [],
          description: typeof s.description === "string" ? s.description : "",
          group: typeof s.dashboard_group === "string" ? s.dashboard_group : (typeof s.id === "string" ? s.id : s.label.toLowerCase()),
        });
      }
      if (parsed.length) {
        statesCache.set(file, { mtimeMs, size, states: parsed });
        return parsed;
      }
    }
    statesCache.delete(file);
  } catch {
  }
  return FALLBACK;
}

export function canonicalLabels(): string[] {
  return readCanonicalStates().map((s) => s.label);
}

function foldStatusInput(input: string): string {
  return String(input ?? "")
    .replace(/\*\*/g, "")
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/̇/gu, "");
}

export function canonicalizeStatus(raw: string): string | null {
  const q = foldStatusInput(raw);
  if (!q) return null;
  for (const s of readCanonicalStates()) {
    if (foldStatusInput(s.label) === q || foldStatusInput(s.id) === q || s.aliases.some((a) => foldStatusInput(a) === q)) {
      return s.label;
    }
  }
  return null;
}
