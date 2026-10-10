export const DEFAULT_SMALL_THRESHOLD = 5;

export function isSmallBoard(count, threshold = DEFAULT_SMALL_THRESHOLD) {
  return threshold > 0 && count <= threshold;
}

export function smallBoardDetail(count) {
  return `only ${count} posting(s) — confirm this is the right board`;
}
