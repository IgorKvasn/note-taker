import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LinkedNote } from "../ipc";
import { NoteLinkPicker } from "./NoteLinkPicker";

const noteAt = (id: string, title: string, directory_path: string, path: string): LinkedNote => ({
  id,
  title,
  directory_path,
  path,
});

describe("NoteLinkPicker", () => {
  it("renders every note when the filter is empty, showing title and directory_path", () => {
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md"), noteAt("01B", "Beta", "notes", "notes/beta.md")];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.getByText("projects")).toBeDefined();
    expect(screen.getByText("Beta")).toBeDefined();
    expect(screen.getByText("notes")).toBeDefined();
  });

  it("filters on title case-insensitively", async () => {
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md"), noteAt("01B", "Beta", "notes", "notes/beta.md")];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Filter notes"), "ALPHA");

    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("filters on folder path even when the title does not match", async () => {
    const notes = [
      noteAt("01A", "Alpha", "projects/archive", "projects/archive/alpha.md"),
      noteAt("01B", "Beta", "notes", "notes/beta.md"),
    ];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Filter notes"), "archive");

    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("requires all terms of a multi-term query to match", async () => {
    const notes = [
      noteAt("01A", "Beta", "projects/archive", "projects/archive/beta.md"),
      noteAt("01B", "Beta", "notes", "notes/beta.md"),
    ];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Filter notes"), "beta arch");

    expect(screen.getByText("projects/archive")).toBeDefined();
    expect(screen.queryByText("notes")).toBeNull();
  });

  it('shows "No matches" when nothing matches a non-empty filter', async () => {
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md")];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Filter notes"), "zzz");

    expect(screen.getByTestId("note-link-picker-empty").textContent).toBe("No matches");
  });

  it("shows a distinct empty-state message when there are no notes at all", () => {
    render(<NoteLinkPicker notes={[]} onSelect={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("note-link-picker-empty").textContent).toBe(
      "No notes with an ID yet. Open a note to give it one.",
    );
  });

  it("calls onSelect with the clicked note", async () => {
    const onSelect = vi.fn();
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md"), noteAt("01B", "Beta", "notes", "notes/beta.md")];
    render(<NoteLinkPicker notes={notes} onSelect={onSelect} onCancel={vi.fn()} />);

    await userEvent.click(screen.getByText("Beta"));

    expect(onSelect).toHaveBeenCalledWith(notes[1]);
  });

  it("selects the highlighted result on Enter, and the second after ArrowDown", async () => {
    const onSelect = vi.fn();
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md"), noteAt("01B", "Beta", "notes", "notes/beta.md")];
    const { rerender } = render(<NoteLinkPicker notes={notes} onSelect={onSelect} onCancel={vi.fn()} />);

    const input = screen.getByLabelText("Filter notes");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(notes[0]);

    onSelect.mockClear();
    rerender(<NoteLinkPicker notes={notes} onSelect={onSelect} onCancel={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("Filter notes"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("Filter notes"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(notes[1]);
  });

  it("does not let a shrinking result list leave the highlight past the end", async () => {
    const onSelect = vi.fn();
    const notes = [
      noteAt("01A", "Alpha", "projects", "projects/alpha.md"),
      noteAt("01B", "Beta", "notes", "notes/beta.md"),
      noteAt("01C", "Gamma beta", "archive", "archive/gamma.md"),
    ];
    render(<NoteLinkPicker notes={notes} onSelect={onSelect} onCancel={vi.fn()} />);

    const input = screen.getByLabelText("Filter notes");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    await userEvent.type(input, "beta notes");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(notes[1]);
  });

  it("calls onCancel on Escape", async () => {
    const onCancel = vi.fn();
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md")];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={onCancel} />);

    await userEvent.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when the backdrop is clicked", async () => {
    const onCancel = vi.fn();
    const notes = [noteAt("01A", "Alpha", "projects", "projects/alpha.md")];
    render(<NoteLinkPicker notes={notes} onSelect={vi.fn()} onCancel={onCancel} />);

    await userEvent.click(screen.getByTestId("note-link-picker-backdrop"));

    expect(onCancel).toHaveBeenCalled();
  });
});
