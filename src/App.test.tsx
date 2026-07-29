import { render, screen, waitFor } from "@testing-library/react";
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
  invoke.mockImplementation((command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Promise ? value : Promise.resolve(value);
    }
    if (command === "get_app_version") return Promise.resolve("0.1.0");
    if (command === "get_config") {
      return Promise.resolve({ type: "ok", config: EMPTY_CONFIG } satisfies ConfigOutcome);
    }
    if (command === "show_config_error") return Promise.resolve(undefined);
    if (command === "list_tree") return Promise.resolve([]);
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

  it("opens Settings from the menu event and lists existing roots", async () => {
    render(<App />);
    await screen.findByTestId("split-pane-left");

    await emitEvent(EVENT_MENU_SETTINGS);

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(screen.getByText(EMPTY_CONFIG.roots[0].path)).toBeDefined();
  });
});
