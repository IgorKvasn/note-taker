import { useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * Flushes the open note's pending autosave before a manual sync (issue #92);
   * resolves immediately if no note from this root is open. Omitted entirely
   * (rather than defaulted to a no-op) falls back to skipping the flush.
   */
  onFlushPendingSave?: (rootId: string) => Promise<void>;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Time-only (`14:32`) if `epochMillis` falls today, otherwise date+time
 * (`10 Aug 14:32`) -- both via `Intl.DateTimeFormat` under the system locale,
 * with no relative phrasing and no separate date library (issue #92). */
function formatSyncedAt(epochMillis: number): string {
  const date = new Date(epochMillis);
  return isSameDay(date, new Date()) ? timeFormatter.format(date) : dateTimeFormatter.format(date);
}

function labelFor(state: SyncState): string {
  switch (state.state) {
    case "syncing":
      return "Syncing…";
    case "synced":
      return state.last_synced === null ? "Never synced" : formatSyncedAt(state.last_synced);
    case "local_only":
      return "Local only";
    case "conflict":
      return "Conflict";
    case "error":
      return "Sync failed";
  }
}

/** Full date+time tooltip for the synced state, regardless of the shorter
 * label shown today -- distinct from `formatSyncedAt` so "today" is never
 * ambiguous even though the label omits the date. */
function titleFor(state: SyncState): string | undefined {
  switch (state.state) {
    case "synced":
      return state.last_synced === null ? undefined : dateTimeFormatter.format(new Date(state.last_synced));
    case "local_only":
      return "No remote configured for this root";
    case "error":
      return state.stderr;
    default:
      return undefined;
  }
}

function accessibleLabelFor(state: SyncState): string {
  if (state.state === "synced" && state.last_synced !== null) {
    return `Sync now (last synced ${formatSyncedAt(state.last_synced)})`;
  }
  return "Sync now";
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
export function RootSyncIndicator({
  rootId,
  onSyncSettled,
  onConflictedPathsChange,
  onFlushPendingSave,
}: RootSyncIndicatorProps) {
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

  // A repeat click while already syncing still runs this whole sequence again
  // rather than being guarded on the frontend -- the backend's busy/pending
  // coalescing (issue #86) already makes that cheap, per issue #92's spec.
  const onFlushPendingSaveRef = useRef(onFlushPendingSave);
  onFlushPendingSaveRef.current = onFlushPendingSave;

  const syncNow = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const flush = onFlushPendingSaveRef.current?.(rootId) ?? Promise.resolve();
      flush
        .catch(() => {})
        .then(() => invoke(COMMAND_SYNC_ROOT, { rootId }))
        .catch(() => {});
    },
    [rootId],
  );

  return (
    <span className="root-sync-indicator" data-sync-state={state.state} title={titleFor(state)}>
      <span className="root-sync-indicator__dot" aria-hidden="true" />
      <button
        type="button"
        className="root-sync-indicator__label"
        onClick={syncNow}
        disabled={state.state === "local_only"}
        aria-label={accessibleLabelFor(state)}
      >
        {labelFor(state)}
      </button>
      {conflictedPaths.length > 0 && (
        <span className="root-sync-indicator__resolution-count">{resolutionLabel(conflictedPaths)}</span>
      )}
    </span>
  );
}
