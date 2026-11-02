export function quietModel(payload, limit = 10) {
  const empty = {
    available: false,
    reason: typeof payload?.reason === "string" ? payload.reason : "unavailable",
    companies: [],
    checked: 0,
    courtesyDays: null,
    disclaimer: null,
    warnings: [],
  };
  if (!payload?.available || !payload.data) return empty;

  const d = payload.data;
  const meta = d.metadata ?? {};
  const flags = Array.isArray(d.flags) ? d.flags : [];

  const companies = flags
    .filter((f) => f && typeof f.company === "string" && f.company.trim() !== "")
    .slice()
    .sort((a, b) => num(b.daysSinceLastInterview) - num(a.daysSinceLastInterview))
    .slice(0, Math.max(1, Math.trunc(limit)))
    .map((f) => ({
      company: f.company,
      role: typeof f.role === "string" && f.role.trim() !== "" ? f.role : null,
      days: num(f.daysSinceLastInterview),
      lastDate: typeof f.lastInterviewDate === "string" ? f.lastInterviewDate : null,
      trackerNums: Array.isArray(f.trackerNums) ? f.trackerNums.filter((n) => Number.isFinite(n)) : [],
      reason: typeof f.reason === "string" ? f.reason : null,
      blacklistRow: typeof f.blacklistSuggestion === "string" ? f.blacklistSuggestion : null,
    }));

  return {
    available: true,
    reason: null,
    companies,
    checked: num(meta.companiesChecked),
    courtesyDays: Number.isFinite(meta.courtesyDays) ? meta.courtesyDays : null,
    disclaimer: typeof meta.disclaimer === "string" ? meta.disclaimer : null,
    warnings: Array.isArray(d.warnings) ? d.warnings.filter((w) => typeof w === "string") : [],
  };
}

export function checkRan(model) {
  return model.available;
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}
