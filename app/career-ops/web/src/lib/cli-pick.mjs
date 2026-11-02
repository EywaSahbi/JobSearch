export function pickSoleInstalled(clis) {
  const installed = (clis || []).filter((c) => c && c.installed);
  return installed.length === 1 ? installed[0].id : null;
}

export function pickDefaultInstalled(clis) {
  return (clis || []).find((c) => c && c.installed)?.id || null;
}

export function keepIfInstalled(id, clis) {
  if (!id) return null;
  return (clis || []).some((c) => c && c.id === id && c.installed) ? id : null;
}

export function pickUsableCli(id, clis) {
  const kept = keepIfInstalled(id, clis);
  if (kept) return { id: kept, substitutedFrom: null };
  const sole = pickSoleInstalled(clis);
  return sole ? { id: sole, substitutedFrom: id || null } : { id: null, substitutedFrom: null };
}

export function installedCliIds(clis) {
  return (clis || []).filter((c) => c && c.installed && typeof c.id === "string").map((c) => c.id);
}
