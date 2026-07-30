import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import "./InlineCreateField.css";

export type CreateKind = "note" | "folder";

function renameOrCreateLabel(kind: CreateKind, isRename: boolean): string {
  if (isRename) return kind === "note" ? "Rename note" : "Rename folder";
  return kind === "note" ? "New note title" : "New folder title";
}

interface InlineCreateFieldProps {
  kind: CreateKind;
  onConfirm: (title: string) => Promise<void>;
  onCancel: () => void;
  depth: number;
  /** Pre-fills the field with the current title and relabels it for renaming,
   * rather than starting empty as a fresh create does. */
  initialValue?: string;
}

export function InlineCreateField({ kind, onConfirm, onCancel, depth, initialValue }: InlineCreateFieldProps) {
  const isRename = initialValue !== undefined;
  const [value, setValue] = useState(initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (isSubmitting) return;

      setIsSubmitting(true);
      try {
        await onConfirm(value);
        // On success the caller replaces this field with the real tree node;
        // on failure it stays mounted, so only clear the error path here.
        setError(null);
      } catch (submitError) {
        setError(String(submitError));
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <li>
      <div className="notes-panel__inline-create" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
        <input
          ref={inputRef}
          type="text"
          className="notes-panel__inline-input"
          aria-label={renameOrCreateLabel(kind, isRename)}
          value={value}
          disabled={isSubmitting}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {error !== null && (
        <p className="notes-panel__inline-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
