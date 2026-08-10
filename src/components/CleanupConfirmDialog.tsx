import { useEffect } from "react";
import "./DeleteConfirmDialog.css";

interface CleanupConfirmDialogProps {
  fileCount: number;
  totalSize: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Mirrors `formatFileSize` conventions elsewhere in the app -- there is no
 * shared helper for this yet, so a small one lives here rather than pulling
 * in a dependency for a single confirmation dialog's body text. */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Blocking confirmation for the Settings dialog's manual "clean up unused
 * attachments" action (issue #79), reusing `DeleteConfirmDialog`'s markup and
 * styling (`delete-confirm-*` classes) since both are the same shape of
 * destructive, permanent-deletion confirmation.
 */
export function CleanupConfirmDialog({ fileCount, totalSize, onConfirm, onCancel }: CleanupConfirmDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return (
    <div className="delete-confirm-backdrop" data-testid="cleanup-confirm-backdrop" onClick={onCancel}>
      <div
        className="delete-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="delete-confirm-dialog__title" id="cleanup-confirm-title">
          Clean up unused attachments?
        </h2>
        <p className="delete-confirm-dialog__body">
          {fileCount === 0
            ? "No unused attachments were found."
            : `This will permanently delete ${fileCount} unused attachment${fileCount === 1 ? "" : "s"}, freeing ${formatSize(totalSize)}. This cannot be undone from within the app.`}
        </p>
        <div className="delete-confirm-dialog__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="delete-confirm-dialog__confirm"
            onClick={onConfirm}
            disabled={fileCount === 0}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
