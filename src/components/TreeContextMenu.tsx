import { useEffect, useRef } from "react";
import "./TreeContextMenu.css";

export interface ContextMenuState {
  x: number;
  y: number;
  rootId: string;
  dirPath: string;
  /** Set only when right-clicking an existing note/folder, not empty space --
   * "Rename" only makes sense with a target selected. */
  renameTarget?: { path: string; isDirectory: boolean };
}

interface TreeContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
}

export function TreeContextMenu({ state, onClose, onCreateNote, onCreateFolder, onRename }: TreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="notes-panel__context-menu"
      role="menu"
      style={{ top: state.y, left: state.x }}
    >
      <button type="button" role="menuitem" onClick={onCreateNote}>
        New note
      </button>
      <button type="button" role="menuitem" onClick={onCreateFolder}>
        New folder
      </button>
      {state.renameTarget !== undefined && (
        <button type="button" role="menuitem" onClick={onRename}>
          Rename
        </button>
      )}
    </div>
  );
}
