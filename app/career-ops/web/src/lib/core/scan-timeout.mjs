export const DEFAULT_SCAN_TIMEOUT_MS = 230_000;

export function resolveScanTimeoutMs(profile) {
  const scan = profile && typeof profile === "object" && !Array.isArray(profile) ? profile.scan : undefined;
  const raw = scan && typeof scan === "object" && !Array.isArray(scan) ? scan.timeout_seconds : undefined;
  if (typeof raw !== "number" && typeof raw !== "string") return DEFAULT_SCAN_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim() === "") return DEFAULT_SCAN_TIMEOUT_MS;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.floor(secs * 1000) : DEFAULT_SCAN_TIMEOUT_MS;
}

export function scanTimeoutMessage(timeoutMs) {
  const secs = timeoutMs / 1000;
  return (
    `The scan was stopped after ${secs}s before it finished. ` +
    `Narrow the ATS list, lower the per-ATS limit, or raise ` +
    `scan.timeout_seconds in config/profile.yml to give it more time.`
  );
}
