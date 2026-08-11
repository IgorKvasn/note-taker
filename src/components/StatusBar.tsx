import type { RootConfig } from "../ipc";
import { rootLabel } from "../paths";
import "./StatusBar.css";

interface StatusBarProps {
  /** The root the open note belongs to, or `null` when no note is open. */
  root: RootConfig | null;
  /** The open note's path relative to its root, or `null` when no note is open. */
  path: string | null;
  /**
   * The open note's autosave state (issue #96). `"clean"` renders nothing --
   * a permanent "Saved" marker is visual noise that trains users to ignore
   * the widget, so this segment only ever surfaces the states worth acting on.
   */
  saveState: "clean" | "pending" | "failed";
}

export function StatusBar({ root, path, saveState }: StatusBarProps) {
  const label = root !== null && path !== null ? `${rootLabel(root)} / ${path}` : "";

  return (
    <div className="status-bar">
      {/* `role="status"` only in the failed state: routine debounce churn
          (the "pending" state, which fires on every keystroke burst) must
          not be announced, but a stuck save should be. */}
      {saveState !== "clean" && (
        <div
          className={`status-bar__save-state${saveState === "failed" ? " status-bar__save-state--failed" : ""}`}
          role={saveState === "failed" ? "status" : undefined}
        >
          {saveState === "pending" ? "Unsaved…" : "Save failed"}
        </div>
      )}
      <div className="status-bar__location" title={label || undefined}>
        {label}
      </div>
    </div>
  );
}
