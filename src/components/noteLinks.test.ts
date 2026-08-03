import { describe, expect, it } from "vitest";
import { formatNoteLink, noteLinkTarget } from "./noteLinks";

describe("noteLinkTarget", () => {
  it("returns the ULID for a note: href", () => {
    expect(noteLinkTarget("note:01ABC")).toBe("01ABC");
  });

  it.each([undefined, "", "https://example.com", "./relative.md", "mailto:a@b.c"])(
    "returns null for %s",
    (href) => {
      expect(noteLinkTarget(href)).toBeNull();
    },
  );

  it("returns null for a bare note: href with no id", () => {
    expect(noteLinkTarget("note:")).toBeNull();
  });
});

describe("formatNoteLink", () => {
  it("builds a note: markdown link", () => {
    expect(formatNoteLink("Title", "01ABC")).toBe("[Title](note:01ABC)");
  });
});
