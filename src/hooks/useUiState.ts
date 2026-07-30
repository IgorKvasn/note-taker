import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_GET_STATE, COMMAND_SAVE_STATE, type LastOpenNote, type UiState } from "../ipc";
import { DEFAULT_PANE_RATIO } from "../components/splitRatio";

const DEFAULT_UI_STATE: UiState = {
  split_ratio: DEFAULT_PANE_RATIO,
  last_open_note: null,
  expanded_paths: {},
};

/** Debounce window between an expanded-paths/ratio change and the autosave `save_state` call. */
const AUTOSAVE_DEBOUNCE_MS = 300;

/**
 * Centralizes load/save of `state.toml`: pane split ratio, last-open note, and
 * expanded folders per root. Loads once on mount and autosaves on every change
 * thereafter -- there is no Save button for this data (spec issue #18).
 */
export function useUiState() {
  const [state, setState] = useState<UiState>(DEFAULT_UI_STATE);
  const [isLoaded, setIsLoaded] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    invoke<UiState>(COMMAND_GET_STATE)
      // `get_state` always resolves with a full UiState on the real backend, but a
      // mock or a future backend contract change is one call away from resolving
      // `undefined` -- so this falls back rather than propagating that into
      // `uiState.last_open_note` reads elsewhere.
      .then((loaded) => setState(loaded ?? DEFAULT_UI_STATE))
      .catch(() => {})
      .finally(() => setIsLoaded(true));
  }, []);

  const scheduleSave = useCallback((next: UiState) => {
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      // Fire-and-forget, same as save_note in NoteEditor: state.toml is a
      // convenience file, not something a failed write should surface an error for.
      invoke(COMMAND_SAVE_STATE, { state: next }).catch(() => {});
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  const setSplitRatio = useCallback(
    (splitRatio: number) => {
      setState((current) => {
        const next = { ...current, split_ratio: splitRatio };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const setLastOpenNote = useCallback(
    (lastOpenNote: LastOpenNote | null) => {
      setState((current) => {
        const next = { ...current, last_open_note: lastOpenNote };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const setExpandedPaths = useCallback(
    (rootId: string, expandedPaths: string[]) => {
      setState((current) => {
        const next = { ...current, expanded_paths: { ...current.expanded_paths, [rootId]: expandedPaths } };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  return { state, isLoaded, setSplitRatio, setLastOpenNote, setExpandedPaths };
}
