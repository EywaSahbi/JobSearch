export function profileTargetKeywords(profile) {
  const roles = profile && typeof profile === "object" ? profile.target_roles : null;
  if (!roles || typeof roles !== "object") return [];
  return [
    ...(Array.isArray(roles.primary) ? roles.primary : []),
    ...(Array.isArray(roles.archetypes) ? roles.archetypes.map((a) => a && a.name) : []),
  ].filter((k) => typeof k === "string");
}
