import { useEffect } from "react";
import type { ContentCounts } from "./countContents";
import "./DeleteConfirmDialog.css";

interface DeleteConfirmDialogProps {
  itemName: string;
  isDirectory: boolean;
  /** Recursive note/subfolder counts for a folder; `null` for a note. */
  contents: ContentCounts | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function contentsSummary(contents: ContentCounts): string {
  if (contents.noteCount === 0 && contents.folderCount === 0) {
    return "It is empty.";
  }

  const notePart = `${contents.noteCount} note${contents.noteCount === 1 ? "" : "s"}`;
  const folderPart = `${contents.folderCount} subfolder${contents.folderCount === 1 ? "" : "s"}`;
  return `It contains ${notePart} and ${folderPart}.`;
}

/**
 * Blocking confirmation for permanent deletion (issue #23): there is no
 * app-level trash, so this is the only guard before a note or folder (and its
 * whole subtree) is gone from disk. Recovery afterward is only via git
 * history, not any in-app undo.
 */
export function DeleteConfirmDialog({ itemName, isDirectory, contents, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  const kind = isDirectory ? "folder" : "note";

  return (
    <div className="delete-confirm-backdrop" data-testid="delete-confirm-backdrop" onClick={onCancel}>
      <div
        className="delete-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="delete-confirm-dialog__title" id="delete-confirm-title">
          Delete {kind} "{itemName}"?
        </h2>
        <p className="delete-confirm-dialog__body">
          {isDirectory && contents !== null && `${contentsSummary(contents)} `}
          This cannot be undone from within the app. The only way to recover it afterward is from git history.
        </p>
        <div className="delete-confirm-dialog__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="delete-confirm-dialog__confirm" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
