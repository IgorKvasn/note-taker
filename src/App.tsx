import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AboutModal } from "./components/AboutModal";
import { ChangelogModal } from "./components/ChangelogModal";
import { CleanupConfirmDialog } from "./components/CleanupConfirmDialog";
import { LocalOnlyNotice } from "./components/LocalOnlyNotice";
import { NoticeStack } from "./components/NoticeStack";
import { NotesPanel } from "./components/NotesPanel";
import { RootsEditor } from "./components/RootsEditor";
import { Spinner } from "./components/Spinner";
import { SplitPane } from "./components/SplitPane";
import { StatusBar } from "./components/StatusBar";
import { Toast } from "./components/Toast";
import { UpdateNotice } from "./components/UpdateNotice";
import { useAttachmentResolver } from "./hooks/useAttachmentResolver";
import { useToasts } from "./hooks/useToasts";
import { useUiState } from "./hooks/useUiState";
import { isDescendantPath } from "./paths";
import {
  COMMAND_CHECK_FOR_UPDATE,
  COMMAND_CLEANUP_ATTACHMENTS,
  COMMAND_EXECUTE_ATTACHMENT_CLEANUP_ALL_ROOTS,
  COMMAND_GET_APP_VERSION,
  COMMAND_GET_CONFIG,
  COMMAND_PREVIEW_ATTACHMENT_CLEANUP_ALL_ROOTS,
  COMMAND_SHOW_CONFIG_ERROR,
  EVENT_MENU_ABOUT,
  EVENT_MENU_SETTINGS,
  EVENT_SYNC_STATUS,
  type CleanupPreview,
  type Config,
  type ConfigOutcome,
  type ReleaseInfo,
  type SyncStatusEvent,
} from "./ipc";
import "./App.css";

// Code-split: CodeMirror and its markdown grammar are the single largest thing
// the frontend loads, and a launch that restores no note never needs them. The
// import starts as soon as a note is opened; `Spinner` covers the gap, which is
// a local-disk read in a packaged app.
const NoteEditor = lazy(() =>
  import("./components/NoteEditor").then((module) => ({ default: module.NoteEditor })),
);

export function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [configOutcome, setConfigOutcome] = useState<ConfigOutcome | null>(null);
  const [openNote, setOpenNote] = useState<{ rootId: string; path: string; scrollToOffset?: number } | null>(null);
  const {
    state: uiState,
    isLoaded: isUiStateLoaded,
    setSplitRatio,
    setLastOpenNote,
    setExpandedPaths,
    dismissLocalOnlyNotice,
    setEditorMode,
  } = useUiState();
  const hasRestoredOpenNote = useRef(false);
  const { resolveAttachment } = useAttachmentResolver(openNote?.rootId ?? null);
  const [showLocalOnlyNotice, setShowLocalOnlyNotice] = useState(false);
  const [availableUpdates, setAvailableUpdates] = useState<ReleaseInfo[]>([]);
  const [isUpdateNoticeDismissed, setIsUpdateNoticeDismissed] = useState(false);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  // The open note's live (possibly unsaved) buffer content -- an extra
  // reference source for attachment cleanup (issue #79), so a reference that
  // exists only in an unsaved buffer isn't treated as orphaned. Read via a ref
  // (not state) since it's only ever read from event handlers/callbacks, never
  // rendered, and updates on every keystroke.
  const openNoteContentRef = useRef<string | null>(null);
  // Mirrors openNoteContentRef in state so the status bar's word count can
  // re-render live as the user types.
  const [openNoteContent, setOpenNoteContent] = useState<string | null>(null);
  const handleContentChange = useCallback((content: string) => {
    openNoteContentRef.current = content;
    setOpenNoteContent(content);
  }, []);
  // The open note's flushPendingSave, if any -- a manual sync (issue #92)
  // must flush an in-flight autosave debounce before syncing, but that
  // function lives inside NoteEditor, which is only mounted when a note from
  // that root happens to be open. Read via a ref (not state) since it's only
  // ever called from an event handler, never rendered.
  const flushOpenNoteSaveRef = useRef<(() => Promise<void>) | null>(null);
  const handleFlushPendingSaveChange = useCallback((flush: (() => Promise<void>) | null) => {
    flushOpenNoteSaveRef.current = flush;
  }, []);
  // Flushes the open note's pending autosave only if it belongs to `rootId` --
  // a manual sync on a root with no open note (or a different root's note
  // open) has nothing to flush.
  const flushPendingSaveForRoot = useCallback(
    (rootId: string) => {
      if (openNote === null || openNote.rootId !== rootId || flushOpenNoteSaveRef.current === null) {
        return Promise.resolve();
      }
      return flushOpenNoteSaveRef.current();
    },
    [openNote],
  );
  // Attachment cleanup (issue #79) runs once per session on the first switch
  // of any note to preview mode -- this ref (not state) tracks whether that's
  // already happened, since re-triggering on every later preview switch isn't
  // wanted and a ref avoids an extra render on the one time it flips.
  const hasCleanedUpThisSessionRef = useRef(false);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const { toasts, showToast } = useToasts();

  const triggerCleanupOnce = useCallback((rootId: string) => {
    if (hasCleanedUpThisSessionRef.current) {
      return;
    }
    hasCleanedUpThisSessionRef.current = true;
    invoke(COMMAND_CLEANUP_ATTACHMENTS, {
      rootId,
      openNoteContent: openNoteContentRef.current,
    }).catch(() => {});
  }, []);

  const openNoteHandler = useCallback(
    (rootId: string, path: string, scrollToOffset?: number) => {
      setOpenNote({ rootId, path, scrollToOffset });
      setLastOpenNote({ root_id: rootId, path });
    },
    [setLastOpenNote],
  );

  // Keeps the open note open and correctly addressed after it (or an ancestor
  // folder) is renamed or moved elsewhere in the tree.
  const notePathChangedHandler = useCallback(
    (rootId: string, fromPath: string, toPath: string) => {
      if (openNote === null || openNote.rootId !== rootId || !isDescendantPath(openNote.path, fromPath)) return;

      const newPath = toPath + openNote.path.slice(fromPath.length);

      setOpenNote({ ...openNote, path: newPath });
      setLastOpenNote({ root_id: rootId, path: newPath });
    },
    [openNote, setLastOpenNote],
  );

  const loadConfig = useCallback(() => {
    invoke<ConfigOutcome>(COMMAND_GET_CONFIG).then(setConfigOutcome);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (configOutcome?.type !== "invalid") {
      return;
    }
    // Fire-and-forget: the native dialog is a one-time attention-getter, while the
    // in-webview error panel rendered below is the durable "main UI does not load" state.
    invoke(COMMAND_SHOW_CONFIG_ERROR, { error: configOutcome.error }).catch(() => {});
  }, [configOutcome]);

  useEffect(() => {
    invoke<string>(COMMAND_GET_APP_VERSION)
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  // Update check (issue #53): fired once at startup, never blocking initial
  // render. `check_for_update` never rejects (backend fails silently to an
  // empty list), but `.catch` keeps this robust if the IPC call itself fails.
  useEffect(() => {
    invoke<ReleaseInfo[]>(COMMAND_CHECK_FOR_UPDATE)
      .then((releases) => setAvailableUpdates(releases ?? []))
      .catch(() => setAvailableUpdates([]));
  }, []);

  // Restores the last-open note once both the config and persisted UI state have
  // loaded. A note whose root no longer exists in the current config (e.g. the
  // root was removed in Settings) is simply not restored -- no error, no crash.
  useEffect(() => {
    if (hasRestoredOpenNote.current || !isUiStateLoaded || configOutcome?.type !== "ok") {
      return;
    }
    hasRestoredOpenNote.current = true;

    const lastOpenNote = uiState.last_open_note;
    if (lastOpenNote === null) {
      return;
    }

    const rootStillExists = configOutcome.config.roots.some((root) => root.id === lastOpenNote.root_id);
    if (rootStillExists) {
      setOpenNote({ rootId: lastOpenNote.root_id, path: lastOpenNote.path });
    }
  }, [configOutcome, isUiStateLoaded, uiState.last_open_note]);

  useEffect(() => {
    // `listen` only resolves its unlisten fn after registration completes, which
    // can be after a strict-mode unmount -- so cleanup waits on the promise
    // rather than assuming the subscription is already in place.
    const pendingUnlistenAbout = listen(EVENT_MENU_ABOUT, () => setIsAboutOpen(true));
    const pendingUnlistenSettings = listen(EVENT_MENU_SETTINGS, () => setIsSettingsOpen(true));

    return () => {
      pendingUnlistenAbout.then((unlisten) => unlisten()).catch(() => {});
      pendingUnlistenSettings.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // The one-time local-only-sync notice (spec §7): surfaced the first time any
  // root's sync chain reports `local_only` after the first save, and only if
  // it hasn't already been dismissed in a previous session.
  useEffect(() => {
    if (!isUiStateLoaded || uiState.has_dismissed_local_only_notice) {
      return;
    }

    const pendingUnlisten = listen<SyncStatusEvent>(EVENT_SYNC_STATUS, (event) => {
      if (event.payload.state.state === "local_only") {
        setShowLocalOnlyNotice(true);
      }
    });

    return () => {
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [isUiStateLoaded, uiState.has_dismissed_local_only_notice]);

  const dismissNotice = useCallback(() => {
    setShowLocalOnlyNotice(false);
    dismissLocalOnlyNotice();
  }, [dismissLocalOnlyNotice]);

  const dismissUpdateNotice = useCallback(() => setIsUpdateNoticeDismissed(true), []);
  const showChangelog = useCallback(() => setIsChangelogOpen(true), []);
  const closeChangelog = useCallback(() => setIsChangelogOpen(false), []);

  const handleOpenNoteError = useCallback(() => setOpenNote(null), []);
  const handleNoteDeleted = useCallback(() => setOpenNote(null), []);

  const closeAbout = useCallback(() => setIsAboutOpen(false), []);
  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);

  /**
   * Settings dialog's manual cleanup trigger (issue #89): fetches a preview
   * (count + total size) across every configured root before deleting
   * anything -- the confirmation dialog below reports that, and only calls
   * `execute_attachment_cleanup_all_roots` once the user confirms. The open
   * note's live buffer, if any, protects references only within its own
   * root's scan; every other root scans disk-only.
   */
  const startCleanup = useCallback(() => {
    setIsCleaningUp(true);
    invoke<CleanupPreview>(COMMAND_PREVIEW_ATTACHMENT_CLEANUP_ALL_ROOTS, {
      openRootId: openNote?.rootId ?? null,
      openNoteContent: openNoteContentRef.current,
    })
      .then(setCleanupPreview)
      .catch(() => setCleanupPreview({ attachments: [], total_size: 0 }))
      .finally(() => setIsCleaningUp(false));
  }, [openNote]);

  const cancelCleanup = useCallback(() => setCleanupPreview(null), []);

  const confirmCleanup = useCallback(() => {
    setIsCleaningUp(true);
    invoke<CleanupPreview>(COMMAND_EXECUTE_ATTACHMENT_CLEANUP_ALL_ROOTS, {
      openRootId: openNote?.rootId ?? null,
      openNoteContent: openNoteContentRef.current,
    })
      .then((result) => {
        const count = result.attachments.length;
        showToast(count === 0 ? "No unused attachments to clean up." : `Deleted ${count} unused attachment${count === 1 ? "" : "s"}.`);
      })
      .catch(() => showToast("Attachment cleanup failed."))
      .finally(() => {
        setIsCleaningUp(false);
        setCleanupPreview(null);
      });
  }, [openNote, showToast]);

  const handleConfigSaved = useCallback((config: Config) => {
    setConfigOutcome({ type: "ok", config });
    setIsSettingsOpen(false);
  }, []);

  const openNoteRoot =
    openNote !== null ? (configOutcome?.type === "ok" ? configOutcome.config.roots.find((root) => root.id === openNote.rootId) ?? null : null) : null;

  if (configOutcome === null) {
    return (
      <div className="app app--boot">
        <Spinner delayed label="Loading note-taker…" />
      </div>
    );
  }

  if (configOutcome.type === "missing") {
    return (
      <div className="app app--first-run">
        <div className="first-run">
          <h1>Welcome to note-taker</h1>
          <p>Pick at least one folder to store your notes in before continuing.</p>
          <RootsEditor initialRoots={[]} canCancel={false} onSaved={handleConfigSaved} />
        </div>
      </div>
    );
  }

  if (configOutcome.type === "invalid") {
    return (
      <div className="app app--config-error">
        <div className="config-error" role="alert">
          <h1>Configuration error</h1>
          <p>note-taker could not read its configuration file:</p>
          <pre className="config-error__detail">{configOutcome.error}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <SplitPane
        initialLeftRatio={uiState.split_ratio}
        onLeftRatioChange={setSplitRatio}
        left={
          <NotesPanel
            roots={configOutcome.config.roots}
            onOpenNote={openNoteHandler}
            expandedPathsByRoot={uiState.expanded_paths}
            onExpandedPathsChange={setExpandedPaths}
            openNote={openNote}
            onNoteDeleted={handleNoteDeleted}
            onNotePathChanged={notePathChangedHandler}
            onFlushPendingSave={flushPendingSaveForRoot}
          />
        }
        right={
          openNote === null ? (
            <div className="pane pane--placeholder">
              <p>No note open</p>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="pane pane--placeholder">
                  <Spinner delayed label="Opening note…" />
                </div>
              }
            >
              <NoteEditor
                key={`${openNote.rootId}:${openNote.path}`}
                rootId={openNote.rootId}
                path={openNote.path}
                mode={uiState.editor_mode}
                onModeChange={setEditorMode}
                onOpenError={handleOpenNoteError}
                scrollToOffset={openNote.scrollToOffset}
                onOpenNoteLink={openNoteHandler}
                resolveAttachment={resolveAttachment}
                onContentChange={handleContentChange}
                onFirstPreview={() => triggerCleanupOnce(openNote.rootId)}
                onFlushPendingSaveChange={handleFlushPendingSaveChange}
              />
            </Suspense>
          )
        }
      />
      <StatusBar root={openNoteRoot} path={openNote?.path ?? null} content={openNote !== null ? openNoteContent : null} />
      <AboutModal isOpen={isAboutOpen} version={version} onClose={closeAbout} />
      <ChangelogModal isOpen={isChangelogOpen} releases={availableUpdates} onClose={closeChangelog} />
      {isSettingsOpen && (
        <div className="settings-backdrop" data-testid="settings-backdrop">
          <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <h2 id="settings-title">Settings</h2>
            <RootsEditor
              initialRoots={configOutcome.config.roots}
              canCancel
              onSaved={handleConfigSaved}
              onCancel={closeSettings}
            />
            <button
              type="button"
              className="settings-dialog__cleanup"
              onClick={startCleanup}
              disabled={configOutcome.config.roots.length === 0 || isCleaningUp}
            >
              Clean up unused attachments
            </button>
          </div>
        </div>
      )}
      {cleanupPreview !== null && (
        <CleanupConfirmDialog
          fileCount={cleanupPreview.attachments.length}
          totalSize={cleanupPreview.total_size}
          onConfirm={confirmCleanup}
          onCancel={cancelCleanup}
        />
      )}
      <NoticeStack>
        {showLocalOnlyNotice && <LocalOnlyNotice onDismiss={dismissNotice} />}
        {availableUpdates.length > 0 && !isUpdateNoticeDismissed && (
          <UpdateNotice
            version={availableUpdates[0].version}
            onDismiss={dismissUpdateNotice}
            onShowChangelog={showChangelog}
          />
        )}
      </NoticeStack>
      <Toast toasts={toasts} />
    </div>
  );
}
