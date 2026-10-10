const DUE_URGENCIES = new Set(["urgent", "overdue"]);

export function isDue(entry) {
  return DUE_URGENCIES.has(entry?.urgency);
}

export function selectDueFollowups(entries, limit = 8) {
  const urgencyOrder = { urgent: 0, overdue: 1 };
  return (Array.isArray(entries) ? entries : [])
    .filter(isDue)
    .sort((a, b) => (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9))
    .slice(0, limit);
}

function nextDateValue(entry) {
  const t = entry?.nextFollowupDate ? Date.parse(entry.nextFollowupDate) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

export function pickNextUpcoming(entries) {
  const upcoming = (Array.isArray(entries) ? entries : [])
    .filter((e) => !isDue(e) && e?.nextFollowupDate)
    .sort((a, b) => nextDateValue(a) - nextDateValue(b));
  return upcoming[0] ?? null;
}
