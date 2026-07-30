import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function mockInvoke(overrides: Record<string, unknown> = {}) {
  invoke.mockImplementation((command: string, args?: unknown) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Promise ? value : Promise.resolve(value);
    }
    if (command === "open_note") {
      return Promise.resolve({ content: "# Loaded\n", id: "01LOADED", is_conflicted: false });
    }
    if (command === "save_note") {
      return Promise.resolve(undefined);
    }
    throw new Error(`unexpected command ${command} with args ${JSON.stringify(args)}`);
  });
}

describe("NoteEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke();
  });

  it("loads the note's content via open_note and renders it in the editor", async () => {
    render(<NoteEditor rootId="01ROOT" path="note.md" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    expect(await screen.findByText("# Loaded")).toBeDefined();
  });

  it("renders exactly one CodeMirror editor instance", async () => {
    const { container } = render(<NoteEditor rootId="01ROOT" path="note.md" />);

    await screen.findByText("# Loaded");

    expect(container.querySelectorAll(".cm-editor").length).toBe(1);
  });

  it("autosaves edited content to the correct file after the user stops typing", async () => {
    const user = userEvent.setup();

    render(<NoteEditor rootId="01ROOT" path="note.md" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    await screen.findByText("# Loaded");

    const editable = await screen.findByRole("textbox");
    await user.click(editable);
    await user.keyboard(" edited");

    expect(invoke).not.toHaveBeenCalledWith("save_note", expect.anything());

    await waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith("save_note", {
          rootId: "01ROOT",
          path: "note.md",
          content: expect.stringContaining("edited"),
        }),
      { timeout: 2000 },
    );
  });

  it("flushes a pending save for the previous note before switching to a new one", async () => {
    const user = userEvent.setup();

    const { rerender } = render(<NoteEditor rootId="01ROOT" path="first.md" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "first.md" }));
    await screen.findByText("# Loaded");

    const editable = await screen.findByRole("textbox");
    await user.click(editable);
    await user.keyboard(" edited");

    rerender(<NoteEditor rootId="01ROOT" path="second.md" />);

    expect(invoke).toHaveBeenCalledWith("save_note", {
      rootId: "01ROOT",
      path: "first.md",
      content: expect.stringContaining("edited"),
    });
    expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "second.md" });
  });

  it("toggles to the rendered view and back without losing unsaved edits", async () => {
    const user = userEvent.setup();

    render(<NoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByText("# Loaded");

    const editable = await screen.findByRole("textbox");
    await user.click(editable);
    await user.keyboard(" unsaved-edit");

    await user.click(screen.getByRole("button", { name: /preview/i }));

    const noteView = await screen.findByTestId("note-view");
    expect(noteView.textContent).toContain("unsaved-edit");
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: /edit/i }));

    const editableAgain = await screen.findByRole("textbox");
    expect(editableAgain.textContent).toContain("unsaved-edit");
  });

  it("moves the cursor to scrollToOffset once content has loaded", async () => {
    mockInvoke({ open_note: { content: "one\ntwo\nthree\n", id: "01LOADED", is_conflicted: false } });

    render(<NoteEditor rootId="01ROOT" path="note.md" scrollToOffset={5} />);
    await screen.findByText("two");

    await screen.findByRole("textbox");
    // CodeMirror focuses the editor as part of placing the cursor.
    expect(document.activeElement?.className).toContain("cm-content");
  });

  it("re-applies a new scrollToOffset while the same note stays open", async () => {
    const { rerender } = render(<NoteEditor rootId="01ROOT" path="note.md" scrollToOffset={0} />);
    await screen.findByText("# Loaded");

    rerender(<NoteEditor rootId="01ROOT" path="note.md" scrollToOffset={5} />);

    // No crash / no re-fetch of open_note for the same note+path.
    expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("hides the formatting toolbar while in the rendered view", async () => {
    const user = userEvent.setup();

    render(<NoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByText("# Loaded");

    expect(screen.getByTestId("note-toolbar")).toBeDefined();

    await user.click(screen.getByRole("button", { name: /preview/i }));

    expect(screen.queryByTestId("note-toolbar")).toBeNull();
  });
});
