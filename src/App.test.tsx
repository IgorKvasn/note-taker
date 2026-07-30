import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { EVENT_MENU_ABOUT, EVENT_MENU_SETTINGS, type Config, type ConfigOutcome } from "./ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const EMPTY_CONFIG: Config = { version: 1, roots: [{ id: "01ROOT", path: "/notes", auto_sync: false, remote_url: "" }] };

function mockInvoke(overrides: Record<string, unknown> = {}) {
  invoke.mockImplementation((command: string, args?: unknown) => {
    if (command in overrides) {
      const value = overrides[command];
      if (typeof value === "function") return value(args);
      return value instanceof Promise ? value : Promise.resolve(value);
    }
    if (command === "get_app_version") return Promise.resolve("0.1.0");
    if (command === "get_config") {
      return Promise.resolve({ type: "ok", config: EMPTY_CONFIG } satisfies ConfigOutcome);
    }
    if (command === "show_config_error") return Promise.resolve(undefined);
    if (command === "list_tree") return Promise.resolve([]);
    if (command === "open_note") {
      return Promise.resolve({ content: "", id: "01NOTE", is_conflicted: false });
    }
    if (command === "save_note") return Promise.resolve(undefined);
    if (command === "get_state") {
      return Promise.resolve({
        split_ratio: 0.28,
        last_open_note: null,
        expanded_paths: {},
        has_dismissed_local_only_notice: true,
        editor_mode: "edit",
      });
    }
    if (command === "save_state") return Promise.resolve(undefined);
    if (command === "get_root_status") {
      return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
    }
    return Promise.resolve(undefined);
  });
}

/** Fires a backend menu/config event through whichever listener App registered. */
async function emitEvent(eventName: string) {
  await waitFor(() => expect(listen).toHaveBeenCalled());

  const registration = listen.mock.calls.find(([name]) => name === eventName);
  expect(registration).toBeDefined();

  const handler = registration![1] as () => void;
  await waitFor(() => handler());
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
    mockInvoke();
  });

  it("renders both panes once config is ok", async () => {
    render(<App />);

    expect(await screen.findByTestId("split-pane-left")).toBeDefined();
    expect(screen.getByTestId("split-pane-right")).toBeDefined();
  });

  it("keeps the About modal closed until the menu event arrives", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens About with the version from the backend", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await emitEvent(EVENT_MENU_ABOUT);

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("0.1.0")).toBeDefined();
  });

  it("requests the version from the backend command", async () => {
    render(<App />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_app_version"));
  });

  it("closes About again", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");
    await emitEvent(EVENT_MENU_ABOUT);
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens About when the version lookup fails", async () => {
    mockInvoke({ get_app_version: Promise.reject(new Error("backend unavailable")) });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await emitEvent(EVENT_MENU_ABOUT);

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("has no app-wide sync indicator in the chrome", async () => {
    const { container } = render(<App />);
    await screen.findByTestId("split-pane-left");

    expect(container.querySelector("[data-sync-status]")).toBeNull();
    expect(screen.queryByText(/sync/i)).toBeNull();
  });

  it("shows first-run setup and blocks the two-pane layout when config is missing", async () => {
    mockInvoke({ get_config: { type: "missing" } satisfies ConfigOutcome });
    render(<App />);

    expect(await screen.findByText("Welcome to note-taker")).toBeDefined();
    expect(screen.queryByTestId("split-pane-left")).toBeNull();
  });

  it("proceeds to the two-pane layout once first-run setup saves a config", async () => {
    const savedConfig: Config = { version: 1, roots: [{ id: "01NEW", path: "/home/notes", auto_sync: false, remote_url: "" }] };
    mockInvoke({
      get_config: { type: "missing" } satisfies ConfigOutcome,
      pick_folder: "/home/notes",
      validate_root_path: { exists: true, is_writable: true, is_git_repo: false, has_remote: false, remote_url: null },
      save_config: savedConfig,
    });
    render(<App />);
    await screen.findByText("Welcome to note-taker");

    await userEvent.click(screen.getByRole("button", { name: "Add root…" }));
    await screen.findByText("/home/notes");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("split-pane-left")).toBeDefined();
  });

  it("shows a hard error with the parse error and never renders the two-pane layout when config is invalid", async () => {
    mockInvoke({
      get_config: { type: "invalid", error: "expected `=` at line 3" } satisfies ConfigOutcome,
    });
    render(<App />);

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("expected `=` at line 3")).toBeDefined();
    expect(screen.queryByTestId("split-pane-left")).toBeNull();
  });

  it("shows the native error dialog once for an invalid config", async () => {
    mockInvoke({
      get_config: { type: "invalid", error: "expected `=` at line 3" } satisfies ConfigOutcome,
    });
    render(<App />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("show_config_error", { error: "expected `=` at line 3" }),
    );
  });

  it("shows the placeholder pane with no note open initially", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");

    expect(screen.getByText("No note open")).toBeDefined();
    expect(screen.queryByTestId("note-editor")).toBeNull();
  });

  it("loads a note into the CM6 editor when it is clicked in the tree", async () => {
    mockInvoke({
      list_tree: [{ name: "note.md", path: "note.md", is_directory: false, children: [] }],
      open_note: { content: "hello world", id: "01NOTE", is_conflicted: false },
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await userEvent.click(await screen.findByRole("button", { name: "note.md" }));

    expect(await screen.findByTestId("note-editor")).toBeDefined();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_note", { rootId: EMPTY_CONFIG.roots[0].id, path: "note.md" }),
    );
    expect(await screen.findByText("hello world")).toBeDefined();
  });

  it("restores the last-open note from persisted state on mount", async () => {
    mockInvoke({
      list_tree: [{ name: "note.md", path: "note.md", is_directory: false, children: [] }],
      open_note: { content: "hello world", id: "01NOTE", is_conflicted: false },
      get_state: {
        split_ratio: 0.28,
        last_open_note: { root_id: EMPTY_CONFIG.roots[0].id, path: "note.md" },
        expanded_paths: {},
        editor_mode: "edit",
      },
    });
    render(<App />);

    expect(await screen.findByTestId("note-editor")).toBeDefined();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_note", { rootId: EMPTY_CONFIG.roots[0].id, path: "note.md" }),
    );
  });

  it("does not restore a last-open note whose root no longer exists in the config", async () => {
    mockInvoke({
      list_tree: [],
      get_state: {
        split_ratio: 0.28,
        last_open_note: { root_id: "01STALE-ROOT", path: "note.md" },
        expanded_paths: {},
        editor_mode: "edit",
      },
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    expect(screen.queryByTestId("note-editor")).toBeNull();
    expect(screen.getByText("No note open")).toBeDefined();
  });

  it("falls back to the placeholder when a persisted last-open note's file no longer exists", async () => {
    mockInvoke({
      list_tree: [],
      get_state: {
        split_ratio: 0.28,
        last_open_note: { root_id: EMPTY_CONFIG.roots[0].id, path: "deleted.md" },
        expanded_paths: {},
        editor_mode: "edit",
      },
      open_note: () => Promise.reject(new Error("no such file or directory")),
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await waitFor(() => {
      expect(screen.getByText("No note open")).toBeDefined();
      expect(screen.queryByTestId("note-editor")).toBeNull();
    });
  });

  it("keeps only one note open at a time when a second note is clicked", async () => {
    invoke.mockImplementation((command: string, args?: { path: string }) => {
      if (command === "list_tree") {
        return Promise.resolve([
          { name: "first.md", path: "first.md", is_directory: false, children: [] },
          { name: "second.md", path: "second.md", is_directory: false, children: [] },
        ]);
      }
      if (command === "open_note") {
        return Promise.resolve({ content: `content of ${args!.path}`, id: "01NOTE", is_conflicted: false });
      }
      if (command === "get_app_version") return Promise.resolve("0.1.0");
      if (command === "get_config") return Promise.resolve({ type: "ok", config: EMPTY_CONFIG } satisfies ConfigOutcome);
      return Promise.resolve(undefined);
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await userEvent.click(await screen.findByRole("button", { name: "first.md" }));
    await screen.findByText("content of first.md");
    expect(screen.queryAllByTestId("note-editor")).toHaveLength(1);

    await userEvent.click(await screen.findByRole("button", { name: "second.md" }));

    expect(await screen.findByText("content of second.md")).toBeDefined();
    expect(screen.queryByText("content of first.md")).toBeNull();
    expect(screen.queryAllByTestId("note-editor")).toHaveLength(1);
  });

  it("keeps preview mode active after switching to a different note, and persists the setting (issue #37)", async () => {
    mockInvoke({
      list_tree: [
        { name: "first.md", path: "first.md", is_directory: false, children: [] },
        { name: "second.md", path: "second.md", is_directory: false, children: [] },
      ],
      open_note: (args?: { path: string }) =>
        Promise.resolve({ content: `content of ${args!.path}`, id: "01NOTE", is_conflicted: false }),
      get_state: {
        split_ratio: 0.28,
        last_open_note: null,
        expanded_paths: {},
        has_dismissed_local_only_notice: true,
        editor_mode: "edit",
      },
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await userEvent.click(await screen.findByRole("button", { name: "first.md" }));
    await screen.findByText("content of first.md");

    await userEvent.click(screen.getByRole("button", { name: /preview/i }));
    expect(await screen.findByTestId("note-view")).toBeDefined();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "save_state",
        expect.objectContaining({ state: expect.objectContaining({ editor_mode: "view" }) }),
      ),
    );

    await userEvent.click(await screen.findByRole("button", { name: "second.md" }));

    const noteView = await screen.findByTestId("note-view");
    await waitFor(() => expect(noteView.textContent).toContain("content of second.md"));
    const { getByRole, queryByRole } = within(screen.getByTestId("split-pane-right"));
    expect(queryByRole("textbox")).toBeNull();
    expect(getByRole("button", { name: /edit/i })).toBeDefined();
  });

  it("opens Settings from the menu event and lists existing roots", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await emitEvent(EVENT_MENU_SETTINGS);

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(screen.getByText(EMPTY_CONFIG.roots[0].path)).toBeDefined();
  });

  it("shows the local-only notice on the first local_only sync-status event and dismisses it, persisting the dismissal", async () => {
    mockInvoke({
      get_state: {
        split_ratio: 0.28,
        last_open_note: null,
        expanded_paths: {},
        has_dismissed_local_only_notice: false,
        editor_mode: "edit",
      },
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await waitFor(() => expect(listen).toHaveBeenCalledWith("sync-status", expect.any(Function)));
    const registrations = listen.mock.calls.filter(([name]) => name === "sync-status");

    expect(screen.queryByRole("status")).toBeNull();

    // RootSyncIndicator also subscribes to sync-status; fire the event through
    // every registered handler so this doesn't depend on registration order.
    await waitFor(() => {
      for (const [, handler] of registrations) {
        (handler as (event: { payload: unknown }) => void)({
          payload: { root_id: "01ROOT", state: { state: "local_only" } },
        });
      }
    });

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/local/i);

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "save_state",
        expect.objectContaining({ state: expect.objectContaining({ has_dismissed_local_only_notice: true }) }),
      ),
    );
  });

  it("never shows the local-only notice once it was already dismissed in a previous session", async () => {
    mockInvoke({
      get_state: {
        split_ratio: 0.28,
        last_open_note: null,
        expanded_paths: {},
        has_dismissed_local_only_notice: true,
        editor_mode: "edit",
      },
    });
    render(<App />);
    await screen.findByTestId("split-pane-left");

    const syncStatusRegistrations = listen.mock.calls.filter(([name]) => name === "sync-status");
    // RootSyncIndicator (one per root) also subscribes to sync-status; simulate
    // every registered handler receiving a local_only event and assert none of
    // them renders App's one-time notice.
    for (const [, handler] of syncStatusRegistrations) {
      (handler as (event: { payload: unknown }) => void)({
        payload: { root_id: "01ROOT", state: { state: "local_only" } },
      });
    }

    expect(screen.queryByRole("status")).toBeNull();
  });
});
