import type { RootConfig } from "../ipc";
import { rootLabel } from "../paths";
import "./StatusBar.css";

interface StatusBarProps {
  /** The root the open note belongs to, or `null` when no note is open. */
  root: RootConfig | null;
  /** The open note's path relative to its root, or `null` when no note is open. */
  path: string | null;
}

export function StatusBar({ root, path }: StatusBarProps) {
  const label = root !== null && path !== null ? `${rootLabel(root)} / ${path}` : "";

  return (
    <div className="status-bar">
      <div className="status-bar__location" title={label || undefined}>
        {label}
      </div>
    </div>
  );
}
