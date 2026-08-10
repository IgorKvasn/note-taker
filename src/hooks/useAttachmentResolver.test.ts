import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentResolver } from "./useAttachmentResolver";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const createObjectURL = vi.hoisted(() => vi.fn());
const revokeObjectURL = vi.hoisted(() => vi.fn());

describe("useAttachmentResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let nextUrl = 0;
    createObjectURL.mockImplementation(() => `blob:mock-${nextUrl++}`);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("returns undefined (loading) on the first call, then the resolved blob URL", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result } = renderHook(() => useAttachmentResolver("root-a"));

    expect(result.current.resolveAttachment("01ABC")).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("read_attachment", { rootId: "root-a", id: "01ABC" });

    await waitFor(() => expect(result.current.resolveAttachment("01ABC")).toBe("blob:mock-0"));
  });

  it("does not invoke a second read while the first is still in flight", () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useAttachmentResolver("root-a"));

    result.current.resolveAttachment("01ABC");
    result.current.resolveAttachment("01ABC");

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("caches the resolved URL, never re-invoking for the same id", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result } = renderHook(() => useAttachmentResolver("root-a"));

    result.current.resolveAttachment("01ABC");
    await waitFor(() => expect(result.current.resolveAttachment("01ABC")).toBe("blob:mock-0"));

    result.current.resolveAttachment("01ABC");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("resolves to null when the read fails, and does not retry on a later call", async () => {
    invoke.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useAttachmentResolver("root-a"));

    result.current.resolveAttachment("01ABC");
    await waitFor(() => expect(result.current.resolveAttachment("01ABC")).toBeNull());

    result.current.resolveAttachment("01ABC");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns null immediately when there is no open root", () => {
    const { result } = renderHook(() => useAttachmentResolver(null));

    expect(result.current.resolveAttachment("01ABC")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("revokes every cached URL and stops resolving them when the root changes", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(4));
    const { result, rerender } = renderHook(({ rootId }) => useAttachmentResolver(rootId), {
      initialProps: { rootId: "root-a" as string | null },
    });
    result.current.resolveAttachment("01ABC");
    await waitFor(() => expect(result.current.resolveAttachment("01ABC")).toBe("blob:mock-0"));

    rerender({ rootId: "root-b" });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    // The old root's id is not carried over into the new root's cache.
    invoke.mockImplementation(() => new Promise(() => {}));
    expect(result.current.resolveAttachment("01ABC")).toBeUndefined();
  });
});
