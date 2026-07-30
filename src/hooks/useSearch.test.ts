import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "./useSearch";
import type { SearchResult } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function makeResult(title: string): SearchResult {
  return {
    root_id: "01ROOT",
    path: `${title}.md`,
    directory_path: "",
    title,
    match_count: 1,
    snippet: "a match",
    snippet_matches: [{ start: 0, end: 1 }],
    first_match_offset: 0,
    seq: 0,
  };
}

describe("useSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not search below 2 characters", () => {
    const { result } = renderHook(() => useSearch());

    act(() => result.current.setQuery("a"));
    act(() => vi.advanceTimersByTime(1000));

    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toBeNull();
  });

  it("debounces 250ms after the last keystroke before searching", () => {
    invoke.mockResolvedValue([]);
    const { result } = renderHook(() => useSearch());

    act(() => result.current.setQuery("ab"));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.setQuery("abc"));
    act(() => vi.advanceTimersByTime(100));

    expect(invoke).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(250));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("search_notes", { query: "abc", seq: expect.any(Number) });
  });

  it("discards a stale response that resolves after a newer one (out-of-order cancellation)", async () => {
    let resolveFirst!: (value: SearchResult[]) => void;
    let resolveSecond!: (value: SearchResult[]) => void;

    invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

    const { result } = renderHook(() => useSearch());

    act(() => result.current.setQuery("slow"));
    act(() => vi.advanceTimersByTime(250));

    invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    act(() => result.current.setQuery("fast"));
    act(() => vi.advanceTimersByTime(250));

    expect(invoke).toHaveBeenCalledTimes(2);

    // Newer (second) request resolves first.
    await act(async () => resolveSecond([makeResult("fast-hit")]));
    // Older (first) request resolves later and must be dropped.
    await act(async () => resolveFirst([makeResult("slow-hit")]));

    expect(result.current.results?.map((r) => r.title)).toEqual(["fast-hit"]);
  });

  it("clearing the query below 2 chars restores tree mode without a search call", () => {
    invoke.mockResolvedValue([makeResult("hit")]);
    const { result } = renderHook(() => useSearch());

    act(() => result.current.setQuery("ab"));
    act(() => vi.advanceTimersByTime(250));

    act(() => result.current.setQuery(""));

    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toBeNull();
  });

  it("clear() resets query and results", () => {
    const { result } = renderHook(() => useSearch());

    act(() => result.current.setQuery("something"));
    act(() => result.current.clear());

    expect(result.current.query).toBe("");
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toBeNull();
  });
});
