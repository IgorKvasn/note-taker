import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_READ_ATTACHMENT } from "../ipc";

/** A resolved attachment's state: the blob URL once fetched, `null` if
 * `read_attachment` rejected (file not found), `undefined` while the IPC
 * round trip is in flight. */
type AttachmentState = string | null | undefined;

/**
 * Caches `attachment:` blob URLs across notes in the same root (spec §11.4).
 *
 * Owned in `App.tsx`, above `NoteEditor` (which remounts on every note
 * switch via its `key` prop) and above `NoteView` (which remounts on every
 * Edit/Preview toggle) -- so a `blob:` URL survives both of those and is only
 * ever created once per `(rootId, id)` pair. `StrictMode`'s double-invoked
 * effects are harmless here: revocation is driven by cache eviction/root
 * change, not by an effect cleanup tied to a component's own mount.
 */
export function useAttachmentResolver(rootId: string) {
  const [, forceRender] = useState(0);
  // A ref, not state: mutating the cache must not itself be what triggers a
  // re-render (that would recreate the map on every resolve), and multiple
  // components read the same cache via `resolveAttachment` without each
  // needing their own copy.
  const cacheRef = useRef<Map<string, AttachmentState>>(new Map());
  const rootIdRef = useRef(rootId);

  const revokeAll = useCallback(() => {
    for (const value of cacheRef.current.values()) {
      if (typeof value === "string") {
        URL.revokeObjectURL(value);
      }
    }
    cacheRef.current = new Map();
  }, []);

  // A root change invalidates every cached blob URL: attachments are scoped
  // to the root they were read from, and a blob URL from a previous root
  // must not be handed back for an id that happens to collide in the new one.
  useEffect(() => {
    if (rootIdRef.current !== rootId) {
      revokeAll();
      rootIdRef.current = rootId;
      forceRender((count) => count + 1);
    }
  }, [rootId, revokeAll]);

  useEffect(() => revokeAll, [revokeAll]);

  const resolveAttachment = useCallback(
    (id: string): string | null | undefined => {
      const cached = cacheRef.current.get(id);
      if (cached !== undefined || cacheRef.current.has(id)) {
        return cached;
      }

      cacheRef.current.set(id, undefined);
      invoke<ArrayBuffer>(COMMAND_READ_ATTACHMENT, { rootId, id })
        .then((bytes) => {
          // The root may have changed while this was in flight; a stale
          // resolution must not populate the new root's cache.
          if (rootIdRef.current !== rootId) {
            return;
          }
          const blobUrl = URL.createObjectURL(new Blob([bytes]));
          cacheRef.current.set(id, blobUrl);
          forceRender((count) => count + 1);
        })
        .catch(() => {
          if (rootIdRef.current !== rootId) {
            return;
          }
          cacheRef.current.set(id, null);
          forceRender((count) => count + 1);
        });

      return undefined;
    },
    [rootId],
  );

  return resolveAttachment;
}
