import { asciiFold } from "./ascii-fold.mjs";

export function companyDomains(company, curatedDomain = () => null) {
  const paren = String(company ?? "").match(/\(([A-Za-z0-9]{2,12})\)/)?.[1];
  const base = String(company ?? "").replace(/\([^()]*\)/g, "").trim();

  const fold = (s) => asciiFold(s, { punctuation: "delete" }).replace(/ /g, "");
  const compact = fold(base.replace(/&/g, "and"));
  const firstWord = fold(base.split(/\s+/)[0] ?? "");

  const stems = [...new Set([compact, paren?.toLowerCase(), firstWord]
    .filter((s) => !!s && s.length >= 2 && s.length <= 30))];

  const out = [];
  const curated = curatedDomain(base);
  if (curated) out.push(curated);
  for (const t of [".com", ".ai", ".io", ".co"]) for (const s of stems) out.push(s + t);
  return [...new Set(out)].slice(0, 5);
}
