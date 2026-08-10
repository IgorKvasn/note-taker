import { useEffect } from "react";
import type { DeletedAttachment } from "../ipc";
import "./AttachmentCleanupDialog.css";

interface AttachmentCleanupDialogProps {
  candidates: DeletedAttachment[];
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function totalSizeMb(candidates: DeletedAttachment[]): string {
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.size_bytes, 0);
  return (totalBytes / (1024 * 1024)).toFixed(1);
}

/**
 * Confirmation for the Settings dialog's manual cleanup trigger (spec §11.6).
 * `candidates` comes from a `dry_run` call to `cleanup_unused_attachments`, so
 * the count and size shown here are exact -- confirming re-issues the same
 * call with `dry_run: false`.
 */
export function AttachmentCleanupDialog({ candidates, isDeleting, onConfirm, onCancel }: AttachmentCleanupDialogProps) {
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
    <div className="attachment-cleanup-backdrop" data-testid="attachment-cleanup-backdrop" onClick={onCancel}>
      <div
        className="attachment-cleanup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-cleanup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="attachment-cleanup-dialog__title" id="attachment-cleanup-title">
          {candidates.length} unused attachment{candidates.length === 1 ? "" : "s"}, {totalSizeMb(candidates)} MB — Delete?
        </h2>
        <p className="attachment-cleanup-dialog__body">This cannot be undone from within the app.</p>
        <div className="attachment-cleanup-dialog__actions">
          <button type="button" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </button>
          <button
            type="button"
            className="attachment-cleanup-dialog__confirm"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
