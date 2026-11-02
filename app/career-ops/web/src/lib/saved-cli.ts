import { keepIfInstalled, pickSoleInstalled } from "./cli-pick.mjs";

export const CONFIG_KEY = "career-ops:config";

export function readSavedCliId(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function persistCliId(cliId: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
  } catch {
  }
}

export { pickDefaultInstalled, pickSoleInstalled } from "./cli-pick.mjs";

function isCliEntry(c: unknown): c is { id: string; installed?: boolean } {
  if (typeof c !== "object" || c === null) return false;
  const { id, installed } = c as { id?: unknown; installed?: unknown };
  return typeof id === "string" && id !== "" && (installed === undefined || typeof installed === "boolean");
}

const CLIS_TIMEOUT_MS = 5000;

export async function resolveCliId(
  onStale?: (stale: string, replacement: string | null) => void,
): Promise<string | null> {
  const saved = readSavedCliId();
  let clis: { id: string; installed?: boolean }[] | undefined;
  try {
    const r = await fetch("/api/clis", { signal: AbortSignal.timeout(CLIS_TIMEOUT_MS) });
    if (r.ok) {
      const d = (await r.json()) as { clis?: { id: string; installed?: boolean }[] };
      clis = d.clis;
    }
  } catch {
  }
  if (!Array.isArray(clis) || !clis.every(isCliEntry)) {
    return saved;
  }
  if (keepIfInstalled(saved, clis)) return saved;
  const sole = pickSoleInstalled(clis);
  if (sole) persistCliId(sole);
  if (saved) onStale?.(saved, sole);
  return sole;
}
