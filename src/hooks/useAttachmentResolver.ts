import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_READ_ATTACHMENT } from "../ipc";

/** `null` once resolution has been tried and failed (or the id has no root to
 * resolve against); absent from the map entirely means resolution is in
 * flight -- `NoteView`'s `resolveAttachment` prop turns that absence into
 * `undefined` (spec §11.4). */
type CacheEntry = string | null;

/**
 * Resolves `attachment:` ids to displayable blob URLs, caching them by id
 * within the current root and revoking on cache eviction or root change --
 * never on a `NoteView` mount/unmount, since `NoteView` (and `NoteEditor`
 * above it) remount on every edit/preview toggle and every note switch, and
 * refetching + re-minting a blob URL on each of those would defeat the point
 * of caching at all (spec §11.4). So this hook is meant to be instantiated
 * once in `App.tsx`, which persists across both, and threaded down as a prop.
 *
 * Scoped to one root at a time: passing `null` (no note open) or a different
 * root revokes every cached URL from the previous root and starts empty --
 * an attachment id is only ever meaningful within the root that minted it.
 */
export function useAttachmentResolver(rootId: string | null) {
  const [cache, setCache] = useState<Map<string, CacheEntry>>(new Map());
  // Mirrors `cache` synchronously so the resolver (called during render, from
  // `NoteView`) can both read the latest state and decide whether a fetch is
  // already in flight without waiting for a state update to commit.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const rootIdRef = useRef(rootId);
  rootIdRef.current = rootId;
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      for (const url of cacheRef.current.values()) {
        if (url !== null) {
          URL.revokeObjectURL(url);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId]);

  // A root change (including to/from null) invalidates every cached id --
  // an attachment id from a previous root must never resolve as if it were
  // this root's. The revocation above runs on the *previous* rootId's effect
  // cleanup, so it revokes that root's URLs, not this one's.
  useEffect(() => {
    inFlightRef.current = new Set();
    setCache(new Map());
  }, [rootId]);

  const resolveAttachment = useCallback(
    (id: string): string | null | undefined => {
      const currentRootId = rootIdRef.current;
      if (currentRootId === null) {
        return null;
      }

      const cached = cacheRef.current.get(id);
      if (cached !== undefined) {
        return cached;
      }
      if (inFlightRef.current.has(id)) {
        return undefined;
      }

      inFlightRef.current.add(id);
      invoke<ArrayBuffer>(COMMAND_READ_ATTACHMENT, { rootId: currentRootId, id })
        .then((bytes) => {
          inFlightRef.current.delete(id);
          // The fetch may resolve after the root changed again; a stale
          // result must not populate the new root's (already-cleared) cache.
          if (rootIdRef.current !== currentRootId) {
            return;
          }
          const url = URL.createObjectURL(new Blob([bytes]));
          setCache((previous) => new Map(previous).set(id, url));
        })
        .catch(() => {
          inFlightRef.current.delete(id);
          if (rootIdRef.current !== currentRootId) {
            return;
          }
          setCache((previous) => new Map(previous).set(id, null));
        });

      return undefined;
    },
    [],
  );

  return { resolveAttachment };
}
