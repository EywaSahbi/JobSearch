export function pendingOpenerLen(buf, opener) {
  const max = Math.min(buf.length, opener.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(opener.slice(0, k))) return k;
  }
  return 0;
}
