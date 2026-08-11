import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  COMMAND_MARK_RESOLVED,
  COMMAND_OPEN_NOTE,
  COMMAND_PICK_IMAGE_FILE,
  COMMAND_SAVE_NOTE,
  COMMAND_WRITE_ATTACHMENT,
  EVENT_SYNC_STATUS,
  type EditorMode,
  type OpenNoteResult,
  type PickedFile,
  type SyncStatusEvent,
} from "../ipc";
import { attachmentTarget, formatAttachment } from "./attachments";
import { handleAttachmentDrop, isWithinRect } from "./attachmentDrop";
import { handleAttachmentPaste } from "./attachmentPaste";
import { markdownLivePreview } from "./markdownLivePreview";
import { noteEditorKeymap } from "./noteEditorKeymap";
import { NoteToolbar } from "./NoteToolbar";
import { BacklinksSection } from "./BacklinksSection";
import { useNoteLinks } from "../hooks/useNoteLinks";
import { Spinner } from "./Spinner";
import "./NoteEditor.css";

// Code-split alongside the editor itself: the markdown renderer and its syntax
// highlighter are only reachable in preview mode, so an edit-only session never
// pays for them.
const NoteView = lazy(() => import("./NoteView").then((module) => ({ default: module.NoteView })));

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

/** CodeMirror's `Text` model always joins lines with `\n` (there's no
 * lineSeparator facet configured here), so a note with CRLF line endings on
 * disk would compare unequal to itself, and diff to a spurious full-document
 * change, without normalizing first. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Replaces the whole document with freshly-read disk content, but only if
 * it actually differs from what's already in the buffer -- an identical
 * whole-document replacement still diffs down to an empty change, but
 * CodeMirror resets the selection to 0 regardless, moving the caret even
 * though nothing actually changed. Used for the initial load of a note,
 * where there's no prior buffer content worth preserving a caret/selection
 * relative to. */
function replaceContentIfChanged(view: EditorView, content: string) {
  if (normalizeLineEndings(view.state.doc.toString()) === normalizeLineEndings(content)) {
    return;
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    annotations: remoteContentLoad.of(true),
  });
}

/** True if trimming the shared prefix/suffix at `index` (a UTF-16 code unit
 * offset into both strings, which share every character up to the smaller of
 * the two lengths at this boundary) would split a surrogate pair -- i.e.
 * `index` falls right after a high surrogate that's followed by its low
 * surrogate. Both strings agree on that pairing at a shared boundary, so
 * checking either is equivalent; `text` is passed explicitly to avoid an
 * extra parameter of "which string". */
function splitsSurrogatePair(text: string, index: number): boolean {
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
}

/** Finds the smallest single `{from, to, insert}` region that turns `oldText`
 * into `newText`, by trimming the longest shared prefix and (from what's left)
 * the longest shared suffix. Used within a single diff hunk (already known to
 * be a contiguous changed run of lines from `diffLines` below), where it
 * tightens a whole-line-range replacement down to just the changed word or
 * phrase inside it. */
function minimalReplaceRegion(oldText: string, newText: string): { from: number; to: number; insert: string } {
  let prefixLength = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefixLength < maxPrefix && oldText[prefixLength] === newText[prefixLength]) {
    prefixLength += 1;
  }
  if (splitsSurrogatePair(oldText, prefixLength)) {
    prefixLength -= 1;
  }

  let suffixLength = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefixLength;
  while (
    suffixLength < maxSuffix &&
    oldText[oldText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  if (splitsSurrogatePair(oldText, oldText.length - suffixLength)) {
    suffixLength -= 1;
  }

  return {
    from: prefixLength,
    to: oldText.length - suffixLength,
    insert: newText.slice(prefixLength, newText.length - suffixLength),
  };
}

/** Splits text into lines, each retaining its trailing `\n` (the last line
 * doesn't have one) -- keeping the separator on each entry means concatenating
 * a slice of lines reproduces the exact original substring, so line indices
 * convert directly to character offsets by summing lengths. */
function splitIntoLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) => (index < lines.length - 1 ? line + "\n" : line));
}

/** Longest common subsequence of two line arrays, as the classic DP table
 * (`table[i][j]` = LCS length of `oldLines[i..]` and `newLines[j..]`). This is
 * O(n*m), so callers must first trim any shared prefix/suffix lines (see
 * `diffLines` below) to keep the table sized to just the changed span rather
 * than the whole document. */
function longestCommonSubsequenceTable(oldLines: readonly string[], newLines: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** A contiguous run of changed lines: `[oldLineStart, oldLineEnd)` in
 * `oldLines` is replaced by `[newLineStart, newLineEnd)` in `newLines`. */
interface LineHunk {
  oldLineStart: number;
  oldLineEnd: number;
  newLineStart: number;
  newLineEnd: number;
}

/** Runs the LCS table + hunk walk on the full (already-trimmed) line arrays;
 * split out from `diffLines` so the trimming there can shrink its input
 * first without complicating this walk with offset bookkeeping. */
function diffTrimmedLines(oldLines: readonly string[], newLines: readonly string[]): LineHunk[] {
  const table = longestCommonSubsequenceTable(oldLines, newLines);
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const oldLineStart = i;
    const newLineStart = j;
    while (
      (i < oldLines.length || j < newLines.length) &&
      !(i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j])
    ) {
      // Follow whichever branch the LCS table says preserves the longest
      // remaining common subsequence, matching how the table was filled.
      if (j >= newLines.length || (i < oldLines.length && table[i + 1][j] >= table[i][j + 1])) {
        i += 1;
      } else {
        j += 1;
      }
    }
    hunks.push({ oldLineStart, oldLineEnd: i, newLineStart, newLineEnd: j });
  }
  return hunks;
}

/** Diffs two line arrays into hunks, walking the LCS table to collect maximal
 * runs of non-matching lines -- unlike a single prefix/suffix trim over the
 * whole text, this keeps multiple unrelated changes (e.g. a fix near the top
 * and an appended line at the bottom) as separate hunks instead of collapsing
 * everything between them into one giant replaced region.
 *
 * Before building the O(n*m) LCS table, shared leading and trailing lines are
 * trimmed off first -- the common case is a sync bringing in a small, local
 * change to an otherwise-unchanged note, so this keeps the table (and its
 * runtime) sized to just the changed span rather than the whole document. */
function diffLines(oldLines: readonly string[], newLines: readonly string[]): LineHunk[] {
  const maxCommon = Math.min(oldLines.length, newLines.length);

  let commonPrefix = 0;
  while (commonPrefix < maxCommon && oldLines[commonPrefix] === newLines[commonPrefix]) {
    commonPrefix += 1;
  }

  let commonSuffix = 0;
  const maxSuffix = maxCommon - commonPrefix;
  while (
    commonSuffix < maxSuffix &&
    oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }

  const trimmedOldLines = oldLines.slice(commonPrefix, oldLines.length - commonSuffix);
  const trimmedNewLines = newLines.slice(commonPrefix, newLines.length - commonSuffix);

  return diffTrimmedLines(trimmedOldLines, trimmedNewLines).map((hunk) => ({
    oldLineStart: hunk.oldLineStart + commonPrefix,
    oldLineEnd: hunk.oldLineEnd + commonPrefix,
    newLineStart: hunk.newLineStart + commonPrefix,
    newLineEnd: hunk.newLineEnd + commonPrefix,
  }));
}

/** Converts each line-level hunk into a character-offset `{from, to, insert}`
 * change against `oldText`, tightened via `minimalReplaceRegion` so a hunk
 * that only changes a word within otherwise-identical lines doesn't replace
 * those lines wholesale. */
function hunksToChanges(
  hunks: readonly LineHunk[],
  oldLines: readonly string[],
  newLines: readonly string[],
): { from: number; to: number; insert: string }[] {
  const oldLineOffsets = [0];
  for (const line of oldLines) {
    oldLineOffsets.push(oldLineOffsets[oldLineOffsets.length - 1] + line.length);
  }

  return hunks.map((hunk) => {
    const from = oldLineOffsets[hunk.oldLineStart];
    const oldSlice = oldLines.slice(hunk.oldLineStart, hunk.oldLineEnd).join("");
    const newSlice = newLines.slice(hunk.newLineStart, hunk.newLineEnd).join("");
    const region = minimalReplaceRegion(oldSlice, newSlice);
    return { from: from + region.from, to: from + region.to, insert: region.insert };
  });
}

/** Applies freshly-read disk content for a note that's already open, as a
 * set of minimal per-hunk changes rather than a whole-document replacement
 * (issue #63) -- a no-op when the content, modulo line-ending normalization,
 * hasn't actually changed. The diff runs against `view.state.doc.toString()`,
 * which (like `content` once normalized) always uses `\n`, so the computed
 * offsets are valid to dispatch straight against the live document --
 * diffing against a separately-normalized copy of the old text would compute
 * offsets in the wrong coordinate space whenever disk content has CRLF
 * endings. Dispatching only the changed regions, with no explicit
 * `selection`, lets CodeMirror map the caret and selection through the
 * change the same way it does for a local edit: untouched if every change
 * falls elsewhere, shifted if a change is before the caret, landing inside a
 * hunk's replacement if the caret was inside it. Scroll position is left
 * alone for the same reason -- no `scrollIntoView` effect is added.
 * `addToHistory: false` keeps the sync out of undo history, so undo still
 * walks back through the user's own edits rather than dead-ending here. */
function applyRemoteChangeIfChanged(view: EditorView, content: string) {
  const oldText = view.state.doc.toString();
  const newText = normalizeLineEndings(content);
  if (oldText === newText) {
    return;
  }
  const oldLines = splitIntoLines(oldText);
  const newLines = splitIntoLines(newText);
  const changes = hunksToChanges(diffLines(oldLines, newLines), oldLines, newLines);
  view.dispatch({
    changes,
    annotations: [remoteContentLoad.of(true), Transaction.addToHistory.of(false)],
  });
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
  /**
   * Resolves an `attachment:` id to a displayable image URL for preview mode
   * (issue #75). Owned by `App.tsx`, not here -- this component remounts on
   * every note switch, so a cache living here would refetch on every switch.
   */
  resolveAttachment?: (id: string) => string | null | undefined;
  /**
   * Reports the live buffer's content on every change, including content not
   * yet flushed to disk -- attachment cleanup (issue #79) reads this so a
   * reference existing only in an unsaved buffer isn't treated as orphaned.
   */
  onContentChange?: (content: string) => void;
  /** Called once the first time this note switches to preview mode -- attachment
   * cleanup (issue #79) is triggered on the first preview-switch of any note. */
  onFirstPreview?: () => void;
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
  resolveAttachment,
  onContentChange,
  onFirstPreview,
}: NoteEditorProps) {
  const { linkableNotes, resolveNoteLink, getBacklinks } = useNoteLinks(rootId);
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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
  // Tracks only the initial `open_note` load (issue #60) -- the sync-status
  // re-fetch below is a background refresh of an already-open note, not a
  // state worth surfacing loading feedback for.
  const [isLoading, setIsLoading] = useState(true);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The open note's own frontmatter id (always non-empty -- `open_note`
  // backfills one), used to look up who links here (issue #50).
  const [noteId, setNoteId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Hover affordance for the native drag-drop event (issue #78): true only
  // while a drag is over the editor pane specifically, not the whole webview.
  const [isDragOver, setIsDragOver] = useState(false);
  // Disables the toolbar's image button for the duration of a pick+write, in
  // addition to the existing view === null rule (issue #75) -- a second click
  // mid-write would otherwise fire a second file dialog on top of the first.
  const [isAttaching, setIsAttaching] = useState(false);

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
          EditorView.domEventHandlers({
            paste: (event, editorView) => {
              // Claimed pastes (image bytes, a file:// path, or an empty
              // DataTransfer needing a backend clipboard read) call
              // preventDefault synchronously inside handleAttachmentPaste
              // before any async work starts (issues #77, #91); an unclaimed
              // paste falls through to CodeMirror's own handling untouched.
              return handleAttachmentPaste(event, editorView, rootId, {
                onImportError: (error) => setAttachmentError(error),
              });
            },
          }),
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
    setIsLoading(true);

    const loadGeneration = ++loadGenerationRef.current;

    invoke<OpenNoteResult>(COMMAND_OPEN_NOTE, { rootId, path })
      .then((result) => {
        if (isCancelled || loadGeneration !== loadGenerationRef.current) {
          return;
        }
        replaceContentIfChanged(view, result.content);
        setContent(result.content);
        setIsConflicted(result.is_conflicted);
        setNoteId(result.id);
        setIsLoading(false);
        moveCursorTo(view, scrollToOffsetRef.current);
      })
      .catch(() => {
        if (!isCancelled) {
          setIsLoading(false);
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

  // Reports the live buffer on every change (initial load, local edits, and
  // remote refreshes alike) -- attachment cleanup (issue #79) reads this as
  // an extra reference source so a reference only in an unsaved buffer isn't
  // treated as orphaned.
  useEffect(() => {
    onContentChange?.(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

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
      // The backend omits a path from origin_paths whenever a merge ran during
      // that sync (issue #64), since a merge can rewrite any tracked file with
      // remote-side content. So this note's path showing up here guarantees its
      // own save is the only thing that touched its disk content this run --
      // re-reading would be a no-op at best.
      if (event.payload.origin_paths.includes(path)) {
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
          applyRemoteChangeIfChanged(viewRef.current, result.content);
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

  // Drag-and-drop (issue #78): handled exclusively via Tauri's native,
  // webview-scoped drag-drop event -- never DOM dragover/drop listeners --
  // since that's the only way to get real file paths for `import_attachment`
  // rather than opaque `File` blobs. Because the event fires regardless of
  // which pane the pointer is over, every event is hit-tested against the
  // editor pane's bounds inside `handleAttachmentDrop`, so hovering or
  // dropping over the notes tree is a no-op here and doesn't interfere with
  // the tree's own DOM-based move-drag handling.
  useEffect(() => {
    const pendingUnlisten = getCurrentWebview().onDragDropEvent((event) => {
      const body = bodyRef.current;
      const view = viewRef.current;
      if (body === null || view === null) {
        return;
      }

      if (event.payload.type === "leave") {
        setIsDragOver(false);
        return;
      }

      // The event reports device pixels; getBoundingClientRect/posAtCoords
      // both operate in CSS pixels, so the position must be converted before
      // any hit-testing or coordinate-to-editor-offset lookup.
      const scaleFactor = window.devicePixelRatio || 1;
      const logicalPosition = event.payload.position.toLogical(scaleFactor);
      const rect = body.getBoundingClientRect();
      const isOver = isWithinRect(logicalPosition, rect);

      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDragOver(isOver);
        return;
      }

      // event.payload.type === "drop"
      setIsDragOver(false);
      handleAttachmentDrop(event.payload.paths, logicalPosition, view, rect, rootId, {
        onImportError: (message) => setAttachmentError(message),
      });
    });

    return () => {
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [rootId]);

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

  /**
   * Toolbar image button (issue #75): opens the native file picker, writes
   * the chosen file into `.attachments/`, and inserts `![name](attachment:id)`
   * at the cursor with the cursor placed after. A cancelled dialog and a
   * failed write both leave the document and cursor untouched; a failed
   * write surfaces its error in local state rather than a toast, matching
   * `NotesPanel`'s delete-failure handling.
   */
  const attachImageFile = useCallback(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }

    setAttachmentError(null);
    setIsAttaching(true);

    invoke<PickedFile | null>(COMMAND_PICK_IMAGE_FILE)
      .then((picked) => {
        if (picked === null) {
          return;
        }
        return invoke<string>(COMMAND_WRITE_ATTACHMENT, {
          rootId,
          bytes: picked.bytes,
          originalName: picked.name,
        }).then((reference) => {
          const currentView = viewRef.current;
          if (currentView === null) {
            return;
          }
          const id = attachmentTarget(reference) ?? reference;
          const pos = currentView.state.selection.main.head;
          const insert = formatAttachment(picked.name, id);
          currentView.dispatch({
            changes: { from: pos, to: pos, insert },
            selection: { anchor: pos + insert.length },
          });
          currentView.focus();
        });
      })
      .catch((error: unknown) => setAttachmentError(error instanceof Error ? error.message : String(error)))
      .finally(() => setIsAttaching(false));
  }, [rootId]);

  return (
    <div className="note-editor">
      <div className="note-editor__chrome">
        {mode === "edit" && (
          <NoteToolbar
            view={view}
            linkableNotes={linkableNotes}
            onAttachImage={attachImageFile}
            isAttaching={isAttaching}
          />
        )}
        {isConflicted && (
          <button type="button" className="note-editor__mark-resolved" onClick={markResolved}>
            Mark resolved
          </button>
        )}
        <button
          type="button"
          className="note-editor__mode-toggle"
          onClick={() => {
            if (mode === "edit") {
              onFirstPreview?.();
            }
            onModeChange(mode === "edit" ? "view" : "edit");
          }}
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
      {attachmentError !== null && (
        <p role="alert" className="note-editor__attachment-error">
          Could not attach image: {attachmentError}
        </p>
      )}
      <div className="note-editor__body" ref={bodyRef} data-drag-over={isDragOver || undefined}>
        {isLoading && (
          <div className="note-editor__loading">
            <Spinner delayed label="Opening note…" />
          </div>
        )}
        <div
          className="note-editor__cm-host"
          data-testid="note-editor"
          ref={hostRef}
          hidden={mode !== "edit"}
        />
        {mode === "view" && (
          <Suspense fallback={<Spinner delayed label="Loading preview…" />}>
            <NoteView
              content={content}
              resolveNoteLink={resolveNoteLink}
              onOpenNoteLink={(targetPath) => onOpenNoteLink?.(rootId, targetPath)}
              resolveAttachment={resolveAttachment}
            />
          </Suspense>
        )}
      </div>
      {backlinkEntries.length > 0 && (
        <BacklinksSection entries={backlinkEntries} onSelect={(targetPath) => onOpenNoteLink?.(rootId, targetPath)} />
      )}
    </div>
  );
}
