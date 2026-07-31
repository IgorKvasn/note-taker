import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "./useToasts";

describe("useToasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with no toasts", () => {
    const { result } = renderHook(() => useToasts());

    expect(result.current.toasts).toEqual([]);
  });

  it("adds a toast with a unique id when shown", () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.showToast("Copied to clipboard"));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe("Copied to clipboard");
  });

  it("stacks multiple toasts rather than replacing one another", () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.showToast("first"));
    act(() => result.current.showToast("second"));

    expect(result.current.toasts).toHaveLength(2);
    expect(result.current.toasts.map((toast) => toast.message)).toEqual(["first", "second"]);
    expect(result.current.toasts[0].id).not.toBe(result.current.toasts[1].id);
  });

  it("auto-dismisses a toast after ~2 seconds, independently per toast", () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.showToast("first"));
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.showToast("second"));
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.toasts.map((toast) => toast.message)).toEqual(["second"]);

    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.toasts).toEqual([]);
  });

  it("clears pending timers on unmount without throwing", () => {
    const { result, unmount } = renderHook(() => useToasts());

    act(() => result.current.showToast("first"));

    expect(() => unmount()).not.toThrow();
    expect(() => act(() => vi.advanceTimersByTime(5000))).not.toThrow();
  });
});
