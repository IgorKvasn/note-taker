import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { COMMAND_SCAN_LINKS, EVENT_SYNC_STATUS, type LinkedNote, type ScanLinksResult, type SyncStatusEvent } from "../ipc";

/** Stable identity, so a root with no scan yet doesn't rebuild the map each render. */
const EMPTY_NOTES: LinkedNote[] = [];

/**
 * Caches one root's `note:` link map, re-scanning when a sync settles.
 *
 * The cache lives here rather than in the backend deliberately: a `git pull`
 * changing files behind the app's back is exactly the case a backend cache
 * would get silently wrong, and a full-root scan per tree change is well within
 * this app's scale (`search_notes` already scans every root per keystroke).
 */
export function useNoteLinks(rootId: string) {
  // The scanned root is stored alongside its result so a map can never outlive
  // the root it came from. Links are same-root only, and resolving one root's
  // ULID against another's map is exactly the cross-root leak that forbids.
  // `NoteEditor` currently remounts on a root change anyway, but that is a
  // `key` prop in a different file -- not something to rest this on.
  const [scanned, setScanned] = useState<{ rootId: string; result: ScanLinksResult } | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const scan = () => {
      invoke<ScanLinksResult>(COMMAND_SCAN_LINKS, { rootId })
        .then((result) => {
          // Treat a malformed response like a failed scan rather than letting it
          // reach the resolver -- links go inert, the view still renders.
          if (!isCancelled && Array.isArray(result?.notes)) {
            setScanned({ rootId, result });
          }
        })
        // A failed scan leaves the previous map in place; links stay resolvable
        // rather than all going broken at once on a transient error.
        .catch(() => {});
    };

    scan();

    const pendingUnlisten = listen<SyncStatusEvent>(EVENT_SYNC_STATUS, (event) => {
      if (event.payload.root_id === rootId && event.payload.state.state !== "syncing") {
        scan();
      }
    });

    return () => {
      isCancelled = true;
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootId]);

  const notes = useMemo(
    () => (scanned?.rootId === rootId ? scanned.result.notes : EMPTY_NOTES),
    [scanned, rootId],
  );

  const pathsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of notes) {
      map.set(note.id, note.path);
    }
    return map;
  }, [notes]);

  const resolveNoteLink = useCallback((id: string) => pathsById.get(id) ?? null, [pathsById]);

  return { linkableNotes: notes, resolveNoteLink };
}
