import { describe, expect, it } from "vitest";
import {
  clampPaneRatio,
  DEFAULT_PANE_RATIO,
  MAXIMUM_PANE_RATIO,
  MINIMUM_PANE_RATIO,
  ratioFromPointerPosition,
} from "./splitRatio";

describe("clampPaneRatio", () => {
  it("leaves a ratio inside the bounds untouched", () => {
    expect(clampPaneRatio(0.5)).toBe(0.5);
  });

  it("clamps below the minimum up to the minimum", () => {
    expect(clampPaneRatio(0.01)).toBe(MINIMUM_PANE_RATIO);
    expect(clampPaneRatio(-2)).toBe(MINIMUM_PANE_RATIO);
  });

  it("clamps above the maximum down to the maximum", () => {
    expect(clampPaneRatio(0.99)).toBe(MAXIMUM_PANE_RATIO);
    expect(clampPaneRatio(14)).toBe(MAXIMUM_PANE_RATIO);
  });

  it("falls back to the default ratio for NaN", () => {
    expect(clampPaneRatio(Number.NaN)).toBe(DEFAULT_PANE_RATIO);
  });
});

describe("ratioFromPointerPosition", () => {
  it("converts a pointer position into a fraction of the container", () => {
    expect(ratioFromPointerPosition(500, { left: 0, width: 1000 }, 0.3)).toBe(0.5);
  });

  it("accounts for a container that does not start at the viewport edge", () => {
    expect(ratioFromPointerPosition(300, { left: 100, width: 400 }, 0.3)).toBe(0.5);
  });

  it("clamps a pointer dragged past the left edge", () => {
    expect(ratioFromPointerPosition(0, { left: 100, width: 400 }, 0.3)).toBe(
      MINIMUM_PANE_RATIO,
    );
  });

  it("clamps a pointer dragged past the right edge", () => {
    expect(ratioFromPointerPosition(9000, { left: 0, width: 1000 }, 0.3)).toBe(
      MAXIMUM_PANE_RATIO,
    );
  });

  it("holds the current ratio when the container has no width", () => {
    expect(ratioFromPointerPosition(500, { left: 0, width: 0 }, 0.42)).toBe(0.42);
  });
});
