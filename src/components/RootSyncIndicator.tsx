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
  /** Called whenever the root's conflicted-file list is (re)fetched, so a
   * parent can drive a one-time toast per affected root (issue #26). */
  onConflictedPathsChange?: (paths: string[]) => void;
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

function resolutionLabel(conflictedPaths: string[]): string {
  const count = conflictedPaths.length;
  return `${count} ${count === 1 ? "note needs" : "notes need"} resolution`;
}

/**
 * Per-root sync status, shown in that root's tree section header. Renders a
 * sensible default (`local_only`) at launch before `get_root_status` resolves,
 * rather than a blank/loading state -- most roots have no remote at all.
 */
export function RootSyncIndicator({ rootId, onSyncSettled, onConflictedPathsChange }: RootSyncIndicatorProps) {
  const [state, setState] = useState<SyncState>({ state: "local_only" });
  const [conflictedPaths, setConflictedPaths] = useState<string[]>([]);

  const fetchConflictedPaths = useCallback(() => {
    return invoke<RootStatus>(COMMAND_GET_ROOT_STATUS, { rootId })
      .then((status) => {
        setConflictedPaths(status.conflicted_paths);
        onConflictedPathsChange?.(status.conflicted_paths);
      })
      .catch(() => {});
  }, [rootId, onConflictedPathsChange]);

  useEffect(() => {
    invoke<RootStatus>(COMMAND_GET_ROOT_STATUS, { rootId })
      .then((status) => {
        setState(status.sync_state);
        setConflictedPaths(status.conflicted_paths);
        onConflictedPathsChange?.(status.conflicted_paths);
      })
      .catch(() => {});
    // Only re-run when the root itself changes -- `onConflictedPathsChange`
    // re-render identity must not re-trigger the initial fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId]);

  useEffect(() => {
    const pendingUnlisten = listen<SyncStatusEvent>(EVENT_SYNC_STATUS, (event) => {
      if (event.payload.root_id !== rootId) {
        return;
      }
      const nextState = event.payload.state;
      setState(nextState);
      if (nextState.state === "syncing") {
        return;
      }
      // A merge, a rejected-push recovery, or a mark_resolved call may have
      // just rewritten files on disk (or the conflicted-file list) underneath
      // the open note -- refresh both once the sync reaches a terminal state.
      // The state itself already came from the event, so only the conflicted
      // paths (which the event doesn't carry) need a fresh fetch.
      onSyncSettled();
      fetchConflictedPaths();
    });

    return () => {
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootId, onSyncSettled, fetchConflictedPaths]);

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
      {conflictedPaths.length > 0 && (
        <span className="root-sync-indicator__resolution-count">{resolutionLabel(conflictedPaths)}</span>
      )}
    </span>
  );
}
