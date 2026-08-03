import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";
import type { EditorMode, SyncStatusEvent } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

/**
 * Mirrors how `App.tsx` owns `mode` via `useUiState` (issue #37): `NoteEditor`
 * no longer holds edit/preview mode as local state, so tests need a stand-in
 * parent to supply and update it.
 */
function ControlledNoteEditor({
  initialMode = "edit",
  ...props
}: Omit<Parameters<typeof NoteEditor>[0], "mode" | "onModeChange"> & { initialMode?: EditorMode }) {
  const [mode, setMode] = useState<EditorMode>(initialMode);
  return <NoteEditor {...props} mode={mode} onModeChange={setMode} />;
}

function mockInvoke(overrides: Record<string, unknown> = {}) {
  invoke.mockImplementation((command: string, args?: unknown) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Promise ? value : Promise.resolve(value);
    }
    if (command === "open_note") {
      return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
    }
    if (command === "save_note") {
      return Promise.resolve(undefined);
    }
    if (command === "mark_resolved") {
      return Promise.resolve(undefined);
    }
    if (command === "scan_links") {
      return Promise.resolve({ notes: [], backlinks: {} });
    }
    throw new Error(`unexpected command ${command} with args ${JSON.stringify(args)}`);
  });
}

/**
 * Fires a `sync-status` event through every handler registered for it --
 * NoteEditor's own conflict re-fetch and `useNoteLinks`' re-scan both listen,
 * so picking a single call index would silently test the wrong subscriber.
 */
async function emitSyncStatus(payload: SyncStatusEvent) {
  await waitFor(() => expect(listen).toHaveBeenCalled());
  for (const [event, handler] of listen.mock.calls) {
    if (event === "sync-status") {
      (handler as (event: { payload: SyncStatusEvent }) => void)({ payload });
    }
  }
}

describe("NoteEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke();
    listen.mockResolvedValue(() => {});
  });

  it("loads the note's content via open_note and renders it in the editor", async () => {
    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    expect(await screen.findByText("Loaded")).toBeDefined();
  });

  it("renders exactly one CodeMirror editor instance", async () => {
    const { container } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

    await screen.findByText("Loaded");

    expect(container.querySelectorAll(".cm-editor").length).toBe(1);
  });

  it("applies bold formatting to the selection when Ctrl+B is pressed", async () => {
    const user = userEvent.setup();
    mockInvoke({ open_note: { content: "hello", id: "01LOADED", is_conflicted: false } });

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByText("hello");

    const editable = await screen.findByRole("textbox");
    await user.click(editable);
    await user.keyboard("{Control>}a{/Control}");
    await user.keyboard("{Control>}b{/Control}");

    await waitFor(() => expect(editable.textContent).toBe("**hello**"));
  });

  it("autosaves edited content to the correct file after the user stops typing", async () => {
    const user = userEvent.setup();

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    await screen.findByText("Loaded");

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

    const { rerender } = render(<ControlledNoteEditor rootId="01ROOT" path="first.md" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "first.md" }));
    await screen.findByText("Loaded");

    const editable = await screen.findByRole("textbox");
    await user.click(editable);
    await user.keyboard(" edited");

    rerender(<ControlledNoteEditor rootId="01ROOT" path="second.md" />);

    expect(invoke).toHaveBeenCalledWith("save_note", {
      rootId: "01ROOT",
      path: "first.md",
      content: expect.stringContaining("edited"),
    });
    expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "second.md" });
  });

  it("keeps rendering in the mode passed by its caller across a note switch, rather than resetting to edit (issue #37)", async () => {
    const onModeChange = vi.fn();
    const { rerender } = render(<NoteEditor rootId="01ROOT" path="first.md" mode="view" onModeChange={onModeChange} />);

    await screen.findByTestId("note-view");
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(<NoteEditor rootId="01ROOT" path="second.md" mode="view" onModeChange={onModeChange} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "second.md" }));

    expect(await screen.findByTestId("note-view")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: /edit/i })).toBeDefined();
  });

  it("toggles to the rendered view and back without losing unsaved edits", async () => {
    const user = userEvent.setup();

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByText("Loaded");

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

  it("keeps the mode-toggle button as the last chrome child regardless of mode or sibling count", async () => {
    const user = userEvent.setup();
    mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });

    const { container } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByRole("button", { name: /mark resolved/i });

    // Edit mode with a conflict: three chrome children (toolbar, mark-resolved, toggle).
    const chrome = container.querySelector(".note-editor__chrome");
    expect(chrome?.lastElementChild).toBe(screen.getByRole("button", { name: /preview/i }));

    await user.click(screen.getByRole("button", { name: /preview/i }));

    // Preview mode: the toolbar is unmounted, so the toggle is often the only child.
    expect(chrome?.lastElementChild).toBe(screen.getByRole("button", { name: /edit/i }));
  });

  it("moves the cursor to scrollToOffset once content has loaded", async () => {
    mockInvoke({ open_note: { content: "one\ntwo\nthree\n", id: "01LOADED", is_conflicted: false } });

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" scrollToOffset={5} />);
    await screen.findByText("two");

    await screen.findByRole("textbox");
    // CodeMirror focuses the editor as part of placing the cursor.
    expect(document.activeElement?.className).toContain("cm-content");
  });

  it("re-applies a new scrollToOffset while the same note stays open", async () => {
    const { rerender } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" scrollToOffset={0} />);
    await screen.findByText("Loaded");

    rerender(<ControlledNoteEditor rootId="01ROOT" path="note.md" scrollToOffset={5} />);

    // No crash / no re-fetch of open_note for the same note+path.
    expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" });
    expect(invoke.mock.calls.filter(([command]) => command === "open_note")).toHaveLength(1);
  });

  it("hides the formatting toolbar while in the rendered view", async () => {
    const user = userEvent.setup();

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
    await screen.findByText("Loaded");

    expect(screen.getByTestId("note-toolbar")).toBeDefined();

    await user.click(screen.getByRole("button", { name: /preview/i }));

    expect(screen.queryByTestId("note-toolbar")).toBeNull();
  });

  it("applies live markdown preview styling to raw syntax while in edit mode", async () => {
    mockInvoke({ open_note: { content: "**bold**\n", id: "01LOADED", is_conflicted: false } });

    const { container } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

    const strong = await waitFor(() => {
      const element = container.querySelector(".cm-live-preview-strong");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(strong.textContent).toBe("**bold**");
    expect(strong.querySelectorAll(".cm-live-preview-marker")).toHaveLength(2);
  });

  describe("save failure handling (issue #46)", () => {
    it("shows an inline error when an autosave fails, instead of dropping it silently", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "save_note") {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" edited");

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_note", expect.anything()));

      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("permission denied"),
      );
    });

    it(
      "retries a failed autosave and clears the error once a retry succeeds",
      async () => {
        let saveAttempts = 0;
        invoke.mockImplementation((command: string) => {
          if (command === "open_note") {
            return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
          }
          if (command === "save_note") {
            saveAttempts += 1;
            return saveAttempts === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve(undefined);
          }
          return Promise.resolve(undefined);
        });

        const user = userEvent.setup();
        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        await screen.findByText("Loaded");

        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        await user.keyboard(" edited");

        await waitFor(() => expect(saveAttempts).toBe(1));
        expect(await screen.findByRole("alert")).toHaveProperty(
          "textContent",
          expect.stringContaining("disk full"),
        );

        await waitFor(() => expect(saveAttempts).toBe(2), { timeout: 7000 });
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      },
      10000,
    );

    it("does not throw an unhandled rejection when the unmount-cleanup flush fails", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "save_note") {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.resolve(undefined);
      });

      const { unmount } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" edited");

      // Still inside the debounce window when we unmount, so cleanup's
      // `flushPendingSave()` call is the one that hits the rejected `save_note`.
      expect(invoke).not.toHaveBeenCalledWith("save_note", expect.anything());

      expect(() => unmount()).not.toThrow();
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_note", expect.anything()));
    });

    it("still surfaces an error when mark_resolved's own flush fails, via mark_resolved's conflict-marker check", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({
            content: "<<<<<<< HEAD\nstuff\n=======\n",
            id: "01LOADED",
            is_conflicted: true,
          });
        }
        if (command === "save_note") {
          // flushPendingSave no longer rejects, so mark_resolved's own chain
          // can't see this failure directly -- it must still surface an error
          // some other way rather than clearing the conflict silently.
          return Promise.reject(new Error("disk full"));
        }
        if (command === "mark_resolved") {
          return Promise.reject(new Error("this note still has unresolved conflict markers"));
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" resolved-by-hand");

      const resolveButton = await screen.findByRole("button", { name: /mark resolved/i });
      await user.click(resolveButton);

      // The conflict must not be cleared: the underlying save never landed.
      await waitFor(() => expect(screen.getByRole("button", { name: /mark resolved/i })).toBeDefined());
      const alerts = await waitFor(() => {
        const found = screen.getAllByRole("alert");
        expect(found.length).toBeGreaterThan(0);
        return found;
      });
      expect(alerts.map((alert) => alert.textContent).join(" ")).toContain("unresolved conflict markers");
    });
  });

  describe("conflict resolution", () => {
    it("shows a Mark resolved button when the note is conflicted", async () => {
      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

      expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("does not show a Mark resolved button when the note is not conflicted", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

      await screen.findByText("Loaded");

      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();
    });

    it("calls mark_resolved with the root and path when clicked, clearing the conflict on success", async () => {
      const user = userEvent.setup();
      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
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

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const resolveButton = await screen.findByRole("button", { name: /mark resolved/i });

      await user.click(resolveButton);

      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("unresolved conflict markers"),
      );
      expect(screen.getByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("re-fetches open_note when a sync-status event for its root settles, picking up new conflict markers", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();

      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });
      await emitSyncStatus({ root_id: "01ROOT", state: { state: "conflict" } });

      expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeDefined();
    });

    it("ignores sync-status events for a different root", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      invoke.mockClear();

      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });
      await emitSyncStatus({ root_id: "some-other-root", state: { state: "conflict" } });

      expect(invoke).not.toHaveBeenCalledWith("open_note", expect.anything());
      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();
    });

    it("does not re-fetch while the sync-status event reports syncing", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
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

      const { rerender } = render(<ControlledNoteEditor rootId="01ROOT" path="old.md" />);
      await screen.findByText("CONTENT OF old.md");

      rerender(<ControlledNoteEditor rootId="01ROOT" path="new.md" />);
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

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

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

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
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
