import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AboutModal } from "./components/AboutModal";
import { RootsEditor } from "./components/RootsEditor";
import { SplitPane } from "./components/SplitPane";
import {
  COMMAND_GET_APP_VERSION,
  COMMAND_GET_CONFIG,
  COMMAND_SHOW_CONFIG_ERROR,
  EVENT_MENU_ABOUT,
  EVENT_MENU_SETTINGS,
  type Config,
  type ConfigOutcome,
} from "./ipc";
import "./App.css";

export function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [configOutcome, setConfigOutcome] = useState<ConfigOutcome | null>(null);

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

  const closeAbout = useCallback(() => setIsAboutOpen(false), []);
  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);

  const handleConfigSaved = useCallback((config: Config) => {
    setConfigOutcome({ type: "ok", config });
    setIsSettingsOpen(false);
  }, []);

  if (configOutcome === null) {
    return null;
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
        left={
          <div className="pane pane--placeholder">
            <p>Notes</p>
          </div>
        }
        right={
          <div className="pane pane--placeholder">
            <p>No note open</p>
          </div>
        }
      />
      <AboutModal isOpen={isAboutOpen} version={version} onClose={closeAbout} />
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
          </div>
        </div>
      )}
    </div>
  );
}
