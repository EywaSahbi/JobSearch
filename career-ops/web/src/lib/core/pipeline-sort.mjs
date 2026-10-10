import { compareTrackerNumbers } from '../pipeline-sort.mjs';

export function sortRows(rows, sort, scoreOf, companyLabel = (row) => String(row.company ?? '')) {
  const dir = sort.dir === 1 ? 1 : -1;

  const numberOf = (row) => Number.parseInt(row.n, 10);

  const scoreKey = (row) => {
    const value = scoreOf(row.score ?? '');
    return Number.isNaN(value) ? -Infinity : value;
  };

  const byKey = (a, b) => {
    if (sort.key === 'tracker') {
      const delta = compareTrackerNumbers(a, b);
      return Number.isNaN(delta) ? 0 : delta * dir;
    }
    if (sort.key === 'score') {
      const av = scoreKey(a);
      const bv = scoreKey(b);
      return av === bv ? 0 : (av - bv) * dir;
    }
    const aValue = sort.key === 'company' ? companyLabel(a) : a[sort.key] || '';
    const bValue = sort.key === 'company' ? companyLabel(b) : b[sort.key] || '';
    return String(aValue).localeCompare(String(bValue)) * dir;
  };

  const out = [...rows].sort(byKey);

  for (let start = 0; start < out.length; ) {
    let end = start + 1;
    while (end < out.length && byKey(out[start], out[end]) === 0) end++;
    const numbered = [];
    for (let i = start; i < end; i++) {
      if (!Number.isNaN(numberOf(out[i]))) numbered.push(out[i]);
    }
    if (numbered.length > 1) {
      numbered.sort((a, b) => (numberOf(a) - numberOf(b)) * dir);
      let next = 0;
      for (let i = start; i < end; i++) {
        if (!Number.isNaN(numberOf(out[i]))) out[i] = numbered[next++];
      }
    }
    start = end;
  }

  return out;
}
