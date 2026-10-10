export function resolveDataRoot(coreRoot, readMarker, env, resolve, join) {
  const fromEnv = env.CAREER_OPS_ROOT?.trim() || env.CAREER_OPS_DATA_DIR?.trim();
  if (fromEnv) return resolve(coreRoot, fromEnv);

  const marker = readMarker(join(coreRoot, ".career-ops-data"));
  if (marker) {
    const content = marker.trim();
    if (content) return resolve(coreRoot, content);
  }

  return coreRoot;
}
