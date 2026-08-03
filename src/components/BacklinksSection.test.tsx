import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BacklinksSection } from "./BacklinksSection";
import type { BacklinkEntry } from "../hooks/useNoteLinks";

function entry(overrides: Partial<BacklinkEntry> = {}): BacklinkEntry {
  return {
    path: "folder/note.md",
    title: "note",
    directory_path: "folder",
    ...overrides,
  };
}

describe("BacklinksSection", () => {
  it("shows the count in the header", () => {
    render(<BacklinksSection entries={[entry(), entry({ path: "b.md", title: "b" })]} onSelect={() => {}} />);

    expect(screen.getByText("Linked from (2)")).toBeDefined();
  });

  it("renders one row per entry with title and directory_path", () => {
    render(<BacklinksSection entries={[entry()]} onSelect={() => {}} />);

    expect(screen.getByText("note")).toBeDefined();
    expect(screen.getByText("folder")).toBeDefined();
  });

  it("omits the location line for a root-level linking note", () => {
    render(<BacklinksSection entries={[entry({ directory_path: "" })]} onSelect={() => {}} />);

    expect(screen.queryByText("folder")).toBeNull();
  });

  it("calls onSelect with the clicked entry's path", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<BacklinksSection entries={[entry()]} onSelect={onSelect} />);
    await user.click(screen.getByText("note"));

    expect(onSelect).toHaveBeenCalledWith("folder/note.md");
  });

  it("collapses and expands the list on header click", async () => {
    const user = userEvent.setup();
    render(<BacklinksSection entries={[entry()]} onSelect={() => {}} />);

    const header = screen.getByText(/linked from/i);
    expect(screen.getByText("note")).toBeDefined();

    await user.click(header);
    expect(screen.queryByText("note")).toBeNull();

    await user.click(header);
    expect(screen.getByText("note")).toBeDefined();
  });
});
