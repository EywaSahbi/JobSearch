const TOKEN_RE = /[\p{L}\p{N}+#.]+/gu;

const SENIORITY = new Set([
  "junior", "jr", "mid", "middle", "senior", "sr", "staff", "principal",
  "lead", "head", "chief", "associate", "assistant", "intern", "internship",
  "entry", "level", "ii", "iii", "iv",
]);

function tokens(text) {
  const raw = String(text ?? "").toLowerCase().match(TOKEN_RE) ?? [];
  return raw
    .map((t) => t.replace(/\.+$/, ""))
    .filter((t) => t.length > 1 && !SENIORITY.has(t));
}

export function titleFit(title, targets) {
  const titleTokens = new Set(tokens(title));
  if (!titleTokens.size || !Array.isArray(targets)) return null;

  let best = -1;
  for (const target of targets) {
    const roleTokens = [...new Set(tokens(target))];
    if (!roleTokens.length) continue;
    let hits = 0;
    for (const t of roleTokens) if (titleTokens.has(t)) hits++;
    best = Math.max(best, hits / roleTokens.length);
  }
  if (best < 0) return null;

  const rounded = Math.round(best * 100) / 100;
  const band = rounded >= 0.6 ? "strong" : rounded >= 0.34 ? "related" : "weak";
  return { band, score: rounded };
}
