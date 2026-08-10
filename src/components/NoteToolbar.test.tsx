import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { NoteToolbar } from "./NoteToolbar";

describe("NoteToolbar", () => {
  it("renders all 17 buttons across 5 groups with dividers", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "hello" }) });

    render(<NoteToolbar view={view} />);

    expect(screen.getAllByRole("button")).toHaveLength(17);
    expect(screen.getByTestId("note-toolbar").querySelectorAll(".note-toolbar__group")).toHaveLength(5);

    view.destroy();
  });

  it("dispatches into the editor when a button is clicked", async () => {
    const user = userEvent.setup();
    const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 0, head: 5 } }) });

    render(<NoteToolbar view={view} />);

    await user.click(screen.getByTitle("Bold (Ctrl/Cmd+B)"));

    expect(view.state.doc.toString()).toBe("**hello**");

    view.destroy();
  });

  it("leaves the ordinary link button inserting a plain url placeholder", async () => {
    const user = userEvent.setup();
    const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 0, head: 5 } }) });

    render(<NoteToolbar view={view} />);

    await user.click(screen.getByTitle("Link (Ctrl/Cmd+K)"));

    expect(view.state.doc.toString()).toBe("[hello](url)");

    view.destroy();
  });

  describe("image attach button", () => {
    it("calls onAttachImage instead of dispatching into the editor", async () => {
      const user = userEvent.setup();
      const onAttachImage = vi.fn();
      const view = new EditorView({ state: EditorState.create({ doc: "hello" }) });

      render(<NoteToolbar view={view} onAttachImage={onAttachImage} />);
      await user.click(screen.getByTitle("Image"));

      expect(onAttachImage).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe("hello");

      view.destroy();
    });

    it("is disabled while isAttaching is true, even with a view", () => {
      const view = new EditorView({ state: EditorState.create({ doc: "hello" }) });

      render(<NoteToolbar view={view} isAttaching />);

      expect(screen.getByTitle("Image").hasAttribute("disabled")).toBe(true);

      view.destroy();
    });
  });

  describe("note link picker", () => {
    const notes = [
      { id: "01ALPHA", path: "alpha.md", directory_path: "", title: "alpha" },
      { id: "01BETA", path: "projects/beta.md", directory_path: "projects", title: "beta" },
    ];

    it("inserts a note link at the cursor for the picked note", async () => {
      const user = userEvent.setup();
      const view = new EditorView({ state: EditorState.create({ doc: "" }) });

      render(<NoteToolbar view={view} linkableNotes={notes} />);
      await user.click(screen.getByTitle("Link to note"));
      await user.click(screen.getByText("beta"));

      expect(view.state.doc.toString()).toBe("[beta](note:01BETA)");
      expect(screen.queryByTestId("note-link-picker-results")).toBeNull();

      view.destroy();
    });

    it("uses the selection as the label rather than the note's title", async () => {
      const user = userEvent.setup();
      const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 0, head: 5 } }) });

      render(<NoteToolbar view={view} linkableNotes={notes} />);
      await user.click(screen.getByTitle("Link to note"));
      await user.click(screen.getByText("beta"));

      expect(view.state.doc.toString()).toBe("[hello](note:01BETA)");

      view.destroy();
    });

    it("leaves the document untouched when the picker is dismissed", async () => {
      const user = userEvent.setup();
      const view = new EditorView({ state: EditorState.create({ doc: "hello" }) });

      render(<NoteToolbar view={view} linkableNotes={notes} />);
      await user.click(screen.getByTitle("Link to note"));
      await user.keyboard("{Escape}");

      expect(view.state.doc.toString()).toBe("hello");
      expect(screen.queryByTestId("note-link-picker-results")).toBeNull();

      view.destroy();
    });
  });
});
