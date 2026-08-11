import { act, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { NoteEditor } from "./NoteEditor";
import type { EditorMode, ScanLinksResult, SyncStatusEvent } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const onDragDropEvent = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent }) }));

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
 * `origin_paths` defaults to empty (a sync with no save behind it) so
 * existing callers not exercising issue #64's filtering don't need to name it.
 */
async function emitSyncStatus(payload: Omit<SyncStatusEvent, "origin_paths"> & { origin_paths?: string[] }) {
  await waitFor(() => expect(listen).toHaveBeenCalled());
  const eventPayload: SyncStatusEvent = { origin_paths: [], ...payload };
  for (const [event, handler] of listen.mock.calls) {
    if (event === "sync-status") {
      (handler as (event: { payload: SyncStatusEvent }) => void)({ payload: eventPayload });
    }
  }
}

describe("NoteEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke();
    listen.mockResolvedValue(() => {});
    onDragDropEvent.mockResolvedValue(() => {});
  });

  it("loads the note's content via open_note and renders it in the editor", async () => {
    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    expect(await screen.findByText("Loaded")).toBeDefined();
  });

  it("shows a loading indicator while open_note is in flight, and hides it once content loads", async () => {
    let resolveOpenNote: (result: { content: string; id: string; is_conflicted: boolean }) => void = () => {};
    mockInvoke({
      open_note: new Promise((resolve) => {
        resolveOpenNote = resolve;
      }),
    });

    render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);

    expect(await screen.findByTestId("spinner")).toBeDefined();

    resolveOpenNote({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });

    await screen.findByText("Loaded");
    expect(screen.queryByTestId("spinner")).toBeNull();
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

  describe("onSaveStateChange (issue #96)", () => {
    it("reports pending on the first keystroke of an edit burst, then clean once the debounced save resolves", async () => {
      const user = userEvent.setup();
      const onSaveStateChange = vi.fn();

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" onSaveStateChange={onSaveStateChange} />);
      await screen.findByText("Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" edited");

      expect(onSaveStateChange).toHaveBeenCalledWith("pending");

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_note", expect.anything()), { timeout: 2000 });
      await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith("clean"));

      // Transitions only -- one "pending" call per burst, not once per
      // keystroke (" edited" is 7 keystrokes), and exactly one "clean" call
      // once the save resolves.
      expect(onSaveStateChange.mock.calls.filter(([state]) => state === "pending")).toHaveLength(1);
      expect(onSaveStateChange.mock.calls.filter(([state]) => state === "clean")).toHaveLength(1);
    });

    it("reports failed when an autosave fails, and clean again once a retry succeeds", async () => {
      const user = userEvent.setup();
      const onSaveStateChange = vi.fn();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "save_note") {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" onSaveStateChange={onSaveStateChange} />);
      await screen.findByText("Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard(" edited");

      await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith("failed"));
    });
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

    it("does not re-fetch when the settled sync's origin_paths names this note's own save (issue #64)", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      invoke.mockClear();

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null }, origin_paths: ["note.md"] });

      expect(invoke).not.toHaveBeenCalledWith("open_note", expect.anything());
    });

    it("re-fetches when the settled sync's origin_paths names only another note's save", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      invoke.mockClear();

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null }, origin_paths: ["other.md"] });

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    });

    it("re-fetches when origin_paths is empty, e.g. a manual sync or a conflict resolution completing", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      invoke.mockClear();

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null }, origin_paths: [] });

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));
    });

    it("still picks up a new conflict from elsewhere even when its own save is also among the origin paths", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      expect(screen.queryByRole("button", { name: /mark resolved/i })).toBeNull();

      mockInvoke({ open_note: { content: "<<<<<<< HEAD\n", id: "01LOADED", is_conflicted: true } });
      await emitSyncStatus({ root_id: "01ROOT", state: { state: "conflict" }, origin_paths: ["other.md"] });

      expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeDefined();
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
      staleHandler({ payload: { root_id: "01ROOT", state: { state: "synced", last_synced: null }, origin_paths: [] } });

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

      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });

      // The typed text must survive: no overwrite from stale disk content,
      // and no save of anything other than what the user actually typed.
      expect(screen.getByText(/MYNEWTEXT/)).toBeDefined();
      expect(invoke).not.toHaveBeenCalledWith(
        "save_note",
        expect.objectContaining({ content: expect.not.stringContaining("MYNEWTEXT") }),
      );
    });

    it("does not move the caret when a terminal sync-status event returns content identical to the buffer (issue #62)", async () => {
      const user = userEvent.setup();

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{Home}X");
      await screen.findByText("XLoaded");

      // Let the autosave debounce flush -- the sync-status handler ignores
      // the event entirely while a save is still pending, and the reported
      // bug only reproduces once the disk content the sync reads back
      // matches what's already in the buffer.
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("save_note", { rootId: "01ROOT", path: "note.md", content: "XLoaded\n" }),
      );

      // Caret sits right after the "X" the user just typed, at offset 1.
      mockInvoke({ open_note: { content: "XLoaded\n", id: "01LOADED", is_conflicted: false } });
      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));

      const selection = window.getSelection();
      expect(editable.textContent).toBe("XLoaded");
      expect(selection?.anchorOffset).toBe(1);
    });

    describe("minimal-change sync refresh (issue #63)", () => {
      /** CodeMirror renders each line as its own `.cm-line` div, so `textContent`
       * across multiple lines never contains the `\n` that joins them in the doc. */
      function withoutNewlines(text: string): string {
        return text.replace(/\n/g, "");
      }

      /**
       * Flushes a save for `typedSuffix` typed at the end of the loaded note,
       * then delivers a sync-status event whose `open_note` re-fetch returns
       * `remoteContent` -- content that genuinely differs from the buffer,
       * the case that survives issue #62's identical-content guard.
       */
      async function syncInGenuinelyNewContent(remoteContent: string, typedSuffix = " edited") {
        const user = userEvent.setup();

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        await user.keyboard(`{End}${typedSuffix}`);

        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("save_note", {
            rootId: "01ROOT",
            path: "note.md",
            content: expect.stringContaining(typedSuffix.trim()),
          }),
        );

        mockInvoke({ open_note: { content: remoteContent, id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(editable.textContent).toBe(withoutNewlines(remoteContent.trimEnd())));

        return { user, editable };
      }

      it("applies only the changed region instead of replacing the whole document", async () => {
        const { editable } = await syncInGenuinelyNewContent("Loaded edited\nappended by sync\n");

        expect(editable.textContent).toBe("Loaded editedappended by sync");
      });

      it("preserves the caret when the incoming change is entirely after it", async () => {
        const user = userEvent.setup();
        mockInvoke({ open_note: { content: "one\ntwo\nthree\n", id: "01LOADED", is_conflicted: false } });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        // Caret at offset 1, inside "one" -- well before where the remote change lands.
        await user.keyboard("{Home}{Right}Z");
        await screen.findByText("oZne");

        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("save_note", {
            rootId: "01ROOT",
            path: "note.md",
            content: "oZne\ntwo\nthree\n",
          }),
        );

        mockInvoke({ open_note: { content: "oZne\ntwo\nthree\nfour\n", id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(editable.textContent).toBe("oZnetwothreefour"));

        expect(window.getSelection()?.anchorOffset).toBe(2);
      });

      it("shifts the caret by the edit's length when the incoming change is entirely before it", async () => {
        const { editable } = await syncInGenuinelyNewContent("prefix added\nLoaded edited\n");

        // Caret was at the end of "Loaded edited" (offset 13 in the old buffer);
        // a 13-character insertion ("prefix added\n") before it shifts it to 26,
        // still right after "edited" rather than resetting to 0 or the end.
        expect(window.getSelection()?.anchorOffset).toBe(13);
        expect(editable.textContent).toBe("prefix addedLoaded edited");
      });

      it("lands the caret somewhere inside the changed region when it was there originally", async () => {
        const user = userEvent.setup();
        mockInvoke({ open_note: { content: "one two three\n", id: "01LOADED", is_conflicted: false } });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        // Caret lands in the middle of "two", inside the region that gets replaced below.
        await user.keyboard("{Home}{Right}{Right}{Right}{Right}{Right}Z");
        await screen.findByText("one tZwo three");

        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("save_note", {
            rootId: "01ROOT",
            path: "note.md",
            content: "one tZwo three\n",
          }),
        );

        mockInvoke({ open_note: { content: "one CHANGED three\n", id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(editable.textContent).toBe("one CHANGED three"));

        const offset = window.getSelection()?.anchorOffset ?? -1;
        // Somewhere within "one CHANGED three" (18 chars), not clamped to 0 or the end.
        expect(offset).toBeGreaterThan(0);
        expect(offset).toBeLessThan("one CHANGED three".length);
      });

      it("keeps an active selection intact when the sync changes an unrelated part of the note", async () => {
        const user = userEvent.setup();
        mockInvoke({ open_note: { content: "one two three\n", id: "01LOADED", is_conflicted: false } });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        // Select "two" (offsets 4-7).
        await user.keyboard("{Home}{Right}{Right}{Right}{Right}{Shift>}{Right}{Right}{Right}{/Shift}");

        mockInvoke({ open_note: { content: "one two three-appended\n", id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(editable.textContent).toBe("one two three-appended"));

        // Asserted via CodeMirror's own state rather than the native DOM
        // selection: jsdom doesn't reliably sync `window.getSelection()` to
        // CodeMirror's internal selection outside of real browser layout.
        const view = EditorView.findFromDOM(editable as HTMLElement);
        expect(view?.state.selection.main).toMatchObject({ from: 4, to: 7 });
      });

      it("does not reset scroll position when the incoming change lands off-screen", async () => {
        const { container } = render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        await screen.findByText("Loaded");

        const scroller = container.querySelector(".cm-scroller") as HTMLElement;
        scroller.scrollTop = 250;

        mockInvoke({ open_note: { content: "Loaded\nappended far below\n", id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(screen.queryByText("appended far below")).not.toBeNull());

        expect(scroller.scrollTop).toBe(250);
      });

      it("keeps undo stepping through the user's own edits rather than dead-ending on the sync", async () => {
        const user = userEvent.setup();

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        await user.keyboard("{End} mine");
        await screen.findByText("Loaded mine");

        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("save_note", {
            rootId: "01ROOT",
            path: "note.md",
            content: "Loaded mine\n",
          }),
        );

        mockInvoke({ open_note: { content: "Loaded mine appended\n", id: "01LOADED", is_conflicted: false } });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(editable.textContent).toBe("Loaded mine appended"));

        await user.keyboard("{Control>}z{/Control}");

        // Undo reverts the user's own " mine" edit (skipping straight over the
        // sync, which never entered the undo stack), not a no-op or a revert
        // of the sync's own appended text.
        await waitFor(() => expect(editable.textContent).toBe("Loaded appended"));
      });

      it("does not lose or reorder a keystroke typed while a sync is in flight", async () => {
        const user = userEvent.setup();
        let resolveOpenNote: (result: { content: string; id: string; is_conflicted: boolean }) => void = () => {};

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await screen.findByText("Loaded");

        invoke.mockImplementation((command: string) => {
          if (command === "open_note") {
            return new Promise((resolve) => {
              resolveOpenNote = resolve;
            });
          }
          return Promise.resolve(undefined);
        });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_note", { rootId: "01ROOT", path: "note.md" }));

        // Typed while the re-fetch above is still in flight.
        await user.click(editable);
        await user.keyboard("{End} typed-during-sync");
        await screen.findByText("Loaded typed-during-sync");

        resolveOpenNote({ content: "Loaded remotely-changed\n", id: "01LOADED", is_conflicted: false });

        // The in-flight sync's resolution must not overwrite the keystroke
        // that arrived while it was pending.
        await waitFor(() => expect(editable.textContent).toBe("Loaded typed-during-sync"));
      });

      it("applies two unrelated remote changes as separate hunks rather than one region spanning both", async () => {
        const user = userEvent.setup();
        mockInvoke({
          open_note: {
            content: "line0\nline1\nline2\nline3\nline4\nline5\n",
            id: "01LOADED",
            is_conflicted: false,
          },
        });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        // Caret placed at the start of line2 (offset 12: "line0\n" + "line1\n"),
        // between the two hunks the sync below introduces.
        await user.keyboard("{Control>}{Home}{/Control}" + "{Right}".repeat(12) + "Z");
        await screen.findByText("Zline2");

        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("save_note", {
            rootId: "01ROOT",
            path: "note.md",
            content: "line0\nline1\nZline2\nline3\nline4\nline5\n",
          }),
        );

        // The sync changes line0 and appends after line5 -- two hunks on
        // either side of the caret's line, with plain "Zline2" untouched
        // in between.
        mockInvoke({
          open_note: {
            content: "line0-CHANGED\nline1\nZline2\nline3\nline4\nline5\nline6\n",
            id: "01LOADED",
            is_conflicted: false,
          },
        });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });
        await waitFor(() => expect(screen.queryByText("line6")).not.toBeNull());

        // The caret's own line survived untouched, so its offset relative to
        // that line's start (1, right after "Z") is preserved -- if the two
        // remote hunks had collapsed into one region spanning line0 through
        // line6, this line would have been swept up and the caret reset.
        expect(window.getSelection()?.anchorOffset).toBe(1);
      });

      it("does not corrupt a CRLF note by applying character offsets computed on normalized text", async () => {
        const user = userEvent.setup();
        mockInvoke({ open_note: { content: "line1\r\nline2\r\nline3\r\n", id: "01LOADED", is_conflicted: false } });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await user.click(editable);
        await user.keyboard("{End} edited");

        await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_note", expect.anything()));

        mockInvoke({
          open_note: { content: "line1\r\nline2 edited CHANGED\r\nline3\r\n", id: "01LOADED", is_conflicted: false },
        });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });

        await waitFor(() => expect(editable.textContent).toBe("line1line2 edited CHANGEDline3"));
      });

      it("does not split a surrogate pair when the incoming change lands next to an emoji", async () => {
        const user = userEvent.setup();
        mockInvoke({ open_note: { content: "note \u{1F600} end\n", id: "01LOADED", is_conflicted: false } });

        render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
        const editable = await screen.findByRole("textbox");
        await screen.findByText("note \u{1F600} end");
        await user.click(editable);
        await user.keyboard("{End} edited");

        await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_note", expect.anything()));

        mockInvoke({
          open_note: { content: "note \u{1F601} end edited\n", id: "01LOADED", is_conflicted: false },
        });
        await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });

        await waitFor(() => expect(editable.textContent).toBe("note \u{1F601} end edited"));
      });
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

  describe("image attachment (issue #75)", () => {
    it("writes the picked file and inserts an attachment: reference at the cursor, cursor placed after", async () => {
      const user = userEvent.setup();
      mockInvoke({
        pick_image_file: { name: "photo.png", bytes: [1, 2, 3] },
        write_attachment: "attachment:01ABC",
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{End}");

      await user.click(screen.getByTitle("Image"));
      await user.click(screen.getByRole("menuitem", { name: "Attach image file…" }));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("write_attachment", {
          rootId: "01ROOT",
          bytes: [1, 2, 3],
          originalName: "photo.png",
        }),
      );
      await waitFor(() => expect(editable.textContent).toBe("Loaded![photo.png](attachment:01ABC)"));
      // CodeMirror focuses the editor as part of placing the cursor there.
      expect(document.activeElement?.className).toContain("cm-content");
    });

    it("inserts nothing and leaves the cursor untouched when the dialog is cancelled", async () => {
      const user = userEvent.setup();
      mockInvoke({ pick_image_file: null });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");

      await user.click(screen.getByTitle("Image"));
      await user.click(screen.getByRole("menuitem", { name: "Attach image file…" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("pick_image_file"));
      expect(editable.textContent).toBe("Loaded");
      expect(invoke).not.toHaveBeenCalledWith("write_attachment", expect.anything());
    });

    it("inserts nothing and surfaces the error inline (not a toast) when the write fails", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "pick_image_file") {
          return Promise.resolve({ name: "photo.png", bytes: [1, 2, 3] });
        }
        if (command === "write_attachment") {
          return Promise.reject(new Error("not a recognized image format"));
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");

      await user.click(screen.getByTitle("Image"));
      await user.click(screen.getByRole("menuitem", { name: "Attach image file…" }));

      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("not a recognized image format"),
      );
      expect(editable.textContent).toBe("Loaded");
    });

    it("disables the image button for the duration of the pick+write", async () => {
      const user = userEvent.setup();
      let resolvePick: (value: { name: string; bytes: number[] } | null) => void = () => {};
      mockInvoke({
        pick_image_file: new Promise((resolve) => {
          resolvePick = resolve;
        }),
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByRole("textbox");

      await user.click(screen.getByTitle("Image"));
      await user.click(screen.getByRole("menuitem", { name: "Attach image file…" }));
      expect(screen.getByTitle("Image").hasAttribute("disabled")).toBe(true);

      resolvePick(null);
      await waitFor(() => expect(screen.getByTitle("Image").hasAttribute("disabled")).toBe(false));
    });
  });

  describe("clipboard paste attaches an image (issue #77)", () => {
    /** jsdom implements neither `ClipboardEvent` nor `DataTransfer` fully
     * enough for `.files`/`.getData`, so this fakes just the surface the
     * paste handler reads, matching `attachmentPaste.test.ts`'s fake. */
    function pasteClipboardData(options: { files?: File[]; uriList?: string; text?: string } = {}) {
      const files = options.files ?? [];
      const byFormat: Record<string, string> = {
        "text/uri-list": options.uriList ?? "",
        "text/plain": options.text ?? "",
      };
      return {
        files: {
          length: files.length,
          item: (index: number) => files[index] ?? null,
          [Symbol.iterator]: function* () {
            yield* files;
          },
        } as unknown as FileList,
        getData: (format: string) => byFormat[format] ?? "",
      };
    }

    function pngFile(name: string): File {
      return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
    }

    it("writes pasted image bytes and inserts an attachment: reference at the cursor", async () => {
      const user = userEvent.setup();
      mockInvoke({ write_attachment: "attachment:01ABC" });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{End}");

      fireEvent.paste(editable, { clipboardData: pasteClipboardData({ files: [pngFile("photo.png")] }) });

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("write_attachment", {
          rootId: "01ROOT",
          bytes: [0x89, 0x50, 0x4e, 0x47],
          originalName: "photo.png",
        }),
      );
      await waitFor(() => expect(editable.textContent).toBe("Loaded![photo.png](attachment:01ABC)"));
    });

    it("imports a pasted file:// path and inserts the resulting reference", async () => {
      const user = userEvent.setup();
      mockInvoke({ import_attachment: "attachment:01DEF" });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{End}");

      fireEvent.paste(editable, {
        clipboardData: pasteClipboardData({ uriList: "file:///home/user/shot.png" }),
      });

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("import_attachment", {
          rootId: "01ROOT",
          absolutePath: "/home/user/shot.png",
        }),
      );
      await waitFor(() => expect(editable.textContent).toBe("Loaded![shot.png](attachment:01DEF)"));
    });

    it("leaves plain text paste unclaimed, falling through to normal editor paste", async () => {
      const user = userEvent.setup();

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{End}");

      fireEvent.paste(editable, { clipboardData: pasteClipboardData({ uriList: "just some plain text" }) });

      expect(invoke).not.toHaveBeenCalledWith("write_attachment", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("import_attachment", expect.anything());
    });

    it("surfaces a failed import inline rather than inserting anything", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "write_attachment") {
          return Promise.reject(new Error("not a recognized image format"));
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await user.click(editable);
      await user.keyboard("{End}");

      fireEvent.paste(editable, { clipboardData: pasteClipboardData({ files: [pngFile("photo.png")] }) });

      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("not a recognized image format"),
      );
      expect(editable.textContent).toBe("Loaded");
    });
  });

  describe("drag-and-drop attaches an image (issue #78)", () => {
    /** Grabs the handler `NoteEditor` registered via the mocked
     * `getCurrentWebview().onDragDropEvent`, so a test can fire native-shaped
     * `DragDropEvent` payloads directly -- there's no real webview/native
     * event in jsdom to dispatch this through. */
    function dragDropHandler() {
      const call = onDragDropEvent.mock.calls.at(-1);
      if (call === undefined) {
        throw new Error("onDragDropEvent was never registered");
      }
      return call[0] as (event: { payload: unknown }) => void;
    }

    /** A `PhysicalPosition`-shaped stand-in with the one method the drop
     * handler calls -- `toLogical` is a no-op 1:1 conversion here since
     * `window.devicePixelRatio` in jsdom is 1. */
    function physicalPosition(x: number, y: number) {
      return { toLogical: () => ({ x, y }) };
    }

    it("shows the hover affordance while a drag is over the editor pane, and hides it on drop", async () => {
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      const handler = dragDropHandler();
      const body = document.querySelector(".note-editor__body") as HTMLElement;
      // jsdom's layout engine always reports a zero-sized rect regardless of
      // CSS, so it's stubbed here to give the position-vs-bounds hit test
      // something real to check against.
      body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600 }) as DOMRect;

      act(() => handler({ payload: { type: "enter", paths: [], position: physicalPosition(10, 10) } }));
      expect(body.getAttribute("data-drag-over")).toBe("true");

      act(() => handler({ payload: { type: "leave" } }));
      expect(body.getAttribute("data-drag-over")).toBeNull();
    });

    it("imports a dropped file and inserts the reference at the drop position, hiding the hover affordance", async () => {
      mockInvoke({ import_attachment: "attachment:01DROP" });
      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      const editable = await screen.findByRole("textbox");
      await waitFor(() => expect(editable.textContent).toBe("Loaded"));
      const handler = dragDropHandler();
      const body = document.querySelector(".note-editor__body") as HTMLElement;
      body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600 }) as DOMRect;

      act(() =>
        handler({ payload: { type: "enter", paths: ["/home/user/shot.png"], position: physicalPosition(5, 5) } }),
      );
      expect(body.getAttribute("data-drag-over")).toBe("true");

      act(() =>
        handler({ payload: { type: "drop", paths: ["/home/user/shot.png"], position: physicalPosition(5, 5) } }),
      );

      expect(body.getAttribute("data-drag-over")).toBeNull();
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("import_attachment", {
          rootId: "01ROOT",
          absolutePath: "/home/user/shot.png",
        }),
      );
      await waitFor(() => expect(editable.textContent).toContain("attachment:01DROP"));
    });
  });

  describe("backlinks (issue #50)", () => {
    function mockScanLinks(scanLinks: Record<string, unknown>) {
      mockInvoke({ scan_links: scanLinks });
    }

    it("shows a 'Linked from' section listing the notes that link here", async () => {
      mockScanLinks({
        notes: [
          { id: "01A", path: "a.md", directory_path: "", title: "a" },
          { id: "01B", path: "folder/b.md", directory_path: "folder", title: "b" },
        ],
        backlinks: { "01LOADED": ["a.md", "folder/b.md"] },
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      expect(await screen.findByText("Linked from (2)")).toBeDefined();
      expect(screen.getByText("a")).toBeDefined();
      expect(screen.getByText("b")).toBeDefined();
    });

    it("is entirely absent when no notes link to the open note", async () => {
      mockScanLinks({ notes: [], backlinks: {} });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      expect(screen.queryByText(/linked from/i)).toBeNull();
    });

    it("shows exactly one row for a note that links here three times", async () => {
      mockScanLinks({
        notes: [{ id: "01A", path: "a.md", directory_path: "", title: "a" }],
        backlinks: { "01LOADED": ["a.md"] },
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");

      expect(await screen.findByText("Linked from (1)")).toBeDefined();
    });

    it("renders in both edit and view mode", async () => {
      mockScanLinks({
        notes: [{ id: "01A", path: "a.md", directory_path: "", title: "a" }],
        backlinks: { "01LOADED": ["a.md"] },
      });
      const user = userEvent.setup();

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      expect(await screen.findByText("Linked from (1)")).toBeDefined();

      await user.click(screen.getByRole("button", { name: /preview/i }));

      expect(screen.getByText("Linked from (1)")).toBeDefined();
    });

    it("disappears once the last inbound link is gone and the link cache refreshes", async () => {
      let scanResult: ScanLinksResult = {
        notes: [{ id: "01A", path: "a.md", directory_path: "", title: "a" }],
        backlinks: { "01LOADED": ["a.md"] },
      };
      invoke.mockImplementation((command: string) => {
        if (command === "open_note") {
          return Promise.resolve({ content: "Loaded\n", id: "01LOADED", is_conflicted: false });
        }
        if (command === "scan_links") {
          return Promise.resolve(scanResult);
        }
        return Promise.resolve(undefined);
      });

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" />);
      await screen.findByText("Loaded");
      expect(await screen.findByText("Linked from (1)")).toBeDefined();

      // The linking note edited away its link to this one; the next rescan
      // (triggered by a settled sync, same as the tree's own refresh) reflects that.
      scanResult = { notes: [{ id: "01A", path: "a.md", directory_path: "", title: "a" }], backlinks: {} };
      await emitSyncStatus({ root_id: "01ROOT", state: { state: "synced", last_synced: null } });

      await waitFor(() => expect(screen.queryByText(/linked from/i)).toBeNull());
    });

    it("opens the clicked backlink via onOpenNoteLink", async () => {
      mockScanLinks({
        notes: [{ id: "01A", path: "folder/a.md", directory_path: "folder", title: "a" }],
        backlinks: { "01LOADED": ["folder/a.md"] },
      });
      const onOpenNoteLink = vi.fn();
      const user = userEvent.setup();

      render(<ControlledNoteEditor rootId="01ROOT" path="note.md" onOpenNoteLink={onOpenNoteLink} />);
      await screen.findByText("Loaded");
      await screen.findByText("Linked from (1)");

      await user.click(screen.getByText("a"));

      expect(onOpenNoteLink).toHaveBeenCalledWith("01ROOT", "folder/a.md");
    });
  });
});
