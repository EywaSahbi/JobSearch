export const DEFAULT_RETURN_PATH = "/pipeline";

const IN_FLIGHT = new Set(["opening", "driving", "prefilling", "filling"]);

export function needsLeaveConfirmation({ status, answers } = {}) {
  if (IN_FLIGHT.has(status)) return true;
  return Object.values(answers ?? {}).some((v) => typeof v === "string" && v.trim() !== "");
}

export function resolveReturnPath(from) {
  if (typeof from !== "string") return DEFAULT_RETURN_PATH;
  const path = from.trim();
  if (!path.startsWith("/")) return DEFAULT_RETURN_PATH;
  if (path.startsWith("//") || path.startsWith("/\\")) return DEFAULT_RETURN_PATH;
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  if (pathname === "/apply") return DEFAULT_RETURN_PATH;
  return path;
}

export function resolveLateSession({ stale, sessionId } = {}) {
  if (!stale) return "apply";
  return sessionId ? "close" : "discard";
}
