import { useEffect, useRef } from "react";
import "./TreeContextMenu.css";

export interface ContextMenuState {
  x: number;
  y: number;
  rootId: string;
  dirPath: string;
  /**
   * The specific note/folder that was right-clicked, if any -- `null` when the
   * click landed on empty space, which only offers the create actions above
   * (no item to rename or delete). Kept separate from `dirPath`, which is
   * always the *directory* a create would target, not the clicked item itself.
   */
  clickedItem: { path: string; isDirectory: boolean } | null;
}

interface TreeContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function TreeContextMenu({
  state,
  onClose,
  onCreateNote,
  onCreateFolder,
  onRename,
  onDelete,
}: TreeContextMenuProps) {
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
      {state.clickedItem !== null && (
        <>
          <button type="button" role="menuitem" onClick={onRename}>
            Rename
          </button>
          <button type="button" role="menuitem" onClick={onDelete}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}
