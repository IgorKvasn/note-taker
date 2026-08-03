import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  COMMAND_SCAN_LINKS,
  EVENT_SYNC_STATUS,
  type LinkedNote,
  type ScanLinksResult,
  type SyncStatusEvent,
} from "../ipc";

/** Shared so `linkableNotes` keeps one identity across renders with no scan yet. */
const EMPTY_NOTES: LinkedNote[] = [];

/** One row in a "Linked from" section (issue #50): the linking note's own
 * title/directory_path, not the target's -- these describe where the link
 * lives, so a reader can tell the notes apart before opening one. */
export interface BacklinkEntry {
  path: string;
  title: string;
  directory_path: string;
}

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

    // Mirrors the tree's own refresh triggers (`NotesPanel`): a settled sync,
    // and window focus as the catch-all for notes created, renamed or deleted
    // out of band -- otherwise a note added since the last sync is missing from
    // the picker, and links to it look broken.
    window.addEventListener("focus", scan);

    return () => {
      isCancelled = true;
      window.removeEventListener("focus", scan);
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

  const backlinks = useMemo(
    () => (scanned?.rootId === rootId ? scanned.result.backlinks : {}),
    [scanned, rootId],
  );

  const noteByPath = useMemo(() => {
    const map = new Map<string, LinkedNote>();
    for (const note of notes) {
      map.set(note.path, note);
    }
    return map;
  }, [notes]);

  /** Resolves a target note's ULID to the notes linking to it, one row per
   * linking note (spec-mirrored: `search.rs:18`). Sorted by title then path --
   * the same criteria `scan_links` itself sorts `notes` by -- so the list order
   * is stable between scans of an unchanged root. A linking path with no entry
   * in `notes` (its own frontmatter has no id yet) is omitted -- there is
   * nothing to show a title for. */
  const getBacklinks = useCallback(
    (noteId: string): BacklinkEntry[] => {
      const paths = backlinks[noteId] ?? [];
      const entries: BacklinkEntry[] = [];
      for (const path of paths) {
        const note = noteByPath.get(path);
        if (note !== undefined) {
          entries.push({ path: note.path, title: note.title, directory_path: note.directory_path });
        }
      }
      entries.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
      return entries;
    },
    [backlinks, noteByPath],
  );

  return { linkableNotes: notes, resolveNoteLink, getBacklinks };
}
