import { useEffect, useMemo, useState } from "react";
import type { LinkedNote } from "../ipc";
import "./NoteLinkPicker.css";

interface NoteLinkPickerProps {
  notes: LinkedNote[];
  onSelect: (note: LinkedNote) => void;
  onCancel: () => void;
}

/**
 * Matches on title *and* folder path: titles are only unique per-directory, so
 * the folder is what disambiguates two notes with the same name.
 */
function noteMatchesFilter(note: LinkedNote, query: string): boolean {
  if (query === "") {
    return true;
  }

  const haystack = `${note.title} ${note.directory_path}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => haystack.includes(term));
}

/**
 * Picks a note to link to, inserting `[Title](note:ULID)` at the cursor.
 *
 * Driven from React state rather than a CodeMirror keybinding: every entry in
 * `noteEditorKeymap` dispatches a `TransactionSpec` synchronously, and this
 * must open UI and await a selection first. That is also why it has no
 * keyboard shortcut of its own.
 */
export function NoteLinkPicker({ notes, onSelect, onCancel }: NoteLinkPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => notes.filter((note) => noteMatchesFilter(note, query)), [notes, query]);

  // A shrinking result list must not leave the highlight past its end.
  const boundedIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(filtered.length === 0 ? 0 : (boundedIndex + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(filtered.length === 0 ? 0 : (boundedIndex - 1 + filtered.length) % filtered.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const note = filtered[boundedIndex];
      if (note !== undefined) {
        onSelect(note);
      }
    }
  };

  return (
    <div className="note-link-picker-backdrop" data-testid="note-link-picker-backdrop" onClick={onCancel}>
      <div
        className="note-link-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-link-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="note-link-picker__title" id="note-link-picker-title">
          Link to note
        </h2>
        <input
          className="note-link-picker__input"
          type="text"
          autoFocus
          placeholder="Filter by title or folder"
          aria-label="Filter notes"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        {filtered.length === 0 ? (
          <p className="note-link-picker__empty" data-testid="note-link-picker-empty">
            {notes.length === 0 ? "No notes with an ID yet. Open a note to give it one." : "No matches"}
          </p>
        ) : (
          <ul className="note-link-picker__results" data-testid="note-link-picker-results">
            {filtered.map((note, index) => (
              <li key={note.id}>
                <button
                  type="button"
                  className={
                    index === boundedIndex
                      ? "note-link-picker__item note-link-picker__item--active"
                      : "note-link-picker__item"
                  }
                  aria-current={index === boundedIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(note)}
                >
                  <span className="note-link-picker__item-title">{note.title}</span>
                  <span className="note-link-picker__item-location">{note.directory_path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
