import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootSyncIndicator } from "./RootSyncIndicator";
import type { RootStatus, SyncStatusEvent } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const ROOT_ID = "01ROOT";

function mockStatus(status: RootStatus) {
  invoke.mockImplementation((command: string) => {
    if (command === "get_root_status") return Promise.resolve(status);
    return Promise.resolve(undefined);
  });
}

/** Fires a `sync-status` event through whichever handler the indicator registered. */
async function emitSyncStatus(payload: Omit<SyncStatusEvent, "origin_paths">) {
  await waitFor(() => expect(listen).toHaveBeenCalled());
  const handler = listen.mock.calls[0][1] as (event: { payload: SyncStatusEvent }) => void;
  handler({ payload: { origin_paths: [], ...payload } });
}

describe("RootSyncIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
  });

  it("shows local_only before get_root_status resolves and after it resolves to local_only", async () => {
    mockStatus({ conflicted_paths: [], sync_state: { state: "local_only" } });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);

    expect(await screen.findByText("Local only")).not.toBeNull();
  });

  it("reflects a conflict status from get_root_status and offers a retry", async () => {
    mockStatus({ conflicted_paths: ["shared.md"], sync_state: { state: "conflict" } });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);

    await screen.findByText("Conflict");
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
  });

  it("updates to syncing then synced as sync-status events arrive, calling onSyncSettled on the terminal state", async () => {
    mockStatus({ conflicted_paths: [], sync_state: { state: "local_only" } });
    const onSyncSettled = vi.fn();
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={onSyncSettled} />);
    await screen.findByText("Local only");

    await emitSyncStatus({ root_id: ROOT_ID, state: { state: "syncing" } });
    expect(await screen.findByText("Syncing…")).not.toBeNull();
    expect(onSyncSettled).not.toHaveBeenCalled();

    await emitSyncStatus({ root_id: ROOT_ID, state: { state: "synced" } });
    expect(await screen.findByText("Synced")).not.toBeNull();
    expect(onSyncSettled).toHaveBeenCalledTimes(1);
  });

  it("ignores sync-status events for a different root", async () => {
    mockStatus({ conflicted_paths: [], sync_state: { state: "local_only" } });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);
    await screen.findByText("Local only");

    await emitSyncStatus({ root_id: "01OTHER-ROOT", state: { state: "synced" } });

    expect(screen.getByText("Local only")).not.toBeNull();
  });

  it("shows the raw stderr as a title on an error state and clicking retry calls sync_root", async () => {
    mockStatus({ conflicted_paths: [], sync_state: { state: "error", stderr: "permission denied" } });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);

    const indicator = (await screen.findByText("Sync failed")).closest(".root-sync-indicator");
    expect(indicator?.getAttribute("title")).toBe("permission denied");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(invoke).toHaveBeenCalledWith("sync_root", { rootId: ROOT_ID });
  });

  it("shows a resolution count and reports the conflicted paths when the root has conflicts", async () => {
    mockStatus({ conflicted_paths: ["a.md", "b.md"], sync_state: { state: "conflict" } });
    const onConflictedPathsChange = vi.fn();
    render(
      <RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} onConflictedPathsChange={onConflictedPathsChange} />,
    );

    expect(await screen.findByText("2 notes need resolution")).not.toBeNull();
    await waitFor(() => expect(onConflictedPathsChange).toHaveBeenCalledWith(["a.md", "b.md"]));
  });

  it("shows no resolution count when the root has no conflicts", async () => {
    mockStatus({ conflicted_paths: [], sync_state: { state: "local_only" } });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);

    await screen.findByText("Local only");
    expect(screen.queryByText(/notes need resolution/)).toBeNull();
  });

  it("re-fetches root status and updates the resolution count when a sync-status event settles", async () => {
    let status: RootStatus = { conflicted_paths: ["a.md"], sync_state: { state: "conflict" } };
    invoke.mockImplementation((command: string) => {
      if (command === "get_root_status") return Promise.resolve(status);
      return Promise.resolve(undefined);
    });
    render(<RootSyncIndicator rootId={ROOT_ID} onSyncSettled={() => {}} />);
    await screen.findByText("1 note needs resolution");

    status = { conflicted_paths: [], sync_state: { state: "synced" } };
    await emitSyncStatus({ root_id: ROOT_ID, state: { state: "synced" } });

    await waitFor(() => expect(screen.queryByText(/needs? resolution/)).toBeNull());
  });
});
