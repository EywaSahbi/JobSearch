export function normalizeTextKey(value, separator = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/̇/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
