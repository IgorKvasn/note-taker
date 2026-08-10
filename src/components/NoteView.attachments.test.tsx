import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BROKEN_ATTACHMENT_TITLE } from "./attachments";
import { NoteView } from "./NoteView";

describe("NoteView attachment: images", () => {
  it("renders the resolved blob: URL as the image src", () => {
    const { container } = render(
      <NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => "blob:mock-url"} />,
    );

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("blob:mock-url");
    expect(img?.getAttribute("alt")).toBe("alt");
  });

  it("renders a loading placeholder, no title, while resolution is in flight", () => {
    const { container } = render(
      <NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => undefined} />,
    );

    expect(container.querySelector("img")).toBeNull();
    const placeholder = container.querySelector(".note-view__attachment-placeholder--loading");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("title")).toBeNull();
  });

  it("renders a distinct broken placeholder with a title tooltip when the attachment is missing", () => {
    render(<NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => null} />);

    const broken = screen.getByTestId("broken-attachment");
    expect(broken.className).toContain("note-view__attachment-placeholder--broken");
    expect(broken.getAttribute("title")).toBe(BROKEN_ATTACHMENT_TITLE);
  });

  it("treats a missing attachment differently from a missing resolveAttachment prop, both rendering broken", () => {
    render(<NoteView content="![alt](attachment:01ABC)" />);

    expect(screen.getByTestId("broken-attachment")).toBeDefined();
  });

  it("leaves an ordinary http(s) image src untouched", () => {
    const { container } = render(<NoteView content="![alt](https://example.com/pic.png)" />);

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/pic.png");
    expect(screen.queryByTestId("broken-attachment")).toBeNull();
  });

  it("strips an attachment: href from a link instead of allowing it through", () => {
    const { container } = render(<NoteView content="[text](attachment:01ABC)" resolveAttachment={() => "blob:x"} />);

    const link = container.querySelector("a");
    expect(link === null || link.getAttribute("href") === null).toBe(true);
  });
});
