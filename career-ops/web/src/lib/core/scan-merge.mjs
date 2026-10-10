export function mergeScanResults(results, offerCount) {
  const sum = (key) => results.reduce((n, r) => n + (typeof r[key] === "number" ? r[key] : 0), 0);
  const anyNumber = (key) => results.some((r) => typeof r[key] === "number");
  const datasetStatus = {};
  for (const r of results) Object.assign(datasetStatus, r.datasetStatus || {});
  return {
    companiesScanned: sum("companiesScanned"),
    unreachable: sum("unreachableBoards"),
    matches: anyNumber("postingsKept") ? sum("postingsKept") : offerCount,
    ...(anyNumber("companiesAvailable") ? { companiesAvailable: sum("companiesAvailable") } : {}),
    capHit: results.some((r) => r.capHit === true),
    datasetStatus,
    ...(anyNumber("postingsDroppedNoDate") ? { postingsDroppedNoDate: sum("postingsDroppedNoDate") } : {}),
  };
}

function joinLabels(labels) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function timedOutMessage(labels, deadlineSec) {
  const names = joinLabels(labels);
  const plural = labels.length > 1;
  return (
    `${names} didn't finish within ${deadlineSec}s, so ${plural ? "their" : "its"} results are incomplete. ` +
    `Try again without ${names}, with a shorter date range or a lower per-source limit, ` +
    `or raise scan.timeout_seconds in config/profile.yml.`
  );
}
