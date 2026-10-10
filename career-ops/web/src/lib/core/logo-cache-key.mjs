import { createHash } from "node:crypto";
import { normalizeTextKey } from "./normalize-text-key.mjs";

export const COMPANY_KEY_VERSION = "v4";

function truncateCodePoints(s, n) {
  return [...s].slice(0, n).join("");
}

export function companyCacheKey(company) {
  const normalized = normalizeTextKey(company);
  if (!normalized) return null;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `co_${COMPANY_KEY_VERSION}_${truncateCodePoints(normalized, 40)}_${digest}`;
}
