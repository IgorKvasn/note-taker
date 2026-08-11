import { describe, expect, it } from "vitest";
import { countWords } from "./StatusBar";

describe("countWords", () => {
  it("returns 0 for an empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for a whitespace-only string", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("returns 1 for a single word", () => {
    expect(countWords("hello")).toBe(1);
  });

  it("collapses repeated spaces and newlines between words", () => {
    expect(countWords("one   two\n\nthree\tfour")).toBe(4);
  });

  it("ignores leading and trailing whitespace", () => {
    expect(countWords("  one two  ")).toBe(2);
  });

  // Deliberate inaccuracy: this is a naive whitespace split over raw
  // markdown, not the rendered text. Stripping markdown syntax properly would
  // mean running the content through the markdown pipeline for a number
  // nobody reads to that precision, so markdown tokens count as words.
  it("counts markdown heading markers as words", () => {
    expect(countWords("## Heading")).toBe(2);
  });

  it("counts table row pipes as words", () => {
    expect(countWords("| a | b |")).toBe(5);
  });
});
