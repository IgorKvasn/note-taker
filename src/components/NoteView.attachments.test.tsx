import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BROKEN_ATTACHMENT_TITLE } from "./attachments";
import { NoteView } from "./NoteView";

describe("NoteView attachment: images", () => {
  it("renders a resolved attachment as an img with the resolver's returned URL", () => {
    const resolveAttachment = (id: string) => (id === "01ABC" ? "blob:mock-url" : null);
    render(<NoteView content="![alt](attachment:01ABC)" resolveAttachment={resolveAttachment} />);

    const img = screen.getByTestId("attachment");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("blob:mock-url");
    expect(img.getAttribute("alt")).toBe("alt");
  });

  it("renders a neutral, tooltip-less placeholder while resolution is in flight", () => {
    render(<NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => undefined} />);

    const placeholder = screen.getByTestId("loading-attachment");
    expect(placeholder.getAttribute("title")).toBeNull();
    expect(screen.queryByTestId("broken-attachment")).toBeNull();
    expect(screen.queryByTestId("attachment")).toBeNull();
  });

  it("renders a distinctly-styled broken placeholder with a tooltip when the attachment is missing", () => {
    render(<NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => null} />);

    const broken = screen.getByTestId("broken-attachment");
    expect(broken.tagName).not.toBe("IMG");
    expect(broken.getAttribute("title")).toBe(BROKEN_ATTACHMENT_TITLE);
    expect(broken.className).not.toBe("note-view__broken-link");
  });

  it("renders an attachment as broken when no resolveAttachment prop is passed", () => {
    render(<NoteView content="![alt](attachment:01ABC)" />);

    expect(screen.getByTestId("broken-attachment")).toBeDefined();
  });

  it("keeps the attachment: src through sanitization, proving the sanitize schema allows it on src", () => {
    render(<NoteView content="![alt](attachment:01ABC)" resolveAttachment={() => "blob:mock-url"} />);

    expect(screen.getByTestId("attachment")).toBeDefined();
  });

  it("strips an attachment: href from a link instead of allowing it through", () => {
    const { container } = render(<NoteView content="[text](attachment:01ABC)" />);

    const link = container.querySelector("a");
    expect(link === null || link.getAttribute("href") === null).toBe(true);
  });

  it("leaves an ordinary https image src untouched", () => {
    render(<NoteView content="![alt](https://example.com/pic.png)" />);

    const img = screen.getByAltText("alt");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("https://example.com/pic.png");
  });
});
