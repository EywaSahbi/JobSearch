const GENERIC_FAILURE = "status update failed";

export function parseCliJson(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const asObject = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return (parsed);
      }
    } catch {
    }
    return null;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    const single = asObject(lines[i].trim());
    if (single) return single;
    const multi = asObject(lines.slice(i).join("\n"));
    if (multi) return multi;
  }
  return null;
}

export function clientErrorMessage(parsed, _stderr) {
  return typeof parsed?.error === "string" ? parsed.error : GENERIC_FAILURE;
}

export function trackerRowArg(n) {
  if (typeof n !== "string" && typeof n !== "number") return null;
  const row = String(n).trim();
  return /^\d+$/.test(row) ? row : null;
}
