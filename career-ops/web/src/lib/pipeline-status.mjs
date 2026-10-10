export function applicationKey(row) {
  return JSON.stringify([row.n, row.company, row.role, row.date, row.report]);
}

export function applySavedStatus(rows, saved) {
  return rows.map((row) => applicationKey(row) === saved.key ? { ...row, status: saved.status } : row);
}

export async function saveStatus(n, current, next, request = fetch) {
  if (next === current) return null;
  const response = await request("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ n, status: next }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : "Could not save status. Please try again.");
  }
  if (result?.ok !== true || result.status !== next) {
    throw new Error("Could not confirm the saved status. Refresh before trying again.");
  }
  return result.status;
}
