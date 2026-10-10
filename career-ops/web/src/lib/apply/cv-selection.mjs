export function reportNumberFromCell(cell) {
  const match = /\[(\d+)\]\(/.exec(String(cell ?? ""));
  return match ? Number.parseInt(match[1], 10) : null;
}

export function pdfIndexEntryForReport(indexText, reportNumber, kind = "cv") {
  if (!Number.isInteger(reportNumber)) return { found: false, path: null };
  const wanted = kind === "cover" ? "cover" : "cv";
  for (const line of String(indexText ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const columns = line.split("\t");
    const indexedReport = columns[0]?.trim() ?? "";
    if (!/^\d+$/.test(indexedReport) || Number(indexedReport) !== reportNumber) continue;
    const rowKind = (columns[5] ?? "").trim() === "cover" ? "cover" : "cv";
    if (rowKind !== wanted) continue;
    const pdf = columns[1]?.trim();
    return { found: true, path: pdf || null };
  }
  return { found: false, path: null };
}

export function pdfPathForReport(indexText, reportNumber, kind = "cv") {
  const entry = pdfIndexEntryForReport(indexText, reportNumber, kind);
  return entry.found ? entry.path : null;
}
