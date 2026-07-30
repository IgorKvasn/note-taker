import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  COMMAND_GET_ROOT_STATUS,
  COMMAND_SYNC_ROOT,
  EVENT_SYNC_STATUS,
  type RootStatus,
  type SyncState,
  type SyncStatusEvent,
} from "../ipc";
import "./RootSyncIndicator.css";

interface RootSyncIndicatorProps {
  rootId: string;
  /** Called after an automatic merge or a push-rejection recovery completes,
   * since either can rewrite files on disk underneath the open note (spec §7/§9.1). */
  onSyncSettled: () => void;
}

function labelFor(state: SyncState): string {
  switch (state.state) {
    case "syncing":
      return "Syncing…";
    case "synced":
      return "Synced";
    case "local_only":
      return "Local only";
    case "conflict":
      return "Conflict";
    case "error":
      return "Sync failed";
  }
}

/**
 * Per-root sync status, shown in that root's tree section header. Renders a
 * sensible default (`local_only`) at launch before `get_root_status` resolves,
 * rather than a blank/loading state -- most roots have no remote at all.
 */
export function RootSyncIndicator({ rootId, onSyncSettled }: RootSyncIndicatorProps) {
  const [state, setState] = useState<SyncState>({ state: "local_only" });

  useEffect(() => {
    invoke<RootStatus>(COMMAND_GET_ROOT_STATUS, { rootId })
      .then((status) => setState(status.sync_state))
      .catch(() => {});
  }, [rootId]);

  useEffect(() => {
    const pendingUnlisten = listen<SyncStatusEvent>(EVENT_SYNC_STATUS, (event) => {
      if (event.payload.root_id !== rootId) {
        return;
      }
      const nextState = event.payload.state;
      setState(nextState);
      // A merge or a rejected-push recovery may have just rewritten files on
      // disk out from under the open note -- refresh the tree once the sync
      // reaches a terminal state, not while it's still `syncing`.
      if (nextState.state !== "syncing") {
        onSyncSettled();
      }
    });

    return () => {
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootId, onSyncSettled]);

  const retry = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      invoke(COMMAND_SYNC_ROOT, { rootId }).catch(() => {});
    },
    [rootId],
  );

  const canRetry = state.state === "conflict" || state.state === "error";

  return (
    <span
      className="root-sync-indicator"
      data-sync-state={state.state}
      title={state.state === "error" ? state.stderr : undefined}
    >
      <span className="root-sync-indicator__dot" aria-hidden="true" />
      <span className="root-sync-indicator__label">{labelFor(state)}</span>
      {canRetry && (
        <button type="button" className="root-sync-indicator__retry" onClick={retry}>
          Retry
        </button>
      )}
    </span>
  );
}
