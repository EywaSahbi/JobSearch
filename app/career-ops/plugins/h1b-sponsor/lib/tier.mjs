export function classifyTier(profile) {
  if (profile == null || typeof profile !== 'object') return 'unknown';

  const staffing = profile.red_flags && profile.red_flags.staffing_shop;
  if (staffing && staffing.value === true) return 'staffing-shop';

  const nPwd = Number(profile.n_pwd ?? 0) || 0;
  const nPerm = Number(profile.n_perm ?? 0) || 0;
  const nLca = Number(profile.n_lca ?? 0) || 0;
  const total = nLca + nPwd + nPerm;

  if (total === 0) return 'none';

  const currentYear = new Date().getUTCFullYear();
  const lastYear = Number(profile.last_year);
  const hasLastYear = Number.isFinite(lastYear);

  const stale = hasLastYear && lastYear < currentYear - 3;
  const lowVolume = total < 5;
  if (stale || lowVolume) return 'weak';

  const shareNum = staffing ? Number(staffing.share) : NaN;
  const staffingShare = Number.isFinite(shareNum) ? shareNum : null;
  const recent = hasLastYear && lastYear >= currentYear - 2 && lastYear <= currentYear + 1;

  if (profile.does_gc === true && recent && (staffingShare ?? 0) < 0.2) {
    return 'strong';
  }

  if (total >= 5 && recent && (staffingShare ?? 0) < 0.5) {
    return 'moderate';
  }

  return 'weak';
}
