const NON_DECOMPOSING_LATIN = [
  [/ø/g, 'o'], [/æ/g, 'ae'], [/œ/g, 'oe'], [/ß/g, 'ss'],
  [/đ/g, 'd'], [/ł/g, 'l'], [/þ/g, 'th'], [/ð/g, 'd'],
  [/ħ/g, 'h'], [/ı/g, 'i'], [/ŋ/g, 'ng'], [/ŧ/g, 't'],
  [/ĸ/g, 'k'], [/ſ/g, 's'],
];

export function asciiFold(value, { punctuation = 'space' } = {}) {
  let out = String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  for (const [re, to] of NON_DECOMPOSING_LATIN) out = out.replace(re, to);
  out = punctuation === 'delete'
    ? out.replace(/[^a-z0-9 ]/g, '')
    : out.replace(/[^a-z0-9\s]/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}
