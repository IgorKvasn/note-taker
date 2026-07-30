import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiState } from "./useUiState";
import { DEFAULT_PANE_RATIO } from "../components/splitRatio";
import type { UiState } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const SAVED_STATE: UiState = {
  split_ratio: 0.42,
  last_open_note: { root_id: "01ROOT", path: "note.md" },
  expanded_paths: { "01ROOT": ["folder"] },
  has_dismissed_local_only_notice: false,
  editor_mode: "edit",
};

describe("useUiState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads persisted state on mount", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.state).toEqual(SAVED_STATE);
  });

  it("falls back to defaults when get_state rejects", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.reject(new Error("no state file"));
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.state).toEqual({
      split_ratio: DEFAULT_PANE_RATIO,
      last_open_note: null,
      expanded_paths: {},
      has_dismissed_local_only_notice: false,
      editor_mode: "edit",
    });
  });

  it("debounces save_state after setSplitRatio, sending the full updated state", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    invoke.mockClear();

    act(() => result.current.setSplitRatio(0.5));

    expect(invoke).not.toHaveBeenCalledWith("save_state", expect.anything());

    await waitFor(
      () => expect(invoke).toHaveBeenCalledWith("save_state", { state: { ...SAVED_STATE, split_ratio: 0.5 } }),
      { timeout: 2000 },
    );
  });

  it("coalesces rapid changes into a single save_state call", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    invoke.mockClear();

    act(() => {
      result.current.setSplitRatio(0.3);
      result.current.setSplitRatio(0.4);
      result.current.setSplitRatio(0.5);
    });

    await waitFor(
      () => expect(invoke).toHaveBeenCalledWith("save_state", { state: { ...SAVED_STATE, split_ratio: 0.5 } }),
      { timeout: 2000 },
    );

    const saveCalls = invoke.mock.calls.filter(([command]) => command === "save_state");
    expect(saveCalls).toHaveLength(1);
  });

  it("updates last_open_note and expanded_paths independently", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => result.current.setLastOpenNote({ root_id: "01ROOT", path: "other.md" }));
    expect(result.current.state.last_open_note).toEqual({ root_id: "01ROOT", path: "other.md" });

    act(() => result.current.setExpandedPaths("01ROOT", ["folder", "folder/sub"]));
    expect(result.current.state.expanded_paths).toEqual({ "01ROOT": ["folder", "folder/sub"] });
  });

  it("dismissLocalOnlyNotice flips the flag and persists it", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => result.current.dismissLocalOnlyNotice());

    expect(result.current.state.has_dismissed_local_only_notice).toBe(true);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_state", {
        state: { ...SAVED_STATE, has_dismissed_local_only_notice: true },
      }),
    );
  });

  it("setEditorMode updates the mode and persists it", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_state") return Promise.resolve(SAVED_STATE);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useUiState());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => result.current.setEditorMode("view"));

    expect(result.current.state.editor_mode).toBe("view");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_state", {
        state: { ...SAVED_STATE, editor_mode: "view" },
      }),
    );
  });
});
