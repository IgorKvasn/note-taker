import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BROKEN_NOTE_LINK_TITLE } from "./noteLinks";
import { NoteView } from "./NoteView";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

describe("NoteView note: links", () => {
  it("calls onOpenNoteLink with the resolved path when a resolvable note: link is clicked", () => {
    const onOpenNoteLink = vi.fn();
    const resolveNoteLink = (id: string) => (id === "01ABC" ? "projects/target.md" : null);
    render(
      <NoteView
        content="[Target](note:01ABC)"
        resolveNoteLink={resolveNoteLink}
        onOpenNoteLink={onOpenNoteLink}
      />,
    );

    const link = screen.getByTestId("note-link");
    expect(link.tagName).toBe("A");
    fireEvent.click(link);

    expect(onOpenNoteLink).toHaveBeenCalledWith("projects/target.md");
  });

  it("renders an unresolvable note: link inert, with the broken-link title, and does not call onOpenNoteLink when clicked", () => {
    const onOpenNoteLink = vi.fn();
    render(
      <NoteView content="[Target](note:01ABC)" resolveNoteLink={() => null} onOpenNoteLink={onOpenNoteLink} />,
    );

    const brokenLink = screen.getByTestId("broken-note-link");
    expect(brokenLink.tagName).not.toBe("A");
    expect(brokenLink.getAttribute("title")).toBe(BROKEN_NOTE_LINK_TITLE);

    fireEvent.click(brokenLink);

    expect(onOpenNoteLink).not.toHaveBeenCalled();
  });

  it("renders a note: link as broken when no resolveNoteLink prop is passed", () => {
    render(<NoteView content="[Target](note:01ABC)" />);

    expect(screen.getByTestId("broken-note-link")).toBeDefined();
    expect(screen.queryByTestId("note-link")).toBeNull();
  });

  it("leaves an ordinary https link as a normal anchor and does not call onOpenNoteLink when clicked", () => {
    const onOpenNoteLink = vi.fn();
    render(<NoteView content="[Example](https://example.com)" onOpenNoteLink={onOpenNoteLink} />);

    const link = screen.getByText("Example");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com");

    fireEvent.click(link);

    expect(onOpenNoteLink).not.toHaveBeenCalled();
  });

  it("keeps the note: href through sanitization, proving the sanitize schema allows the protocol", () => {
    render(<NoteView content="[Target](note:01ABC)" resolveNoteLink={() => "projects/target.md"} />);

    expect(screen.getByTestId("note-link")).toBeDefined();
  });

  it("strips a note: src from an image instead of allowing it through", () => {
    const { container } = render(<NoteView content="![alt](note:01ABC)" resolveNoteLink={() => "x"} />);

    const img = container.querySelector("img");
    expect(img === null || img.getAttribute("src") === null).toBe(true);
  });

  it("renders the link label text as authored", () => {
    render(<NoteView content="[My Note Title](note:01ABC)" resolveNoteLink={() => "projects/target.md"} />);

    expect(screen.getByText("My Note Title")).toBeDefined();
  });

  it("keeps the aria and footnote attributes GFM puts on ordinary links", () => {
    const { container } = render(<NoteView content={"Text with a footnote[^1]\n\n[^1]: The note.\n"} />);

    const backref = container.querySelector("a[data-footnote-backref]");
    expect(backref).not.toBeNull();
    expect(backref?.getAttribute("aria-label")).toBe("Back to reference 1");
  });
});
