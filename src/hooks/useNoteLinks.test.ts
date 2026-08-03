import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNoteLinks } from "./useNoteLinks";
import type { SyncStatusEvent } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const noteInRoot = (rootId: string) => ({
  notes: [{ id: `01${rootId}`, path: `${rootId}.md`, directory_path: "", title: rootId }],
  backlinks: {},
});

describe("useNoteLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
    invoke.mockImplementation((_command: string, args: { rootId: string }) =>
      Promise.resolve(noteInRoot(args.rootId)),
    );
  });

  it("resolves a scanned id to its path", async () => {
    const { result } = renderHook(() => useNoteLinks("A"));

    await waitFor(() => expect(result.current.linkableNotes).toHaveLength(1));
    expect(result.current.resolveNoteLink("01A")).toBe("A.md");
  });

  it("returns null for an id that was not scanned", async () => {
    const { result } = renderHook(() => useNoteLinks("A"));

    await waitFor(() => expect(result.current.linkableNotes).toHaveLength(1));
    expect(result.current.resolveNoteLink("01MISSING")).toBeNull();
  });

  it("never resolves the previous root's ids after the root changes", async () => {
    const { result, rerender } = renderHook(({ rootId }) => useNoteLinks(rootId), {
      initialProps: { rootId: "A" },
    });
    await waitFor(() => expect(result.current.resolveNoteLink("01A")).toBe("A.md"));

    // A scan that never settles: the old root's map must not stand in for it.
    invoke.mockImplementation(() => new Promise(() => {}));
    rerender({ rootId: "B" });

    expect(result.current.resolveNoteLink("01A")).toBeNull();
    expect(result.current.linkableNotes).toEqual([]);
  });

  it("keeps the existing map when a rescan fails", async () => {
    const { result } = renderHook(() => useNoteLinks("A"));
    await waitFor(() => expect(result.current.resolveNoteLink("01A")).toBe("A.md"));

    invoke.mockRejectedValue(new Error("scan failed"));
    await act(async () => {
      for (const [event, handler] of listen.mock.calls) {
        if (event === "sync-status") {
          (handler as (event: { payload: SyncStatusEvent }) => void)({
            payload: { root_id: "A", state: { state: "synced" } },
          });
        }
      }
    });

    expect(result.current.resolveNoteLink("01A")).toBe("A.md");
  });

  it("rescans when a sync for its own root settles, but not for another root", async () => {
    const { result } = renderHook(() => useNoteLinks("A"));
    await waitFor(() => expect(result.current.linkableNotes).toHaveLength(1));
    const scanCount = () => invoke.mock.calls.filter(([command]) => command === "scan_links").length;
    const before = scanCount();

    const fire = (payload: SyncStatusEvent) => {
      for (const [event, handler] of listen.mock.calls) {
        if (event === "sync-status") {
          (handler as (event: { payload: SyncStatusEvent }) => void)({ payload });
        }
      }
    };

    await act(async () => {
      fire({ root_id: "OTHER", state: { state: "synced" } });
    });
    expect(scanCount()).toBe(before);

    await act(async () => {
      fire({ root_id: "A", state: { state: "syncing" } });
    });
    expect(scanCount()).toBe(before);

    await act(async () => {
      fire({ root_id: "A", state: { state: "synced" } });
    });
    expect(scanCount()).toBe(before + 1);
  });

  it("rescans on window focus, picking up notes created out of band", async () => {
    const { result } = renderHook(() => useNoteLinks("A"));
    await waitFor(() => expect(result.current.linkableNotes).toHaveLength(1));
    const scanCount = () => invoke.mock.calls.filter(([command]) => command === "scan_links").length;
    const before = scanCount();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(scanCount()).toBe(before + 1);
  });

  it("stops rescanning on focus once unmounted", async () => {
    const { result, unmount } = renderHook(() => useNoteLinks("A"));
    await waitFor(() => expect(result.current.linkableNotes).toHaveLength(1));
    const scanCount = () => invoke.mock.calls.filter(([command]) => command === "scan_links").length;

    unmount();
    const after = scanCount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(scanCount()).toBe(after);
  });
});
