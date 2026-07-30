import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { NoteToolbar } from "./NoteToolbar";

describe("NoteToolbar", () => {
  it("renders all 16 buttons across 4 groups with dividers", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "hello" }) });

    render(<NoteToolbar view={view} />);

    expect(screen.getAllByRole("button")).toHaveLength(16);
    expect(screen.getByTestId("note-toolbar").querySelectorAll(".note-toolbar__group")).toHaveLength(4);

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
});
