/**
 * Small environment-preference helpers used by the view layer.
 *
 * - prefersReducedMotion(): honors the OS "reduce motion" setting live.
 *   When on, the game skips camera shake, halves particle counts and
 *   view-displacement effects, and the DOM skips decorative animations.
 * - isTouchDevice(): picks touch vs keyboard wording for tutorial hints.
 */

let reduced = false;

try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  mq.addEventListener('change', (e) => {
    reduced = e.matches;
  });
} catch {
  /* very old browsers: default to full motion */
}

export function prefersReducedMotion(): boolean {
  return reduced;
}

let touchChecked = false;
let touch = false;

export function isTouchDevice(): boolean {
  if (!touchChecked) {
    touchChecked = true;
    try {
      touch =
        'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
    } catch {
      touch = false;
    }
  }
  return touch;
}
