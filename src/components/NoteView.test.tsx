import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteView } from "./NoteView";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("NoteView", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    openUrl.mockClear();
  });

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

  describe("copying a selection that ends in the next table cell", () => {
    const table = "| A | B |\n| --- | --- |\n| abc123 | xyz789 |\n| next | row |";

    /** Selects from the start of `fromCell`'s text to `toNode`:`toOffset` and fires a copy. */
    function copySelection(fromCell: Element, toNode: Node, toOffset: number) {
      const range = document.createRange();
      range.setStart(fromCell.firstChild!, 0);
      range.setEnd(toNode, toOffset);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const setData = vi.fn();
      const notCancelled = fireEvent.copy(fromCell, { clipboardData: { setData } });
      return { setData, notCancelled };
    }

    // WebKit's triple-click ends the range at offset 0 of the next cell (or row), and
    // its plain-text serializer then appends a "\t" (or "\n") the user never saw.
    it("copies only the cell's text when the range ends at the start of the next cell", () => {
      const { container } = render(<NoteView content={table} />);
      const [cell, nextCell] = Array.from(container.querySelectorAll("td"));

      const { setData, notCancelled } = copySelection(cell, nextCell, 0);

      expect(notCancelled).toBe(false);
      expect(setData).toHaveBeenCalledWith("text/plain", "abc123");
    });

    it("copies only the cell's text when the range ends at the start of the next row", () => {
      const { container } = render(<NoteView content={table} />);
      const cells = Array.from(container.querySelectorAll("td"));

      const { setData } = copySelection(cells[1], cells[2], 0);

      expect(setData).toHaveBeenCalledWith("text/plain", "xyz789");
    });

    it("leaves a selection that really spans several cells to the browser", () => {
      const { container } = render(<NoteView content={table} />);
      const [cell, nextCell] = Array.from(container.querySelectorAll("td"));

      const { setData, notCancelled } = copySelection(cell, nextCell.firstChild!, 3);

      expect(notCancelled).toBe(true);
      expect(setData).not.toHaveBeenCalled();
    });
  });

  it("opens an external link in the OS browser instead of navigating the webview", () => {
    const { container } = render(<NoteView content="[example](https://example.com)" />);

    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();

    const event = fireEvent.click(link as Element);

    expect(event).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("syntax-highlights fenced code blocks", () => {
    const markdown = ["```js", "const x = 1;", "```"].join("\n");

    const { container } = render(<NoteView content={markdown} />);

    expect(container.querySelector("code.language-js")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("renders a copy button for a fenced code block", () => {
    const markdown = ["```js", "const x = 1;", "```"].join("\n");

    render(<NoteView content={markdown} />);

    expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
  });

  it("renders a copy button for a blockquote, including nested ones", () => {
    const markdown = "> outer\n> > inner";

    render(<NoteView content={markdown} />);

    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("copies the bare code text (no fences, no language tag) when the code block's copy button is clicked", async () => {
    const markdown = ["```js", "const x = 1;", "```"].join("\n");
    render(<NoteView content={markdown} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const x = 1;");
    });
  });

  it("copies quote prose without `>` or `**` markers when the blockquote's copy button is clicked", async () => {
    const markdown = "> Hello **world**";
    render(<NoteView content={markdown} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello world");
    });
  });

  it("does not leak a nested blockquote's own copy button label into the outer blockquote's copied text", async () => {
    const markdown = "> outer\n> > inner";
    render(<NoteView content={markdown} />);

    // The nested blockquote's button precedes the outer's in DOM order, since it's
    // nested inside the outer's content wrapper, which itself precedes the outer's button.
    const [, outerButton] = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(outerButton);

    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("outer\n\ninner");
    });
  });

  it("shows a success toast after a copy", async () => {
    const markdown = ["```js", "const x = 1;", "```"].join("\n");
    render(<NoteView content={markdown} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect((await screen.findByRole("status")).textContent).toBe("Copied to clipboard");
  });
});
