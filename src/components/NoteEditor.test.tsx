import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";
import type { SyncStatusEvent } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

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
    if (command === "mark_resolved") {
      return Promise.resolve(undefined);
    }
    throw new Error(`unexpected command ${command} with args ${JSON.stringify(args)}`);
  });
}

/** Fires a `sync-status` event through whichever handler NoteEditor registered. */
async function emitSyncStatus(payload: SyncStatusEvent) {
  await waitFor(() => expect(listen).toHaveBeenCalled());
  const handler = listen.mock.calls[0][1] as (event: { payload: SyncStatusEvent }) => void;
  handler({ payload });
}

describe("NoteEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke();
    listen.mockResolvedValue(() => {});
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

  describe("conflict resolution", () => {
    it("shows a Mark resolved button when the note is conflicted", async () => {
      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });

      render(<NoteEditor rootId="01ROOT" path="note.md" />);

      expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("does not show a Mark resolved button when the note is not conflicted", async () => {
      render(<NoteEditor rootId="01ROOT" path="note.md" />);

      await screen.findByText("# Loaded");

      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();
    });

    it("calls mark_resolved with the root and path when clicked, clearing the conflict on success", async () => {
      const user = userEvent.setup();
      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });

      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      const resolveButton = await screen.findByRole("button", { name: /mark resolved/i });

      await user.click(resolveButton);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("mark_resolved", { rootId: "01ROOT", path: "note.md" }),
      );
      await waitFor(() => expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull());
    });

    it("shows an inline error and keeps the button when mark_resolved rejects", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true });
        }
        if (command === "mark_resolved") {
          return Promise.reject(new Error("this note still has unresolved conflict markers"));
        }
        return Promise.resolve(undefined);
      });

      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      const resolveButton = await screen.findByRole("button", { name: /mark resolved/i });

      await user.click(resolveButton);

      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("unresolved conflict markers"),
      );
      expect(screen.getByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("re-fetches open_note when a sync-status event for its root settles, picking up new conflict markers", async () => {
      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("# Loaded");
      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();

      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });
      await emitSyncStatus({ root_id: "01ROOT", state: { state: "conflict" } });

      expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("ignores sync-status events for a different root", async () => {
      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("# Loaded");
      invoke.mockClear();

      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });
      await emitSyncStatus({ root_id: "some-other-root", state: { state: "conflict" } });

      expect(invoke).not.toHaveBeenCalledWith("open_note", expect.anything());
      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();
    });

    it("does not re-fetch while the sync-status event reports syncing", async () => {
      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("# Loaded");
      invoke.mockClear();

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "syncing" } });

      expect(invoke).not.toHaveBeenCalledWith("open_note", expect.anything());
    });

    it("does not let a stale sync-status listener from a previous note overwrite the newly-opened note", async () => {
      invoke.mockImplementation((command: string, args?: unknown) => {
        if (command === "open_note") {
          const openArgs = args as { path: string };
          if (openArgs.path === "old.md") {
            return Promise.resolve({ content: "CONTENT OF old.md", id: "01OLD", is_conflicted: false });
          }
          return Promise.resolve({ content: "CONTENT OF new.md", id: "01NEW", is_conflicted: false });
        }
        return Promise.resolve(undefined);
      });

      const { rerender } = render(<NoteEditor rootId="01ROOT" path="old.md" />);
      await screen.findByText("CONTENT OF old.md");

      rerender(<NoteEditor rootId="01ROOT" path="new.md" />);
      await screen.findByText("CONTENT OF new.md");

      // The listener registered while "old.md" was open should have been torn
      // down on unmount; firing its handler directly (as if it raced the
      // cleanup) must not resurrect old.md's content into the new note.
      const staleHandler = listen.mock.calls[0][1] as (event: { payload: SyncStatusEvent }) => void;
      staleHandler({ payload: { root_id: "01ROOT", state: { state: "synced" } } });

      await waitFor(() => expect(screen.queryByText("CONTENT OF old.md")).toBeNull());
      expect(screen.getByText("CONTENT OF new.md")).toBeDefined();
      expect(invoke).not.toHaveBeenCalledWith(
        "save_note",
        expect.objectContaining({ path: "new.md", content: expect.stringContaining("old.md") }),
      );
    });

    it("does not clobber an in-flight unsaved edit when a terminal sync-status event arrives", async () => {
      const user = userEvent.setup();

      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("# Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" MYNEWTEXT");
      await screen.findByText(/MYNEWTEXT/);

      // Still inside the debounce window -- the edit hasn't been sent yet.
      expect(invoke).not.toHaveBeenCalledWith("save_note", expect.anything());

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced" } });

      // The typed text must survive: no overwrite from stale disk content,
      // and no save of anything other than what the user actually typed.
      expect(screen.getByText(/MYNEWTEXT/)).toBeDefined();
      expect(invoke).not.toHaveBeenCalledWith(
        "save_note",
        expect.objectContaining({ content: expect.not.stringContaining("MYNEWTEXT") }),
      );
    });

    it("flushes a pending autosave before calling mark_resolved so the just-cleaned content is what gets read", async () => {
      const user = userEvent.setup();
      mockInvoke({ open_note: { content: "<<<<<<< HEAD\nstuff\n=======\n", id: "01LOADED", is_conflicted: true } });

      render(<NoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" resolved-by-hand");

      // Still inside the debounce window.
      expect(invoke).not.toHaveBeenCalledWith("save_note", expect.anything());

      const resolveButton = await screen.findByRole("button", { name: /mark resolved/i });
      await user.click(resolveButton);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("save_note", {
          rootId: "01ROOT",
          path: "note.md",
          content: expect.stringContaining("resolved-by-hand"),
        }),
      );
      const saveCallOrder = invoke.mock.calls.findIndex((call) => call[0] === "save_note");
      const markResolvedCallOrder = invoke.mock.calls.findIndex((call) => call[0] === "mark_resolved");
      expect(saveCallOrder).toBeGreaterThanOrEqual(0);
      expect(markResolvedCallOrder).toBeGreaterThan(saveCallOrder);
    });
  });
});
