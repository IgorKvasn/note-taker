export const MINIMUM_PANE_RATIO = 0.15;
export const MAXIMUM_PANE_RATIO = 0.85;
export const DEFAULT_PANE_RATIO = 0.28;

/** The subset of DOMRect the split needs; taking the object keeps the two
 * measurements from being transposed at a call site. */
export interface ContainerBounds {
  left: number;
  width: number;
}

/**
 * Converts a pointer position into a left-pane ratio, clamped so neither pane can
 * be dragged away entirely. A zero-width container would divide by zero, so it
 * holds the current ratio instead.
 */
export function ratioFromPointerPosition(
  pointerX: number,
  container: ContainerBounds,
  currentRatio: number,
): number {
  if (container.width <= 0) {
    return currentRatio;
  }

  return clampPaneRatio((pointerX - container.left) / container.width);
}

export const KEYBOARD_RATIO_STEP = 0.02;

export function clampPaneRatio(ratio: number): number {
  if (Number.isNaN(ratio)) {
    return DEFAULT_PANE_RATIO;
  }

  return Math.min(MAXIMUM_PANE_RATIO, Math.max(MINIMUM_PANE_RATIO, ratio));
}
