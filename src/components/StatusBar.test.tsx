import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RootConfig } from "../ipc";
import { StatusBar } from "./StatusBar";

const ROOT: RootConfig = { id: "01ROOT", path: "/home/user/notes", auto_sync: false, remote_url: "", sync_debounce_secs: 5 };

describe("StatusBar", () => {
  it("renders the root label and path for the open note", () => {
    render(<StatusBar root={ROOT} path="folder/note.md" content="" />);

    expect(screen.getByText("notes / folder/note.md")).toBeDefined();
  });

  it("renders a blank location when no note is open", () => {
    const { container } = render(<StatusBar root={null} path={null} content={null} />);

    expect(container.querySelector(".status-bar__location")?.textContent).toBe("");
  });

  it("has no title tooltip when no note is open", () => {
    const { container } = render(<StatusBar root={null} path={null} content={null} />);

    expect(container.querySelector(".status-bar__location")?.getAttribute("title")).toBeNull();
  });

  it("puts the full root/path string in the title tooltip", () => {
    render(<StatusBar root={ROOT} path="deeply/nested/folder/note.md" content="" />);

    expect(screen.getByTitle("notes / deeply/nested/folder/note.md")).toBeDefined();
  });

  it("renders the live word count for the open note", () => {
    render(<StatusBar root={ROOT} path="folder/note.md" content="one two three" />);

    expect(screen.getByText("3 words")).toBeDefined();
  });

  it("renders a blank word count when no note is open", () => {
    const { container } = render(<StatusBar root={null} path={null} content={null} />);

    expect(container.querySelector(".status-bar__wordcount")?.textContent).toBe("");
  });

  it("updates the word count when the content prop changes", () => {
    const { rerender } = render(<StatusBar root={ROOT} path="folder/note.md" content="one two" />);
    expect(screen.getByText("2 words")).toBeDefined();

    rerender(<StatusBar root={ROOT} path="folder/note.md" content="one two three four" />);
    expect(screen.getByText("4 words")).toBeDefined();
  });
});
