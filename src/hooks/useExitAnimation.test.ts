import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExitAnimation } from "./useExitAnimation";

describe("useExitAnimation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render while never opened", () => {
    const { result } = renderHook(() => useExitAnimation(false));

    expect(result.current.shouldRender).toBe(false);
    expect(result.current.isClosing).toBe(false);
  });

  it("renders without a closing flag while open", () => {
    const { result } = renderHook(() => useExitAnimation(true));

    expect(result.current.shouldRender).toBe(true);
    expect(result.current.isClosing).toBe(false);
  });

  it("keeps rendering and marks closing when isOpen flips to false", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useExitAnimation(isOpen), {
      initialProps: { isOpen: true },
    });

    rerender({ isOpen: false });

    expect(result.current.shouldRender).toBe(true);
    expect(result.current.isClosing).toBe(true);
  });

  it("stops rendering once the exit animation end handler fires", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useExitAnimation(isOpen), {
      initialProps: { isOpen: true },
    });

    rerender({ isOpen: false });
    act(() => result.current.handleExitTransitionEnd());

    expect(result.current.shouldRender).toBe(false);
    expect(result.current.isClosing).toBe(false);
  });

  it("falls back to unmounting if no animation event ever arrives", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useExitAnimation(isOpen), {
      initialProps: { isOpen: true },
    });

    rerender({ isOpen: false });
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.shouldRender).toBe(false);
    expect(result.current.isClosing).toBe(false);
  });

  it("re-opening during the exit animation cancels the close", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useExitAnimation(isOpen), {
      initialProps: { isOpen: true },
    });

    rerender({ isOpen: false });
    rerender({ isOpen: true });

    expect(result.current.shouldRender).toBe(true);
    expect(result.current.isClosing).toBe(false);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.shouldRender).toBe(true);
  });

  it("does nothing when isOpen starts false and stays false", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useExitAnimation(isOpen), {
      initialProps: { isOpen: false },
    });

    rerender({ isOpen: false });

    expect(result.current.shouldRender).toBe(false);
    expect(result.current.isClosing).toBe(false);
  });
});
