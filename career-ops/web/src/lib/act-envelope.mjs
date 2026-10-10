const OPEN = "<<act:";

export function pendingActOpenerStart(acc) {
  const withColon = /<<act:[a-zA-Z]*$/.exec(acc);
  if (withColon) return withColon.index;
  for (let k = Math.min(acc.length, OPEN.length - 1); k > 0; k--) {
    if (acc.endsWith(OPEN.slice(0, k))) return acc.length - k;
  }
  return -1;
}
