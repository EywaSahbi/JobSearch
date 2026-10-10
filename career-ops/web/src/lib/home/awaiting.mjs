import { canonStatus } from "../status-alias.mjs";

const baseStatus = (s) => String(s ?? "").replace(/\s+\d{4}-\d{2}-\d{2}\s*$/, "").trim();

export function pickAwaitingDecision(applications, scoreOf, limit = 6) {
  const rank = (s) => {
    const n = scoreOf(s ?? "");
    return Number.isNaN(n) ? -1 : n;
  };
  return applications
    .filter((a) => canonStatus(baseStatus(a.status)) === "EVALUATED")
    .sort((a, b) => {
      const byDate = (b.date || "").localeCompare(a.date || "");
      if (byDate !== 0) return byDate;
      return rank(b.score) - rank(a.score);
    })
    .slice(0, limit);
}
