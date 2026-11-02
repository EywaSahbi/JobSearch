export function suppressionKey(norm, company, role) {
  return `${norm(company, " ")}|${norm(role, " ")}`;
}

export function evaluatedKeys(applications, norm) {
  const keys = new Set();
  for (const app of applications ?? []) {
    if (!norm(app?.company, " ")) continue;
    keys.add(suppressionKey(norm, app?.company ?? "", app?.role ?? ""));
  }
  return keys;
}

export function isEvaluated(keys, norm, company, title) {
  if (!company || !norm(company, " ")) return false;
  return keys.has(suppressionKey(norm, company, title));
}
