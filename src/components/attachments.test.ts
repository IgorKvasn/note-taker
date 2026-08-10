import { describe, expect, it } from "vitest";
import { attachmentTarget, formatAttachment } from "./attachments";

describe("attachmentTarget", () => {
  it("returns the ULID for an attachment: src", () => {
    expect(attachmentTarget("attachment:01ABC")).toBe("01ABC");
  });

  it.each([undefined, "", "https://example.com", "./relative.png", "note:01ABC"])(
    "returns null for %s",
    (src) => {
      expect(attachmentTarget(src)).toBeNull();
    },
  );

  it("returns null for a bare attachment: src with no id", () => {
    expect(attachmentTarget("attachment:")).toBeNull();
  });
});

describe("formatAttachment", () => {
  it("builds an attachment: markdown image", () => {
    expect(formatAttachment("image", "01ABC")).toBe("![image](attachment:01ABC)");
  });
});
