import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import "./InlineCreateField.css";

export type CreateKind = "note" | "folder";

interface InlineCreateFieldProps {
  kind: CreateKind;
  onConfirm: (title: string) => Promise<void>;
  onCancel: () => void;
  depth: number;
}

export function InlineCreateField({ kind, onConfirm, onCancel, depth }: InlineCreateFieldProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
          aria-label={kind === "note" ? "New note title" : "New folder title"}
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
