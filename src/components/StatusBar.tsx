import type { RootConfig } from "../ipc";
import { rootLabel } from "../paths";
import "./StatusBar.css";

// Naive whitespace-split count over the raw markdown, not the rendered text --
// markdown syntax counts as words (e.g. `## Heading` counts the `##`, and
// table rows count their pipes). Stripping markdown properly would mean
// running the content through the markdown pipeline for a number nobody
// reads to that precision.
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** The open note's autosave state (issue #96). `"clean"` renders nothing --
 * a permanent "Saved" marker is visual noise that trains users to ignore
 * the widget, so this segment only ever surfaces the states worth acting on. */
export type SaveState = "clean" | "pending" | "failed";

interface StatusBarProps {
  /** The root the open note belongs to, or `null` when no note is open. */
  root: RootConfig | null;
  /** The open note's path relative to its root, or `null` when no note is open. */
  path: string | null;
  /** The open note's live content, or `null` when no note is open. */
  content: string | null;
  saveState: SaveState;
}

export function StatusBar({ root, path, content, saveState }: StatusBarProps) {
  const label = root !== null && path !== null ? `${rootLabel(root)} / ${path}` : "";
  const wordCount = content !== null ? `${countWords(content)} words` : "";

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
      <div className="status-bar__wordcount">{wordCount}</div>
    </div>
  );
}
