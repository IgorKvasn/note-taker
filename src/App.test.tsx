import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { EVENT_MENU_ABOUT } from "./ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

/** Fires the backend menu event through whichever listener App registered. */
async function emitAboutMenuEvent() {
  await waitFor(() => expect(listen).toHaveBeenCalled());

  const registration = listen.mock.calls.find(
    ([eventName]) => eventName === EVENT_MENU_ABOUT,
  );
  expect(registration).toBeDefined();

  const handler = registration![1] as () => void;
  await waitFor(() => handler());
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue("0.1.0");
    listen.mockResolvedValue(() => {});
  });

  it("renders both panes", async () => {
    render(<App />);

    expect(screen.getByTestId("split-pane-left")).toBeDefined();
    expect(screen.getByTestId("split-pane-right")).toBeDefined();
  });

  it("keeps the About modal closed until the menu event arrives", () => {
    render(<App />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens About with the version from the backend", async () => {
    render(<App />);

    await emitAboutMenuEvent();

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("0.1.0")).toBeDefined();
  });

  it("requests the version from the backend command", async () => {
    render(<App />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_app_version"),
    );
  });

  it("closes About again", async () => {
    render(<App />);
    await emitAboutMenuEvent();
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens About when the version lookup fails", async () => {
    invoke.mockRejectedValue(new Error("backend unavailable"));
    render(<App />);

    await emitAboutMenuEvent();

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("has no app-wide sync indicator in the chrome", () => {
    const { container } = render(<App />);

    expect(container.querySelector("[data-sync-status]")).toBeNull();
    expect(screen.queryByText(/sync/i)).toBeNull();
  });
});
