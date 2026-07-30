import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { COMMAND_OPEN_NOTE, COMMAND_SAVE_NOTE, type OpenNoteResult } from "../ipc";
import "./NoteEditor.css";

/** Debounce window between the last keystroke and the autosave `save_note` call. */
const AUTOSAVE_DEBOUNCE_MS = 600;

interface NoteEditorProps {
  rootId: string;
  path: string;
  /** Called when `open_note` rejects, e.g. a persisted last-open note whose file was deleted. */
  onOpenError?: () => void;
}

/**
 * A direct CodeMirror 6 wrapper around a ref/`useEffect`, deliberately not
 * `@uiw/react-codemirror`: the formatting toolbar (a later ticket) dispatches
 * CM6 transactions straight against this view, and a wrapper library would be
 * an abstraction to reach through (spec §1, §5).
 */
export function NoteEditor({ rootId, path, onOpenError }: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ rootId: string; path: string; content: string } | null>(null);

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
            const content = update.state.doc.toString();
            pendingSaveRef.current = { rootId, path, content };
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

    invoke<OpenNoteResult>(COMMAND_OPEN_NOTE, { rootId, path })
      .then((result) => {
        if (isCancelled) {
          return;
        }
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: result.content },
        });
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
    };
  }, [rootId, path]);

  return <div className="note-editor" data-testid="note-editor" ref={hostRef} />;
}
