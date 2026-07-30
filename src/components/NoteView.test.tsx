import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteView } from "./NoteView";

describe("NoteView", () => {
  it("renders a raw script tag inert, without executing it", () => {
    const { container } = render(<NoteView content={'before\n\n<script>window.__pwned = true;</script>\n\nafter'} />);

    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(screen.getByText("before")).toBeDefined();
    expect(screen.getByText("after")).toBeDefined();
  });

  it("does not carry an onerror attribute onto any rendered element", () => {
    const { container } = render(<NoteView content={'<img src="x" onerror="window.__pwned = true">'} />);

    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("neutralizes a javascript: URL in a markdown link", () => {
    const { container } = render(<NoteView content="[click me](javascript:alert(1))" />);

    const link = container.querySelector("a");
    const href = link?.getAttribute("href") ?? null;
    expect(href === null || !/^javascript:/i.test(href)).toBe(true);
  });

  it("renders GFM tables, task lists, strikethrough and autolinks", () => {
    const markdown = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "~~gone~~",
      "",
      "https://example.com",
    ].join("\n");

    const { container } = render(<NoteView content={markdown} />);

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(container.querySelector("del")).not.toBeNull();
    const autolink = container.querySelector('a[href="https://example.com"]');
    expect(autolink).not.toBeNull();
  });

  it("syntax-highlights fenced code blocks", () => {
    const markdown = ["```js", "const x = 1;", "```"].join("\n");

    const { container } = render(<NoteView content={markdown} />);

    expect(container.querySelector("code.language-js")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });
});
