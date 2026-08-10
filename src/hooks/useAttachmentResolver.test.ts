import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentResolver } from "./useAttachmentResolver";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("useAttachmentResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  it("returns undefined on first call and issues a read_attachment IPC call", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAttachmentResolver("root-1"));

    const resolved = result.current("01ABC");

    expect(resolved).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("read_attachment", { rootId: "root-1", id: "01ABC" });
  });

  it("resolves to a cached blob: URL once the IPC call succeeds", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result } = renderHook(() => useAttachmentResolver("root-1"));

    act(() => {
      result.current("01ABC");
    });

    await waitFor(() => expect(result.current("01ABC")).toBe("blob:mock-url"));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not re-issue an IPC call for an id already cached", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result } = renderHook(() => useAttachmentResolver("root-1"));

    act(() => {
      result.current("01ABC");
    });
    await waitFor(() => expect(result.current("01ABC")).toBe("blob:mock-url"));

    result.current("01ABC");

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("resolves to null once the IPC call rejects", async () => {
    invoke.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useAttachmentResolver("root-1"));

    act(() => {
      result.current("01MISSING");
    });

    await waitFor(() => expect(result.current("01MISSING")).toBeNull());
  });

  it("revokes cached blob URLs and refetches when the root changes", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result, rerender } = renderHook(({ rootId }) => useAttachmentResolver(rootId), {
      initialProps: { rootId: "root-1" },
    });

    act(() => {
      result.current("01ABC");
    });
    await waitFor(() => expect(result.current("01ABC")).toBe("blob:mock-url"));

    rerender({ rootId: "root-2" });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    expect(result.current("01ABC")).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("read_attachment", { rootId: "root-2", id: "01ABC" });
  });

  it("revokes all cached blob URLs on unmount", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result, unmount } = renderHook(() => useAttachmentResolver("root-1"));

    act(() => {
      result.current("01ABC");
    });
    await waitFor(() => expect(result.current("01ABC")).toBe("blob:mock-url"));

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("ignores a stale resolution that lands after the root has already changed", async () => {
    let resolvePending: (bytes: ArrayBuffer) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolvePending = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ rootId }) => useAttachmentResolver(rootId), {
      initialProps: { rootId: "root-1" },
    });

    act(() => {
      result.current("01ABC");
    });

    rerender({ rootId: "root-2" });

    await act(async () => {
      resolvePending(new ArrayBuffer(4));
      await Promise.resolve();
    });

    expect(result.current("01ABC")).toBeUndefined();
  });
});
