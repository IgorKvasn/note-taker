import { describe, expect, it } from "vitest";
import { firstFilePathFromUriList } from "./attachmentEntry";

describe("firstFilePathFromUriList", () => {
  it("extracts an absolute path from a file: URI", () => {
    expect(firstFilePathFromUriList("file:///home/user/picture.png")).toBe("/home/user/picture.png");
  });

  it("decodes percent-escaped characters", () => {
    expect(firstFilePathFromUriList("file:///home/user/my%20picture.png")).toBe("/home/user/my picture.png");
  });

  it("skips comment lines per RFC 2483", () => {
    expect(firstFilePathFromUriList("# a comment\r\nfile:///home/user/picture.png")).toBe(
      "/home/user/picture.png",
    );
  });

  it("returns null for a non-file URI", () => {
    expect(firstFilePathFromUriList("https://example.com/picture.png")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(firstFilePathFromUriList("")).toBeNull();
  });

  it("takes only the first entry when multiple URIs are listed", () => {
    expect(firstFilePathFromUriList("file:///a.png\r\nfile:///b.png")).toBe("/a.png");
  });
});
