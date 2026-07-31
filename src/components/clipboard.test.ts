import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves when navigator.clipboard.writeText succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("rejects when navigator.clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("hello")).rejects.toThrow("denied");
  });

  it("rejects when navigator.clipboard is absent", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyToClipboard("hello")).rejects.toThrow();
  });
});
