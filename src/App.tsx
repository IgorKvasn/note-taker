import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AboutModal } from "./components/AboutModal";
import { SplitPane } from "./components/SplitPane";
import { COMMAND_GET_APP_VERSION, EVENT_MENU_ABOUT } from "./ipc";
import "./App.css";

export function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  useEffect(() => {
    invoke<string>(COMMAND_GET_APP_VERSION)
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    // `listen` only resolves its unlisten fn after registration completes, which
    // can be after a strict-mode unmount -- so cleanup waits on the promise
    // rather than assuming the subscription is already in place.
    const pendingUnlisten = listen(EVENT_MENU_ABOUT, () => setIsAboutOpen(true));

    return () => {
      pendingUnlisten.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const closeAbout = useCallback(() => setIsAboutOpen(false), []);

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
    </div>
  );
}
