import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { COMMAND_OPEN_NOTE, COMMAND_SAVE_NOTE, type OpenNoteResult } from "../ipc";
import { NoteToolbar } from "./NoteToolbar";
import { NoteView } from "./NoteView";
import "./NoteEditor.css";

/** Debounce window between the last keystroke and the autosave `save_note` call. */
const AUTOSAVE_DEBOUNCE_MS = 600;

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

type EditorMode = "edit" | "view";

interface NoteEditorProps {
  rootId: string;
  path: string;
  /** Called when `open_note` rejects, e.g. a persisted last-open note whose file was deleted. */
  onOpenError?: () => void;
  /**
   * A character offset to move the cursor to and scroll into view once the
   * note's content has loaded -- used by search result clicks to land on the
   * first match (spec §8). Re-applied whenever the value changes, including
   * repeat clicks on the same result for the same open note.
   */
  scrollToOffset?: number;
}

/**
 * A direct CodeMirror 6 wrapper around a ref/`useEffect`, deliberately not
 * `@uiw/react-codemirror`: the formatting toolbar dispatches CM6 transactions
 * straight against this view, and a wrapper library would be an abstraction
 * to reach through (spec §1, §5).
 */
export function NoteEditor({ rootId, path, onOpenError, scrollToOffset }: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read once the initial `open_note` resolves, inside the mount effect below --
  // a ref rather than a dependency so the mount effect doesn't re-run on every
  // scrollToOffset change (that's the second effect's job).
  const scrollToOffsetRef = useRef(scrollToOffset);
  scrollToOffsetRef.current = scrollToOffset;
  const pendingSaveRef = useRef<{ rootId: string; path: string; content: string } | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [content, setContent] = useState("");

  const flushPendingSave = () => {
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (pending === null) {
      return;
    }
    pendingSaveRef.current = null;
    invoke(COMMAND_SAVE_NOTE, pending).catch(() => {});
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    let isCancelled = false;

    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
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
    setMode("edit");

    invoke<OpenNoteResult>(COMMAND_OPEN_NOTE, { rootId, path })
      .then((result) => {
        if (isCancelled) {
          return;
        }
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: result.content },
        });
        setContent(result.content);
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

  return (
    <div className="note-editor">
      <div className="note-editor__chrome">
        {mode === "edit" && <NoteToolbar view={view} />}
        <button
          type="button"
          className="note-editor__mode-toggle"
          onClick={() => setMode((current) => (current === "edit" ? "view" : "edit"))}
        >
          {mode === "edit" ? "Preview" : "Edit"}
        </button>
      </div>
      <div className="note-editor__body">
        <div
          className="note-editor__cm-host"
          data-testid="note-editor"
          ref={hostRef}
          hidden={mode !== "edit"}
        />
        {mode === "view" && <NoteView content={content} />}
      </div>
    </div>
  );
}
