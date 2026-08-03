import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  COMMAND_MARK_RESOLVED,
  COMMAND_OPEN_NOTE,
  COMMAND_SAVE_NOTE,
  EVENT_SYNC_STATUS,
  type EditorMode,
  type OpenNoteResult,
  type SyncStatusEvent,
} from "../ipc";
import { markdownLivePreview } from "./markdownLivePreview";
import { noteEditorKeymap } from "./noteEditorKeymap";
import { NoteToolbar } from "./NoteToolbar";
import { NoteView } from "./NoteView";
import { BacklinksSection } from "./BacklinksSection";
import { useNoteLinks } from "../hooks/useNoteLinks";
import "./NoteEditor.css";

/** Debounce window between the last keystroke and the autosave `save_note` call. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Delay before retrying a failed autosave, so a persistent failure (e.g. a
 * removed root) doesn't spin -- retries continue until either the save
 * succeeds or the pending content is superseded by a new edit. */
const SAVE_RETRY_MS = 5000;

/** Tags a dispatch as loading content from disk rather than a user edit, so
 * the update listener below doesn't arm an autosave for our own content-load
 * or sync-triggered refresh writes. */
const remoteContentLoad = Annotation.define<boolean>();

/** Places the cursor at `offset` and scrolls it into view, clamping to the
 * document's length since a stale offset (content changed since it was
 * computed) must not throw. */
function moveCursorTo(view: EditorView, offset: number | undefined) {
  if (offset === undefined) {
    return;
  }
  const clamped = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: clamped },
    effects: EditorView.scrollIntoView(clamped, { y: "center" }),
  });
  view.focus();
}

interface NoteEditorProps {
  rootId: string;
  path: string;
  /**
   * Edit/preview mode (issue #37): a global setting owned by the caller, not
   * local state here, so it carries over when switching between notes.
   */
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  /** Called when `open_note` rejects, e.g. a persisted last-open note whose file was deleted. */
  onOpenError?: () => void;
  /**
   * A character offset to move the cursor to and scroll into view once the
   * note's content has loaded -- used by search result clicks to land on the
   * first match (spec §8). Re-applied whenever the value changes, including
   * repeat clicks on the same result for the same open note.
   */
  scrollToOffset?: number;
  /**
   * Opens another note in the same root, for clicks on a `note:` cross-link
   * (issue #49). Takes a root-relative path, matching the addressing every
   * other command uses (spec §9.2).
   */
  onOpenNoteLink?: (rootId: string, path: string) => void;
}

/**
 * A direct CodeMirror 6 wrapper around a ref/`useEffect`, deliberately not
 * `@uiw/react-codemirror`: the formatting toolbar dispatches CM6 transactions
 * straight against this view, and a wrapper library would be an abstraction
 * to reach through (spec §1, §5).
 */
export function NoteEditor({
  rootId,
  path,
  mode,
  onModeChange,
  onOpenError,
  scrollToOffset,
  onOpenNoteLink,
}: NoteEditorProps) {
  const { linkableNotes, resolveNoteLink, getBacklinks } = useNoteLinks(rootId);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read once the initial `open_note` resolves, inside the mount effect below --
  // a ref rather than a dependency so the mount effect doesn't re-run on every
  // scrollToOffset change (that's the second effect's job).
  const scrollToOffsetRef = useRef(scrollToOffset);
  scrollToOffsetRef.current = scrollToOffset;
  const pendingSaveRef = useRef<{ rootId: string; path: string; content: string } | null>(null);
  // Set true by the mount effect's cleanup below; checked both there (as
  // `isCancelled`, its own closure copy) and inside `flushPendingSave`'s retry
  // `.catch`, which runs outside that effect and so needs this ref -- a plain
  // closure variable wouldn't be reachable from it.
  const isUnmountedRef = useRef(false);
  // Both the initial `open_note` load and the sync-status-triggered re-fetch
  // read disk asynchronously and can resolve out of order -- bumped whenever
  // either one starts, so a resolution can check it's still the latest before
  // applying its content and not overwrite a newer read with a stale one.
  const loadGenerationRef = useRef(0);
  const [view, setView] = useState<EditorView | null>(null);
  const [content, setContent] = useState("");
  const [isConflicted, setIsConflicted] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The open note's own frontmatter id (always non-empty -- `open_note`
  // backfills one), used to look up who links here (issue #50).
  const [noteId, setNoteId] = useState<string | null>(null);

  /** Returns a promise that resolves once any pending autosave has been sent
   * (and settled) -- callers that need the disk write to land first (e.g.
   * mark_resolved reading the file back) must await it; unmount cleanup fires
   * it without waiting, since nothing there depends on the ordering.
   *
   * On failure, the pending content is put back so a later flush (the next
   * debounce tick, or the next manual flush) retries it instead of the
   * content being silently dropped (issue #46) -- this resolves rather than
   * rejects even on failure so callers awaiting it (e.g. markResolved's
   * chain) don't treat a save failure as their own failure.
   */
  const flushPendingSave = () => {
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (pending === null) {
      return Promise.resolve();
    }
    pendingSaveRef.current = null;
    return invoke(COMMAND_SAVE_NOTE, pending)
      .then(() => {
        if (!isUnmountedRef.current) {
          setSaveError(null);
        }
      })
      .catch((error: unknown) => {
        if (isUnmountedRef.current) {
          return;
        }
        if (pendingSaveRef.current === null) {
          pendingSaveRef.current = pending;
          saveTimeoutRef.current = setTimeout(flushPendingSave, SAVE_RETRY_MS);
        }
        setSaveError(error instanceof Error ? error.message : String(error));
      });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    isUnmountedRef.current = false;
    let isCancelled = false;

    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          // Registered ahead of defaultKeymap/historyKeymap: keymap precedence
          // follows extension order, and Mod-i must win over CodeMirror's
          // default `selectParentSyntax` binding.
          keymap.of([...noteEditorKeymap, ...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          markdownLivePreview,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((tr) => tr.annotation(remoteContentLoad))) {
              return;
            }
            const updatedContent = update.state.doc.toString();
            setContent(updatedContent);
            pendingSaveRef.current = { rootId, path, content: updatedContent };
            if (saveTimeoutRef.current !== null) {
              clearTimeout(saveTimeoutRef.current);
            }
            saveTimeoutRef.current = setTimeout(flushPendingSave, AUTOSAVE_DEBOUNCE_MS);
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    setView(view);

    setIsConflicted(false);
    setResolveError(null);

    const loadGeneration = ++loadGenerationRef.current;

    invoke<OpenNoteResult>(COMMAND_OPEN_NOTE, { rootId, path })
      .then((result) => {
        if (isCancelled || loadGeneration !== loadGenerationRef.current) {
          return;
        }
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: result.content },
          annotations: remoteContentLoad.of(true),
        });
        setContent(result.content);
        setIsConflicted(result.is_conflicted);
        setNoteId(result.id);
        moveCursorTo(view, scrollToOffsetRef.current);
      })
      .catch(() => {
        if (!isCancelled) {
          onOpenError?.();
        }
      });

    return () => {
      isCancelled = true;
      flushPendingSave();
      isUnmountedRef.current = true;
      view.destroy();
      viewRef.current = null;
      setView(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, path]);

  // Re-applies on every `scrollToOffset` change while the note stays open (a
  // repeat click on a search result for the already-open note), not just on
  // initial load -- the effect above only runs when `rootId`/`path` change.
  useEffect(() => {
    if (viewRef.current !== null) {
      moveCursorTo(viewRef.current, scrollToOffset);
    }
  }, [scrollToOffset]);

  // A background sync (autosave-triggered push, retry, or another note's
  // mark_resolved finishing the merge) may rewrite this file on disk after
  // it was already loaded -- re-fetch so a clean save that lands mid-merge
  // re-renders into the conflict view in place, with no interrupting modal.
  useEffect(() => {
    let isCancelled = false;

    const pendingUnlisten = listen<SyncStatusEvent>(EVENT_SYNC_STATUS, (event) => {
      if (event.payload.root_id !== rootId || event.payload.state.state === "syncing") {
        return;
      }
      // Skip while the user has an edit in flight -- disk content is stale
      // relative to what they're typing, and overwriting it would both
      // discard the keystrokes and re-save that stale content underneath them.
      if (pendingSaveRef.current !== null) {
        return;
      }
      const loadGeneration = ++loadGenerationRef.current;
      invoke<OpenNoteResult>(COMMAND_OPEN_NOTE, { rootId, path })
        .then((result) => {
          // The effect's own `rootId`/`path` deps already scope this listener
          // to the note that was open when it was registered, but the async
          // round-trip can still resolve after the user switched notes, or
          // after a newer load (the initial one, or another sync-status tick).
          if (
            isCancelled ||
            viewRef.current === null ||
            pendingSaveRef.current !== null ||
            loadGeneration !== loadGenerationRef.current
          ) {
            return;
          }
          const view = viewRef.current;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: result.content },
            annotations: remoteContentLoad.of(true),
          });
          setContent(result.content);
          setIsConflicted(result.is_conflicted);
        })
        .catch(() => {});
    });

    return () => {
      isCancelled = true;
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootId, path]);

  const backlinkEntries = noteId === null ? [] : getBacklinks(noteId);

  const markResolved = useCallback(() => {
    setResolveError(null);
    // The user's hand-edit removing the markers is likely still sitting in
    // the debounce window -- mark_resolved reads the file from disk, so the
    // flush must land before it runs, not merely be fired-and-forgotten.
    flushPendingSave()
      .then(() => invoke(COMMAND_MARK_RESOLVED, { rootId, path }))
      .then(() => setIsConflicted(false))
      .catch((error: unknown) => setResolveError(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, path]);

  return (
    <div className="note-editor">
      <div className="note-editor__chrome">
        {mode === "edit" && <NoteToolbar view={view} linkableNotes={linkableNotes} />}
        {isConflicted && (
          <button type="button" className="note-editor__mark-resolved" onClick={markResolved}>
            Mark resolved
          </button>
        )}
        <button
          type="button"
          className="note-editor__mode-toggle"
          onClick={() => onModeChange(mode === "edit" ? "view" : "edit")}
        >
          {mode === "edit" ? "Preview" : "Edit"}
        </button>
      </div>
      {resolveError !== null && (
        <p role="alert" className="note-editor__resolve-error">
          {resolveError}
        </p>
      )}
      {saveError !== null && (
        <p role="alert" className="note-editor__save-error">
          Autosave failed, retrying: {saveError}
        </p>
      )}
      <div className="note-editor__body">
        <div
          className="note-editor__cm-host"
          data-testid="note-editor"
          ref={hostRef}
          hidden={mode !== "edit"}
        />
        {mode === "view" && (
          <NoteView
            content={content}
            resolveNoteLink={resolveNoteLink}
            onOpenNoteLink={(targetPath) => onOpenNoteLink?.(rootId, targetPath)}
          />
        )}
      </div>
      {backlinkEntries.length > 0 && (
        <BacklinksSection entries={backlinkEntries} onSelect={(targetPath) => onOpenNoteLink?.(rootId, targetPath)} />
      )}
    </div>
  );
}
