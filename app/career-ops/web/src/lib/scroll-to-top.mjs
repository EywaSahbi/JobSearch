export const BACK_TO_TOP_THRESHOLD = 400;

export function shouldShowBackToTop(scrollY, threshold = BACK_TO_TOP_THRESHOLD) {
  return scrollY > threshold;
}

export function scrollBehaviorFor(prefersReducedMotion) {
  return prefersReducedMotion ? "auto" : "smooth";
}
