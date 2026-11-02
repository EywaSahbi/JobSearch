export function claudeUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;

  return [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].reduce((total, key) => {
    const value = usage[key];
    return total + (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
  }, 0);
}
