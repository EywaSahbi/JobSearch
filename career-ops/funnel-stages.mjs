const RANKS = new Map([
  ['APPLIED', 1], ['RESPONDED', 2], ['REJECTED', 2],
  ['INTERVIEW', 3], ['OFFER', 4], ['HIRED', 5],
]);

export function funnelStageRank(status) {
  return RANKS.get(String(status ?? '').trim().toUpperCase()) || 0;
}

export function parseStatusLogStages(content) {
  const out = [];
  for (const line of String(content ?? '').replace(/\r/g, '').split('\n')) {
    const [rawNum, date, from, to] = line.split('\t').map(s => s.trim());
    if (!/^\d+$/.test(rawNum || '') || !date || !from || !to) continue;
    out.push({ num: Number(rawNum), from, to });
  }
  return out;
}

export function recoverFunnelStages(statusByNum, ledger) {
  const reached = new Map();
  const bump = (num, status) => reached.set(num, Math.max(reached.get(num) || 0, funnelStageRank(status)));
  for (const [num, status] of statusByNum) {
    if (String(status ?? '').trim().toUpperCase() !== 'SKIP') bump(num, status);
  }
  for (const { num, from, to } of ledger) {
    if (!reached.has(num)) continue;
    bump(num, from);
    bump(num, to);
  }
  return reached;
}
