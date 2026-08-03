import { useState } from "react";
import type { BacklinkEntry } from "../hooks/useNoteLinks";
import "./BacklinksSection.css";

interface BacklinksSectionProps {
  entries: BacklinkEntry[];
  onSelect: (path: string) => void;
}

/**
 * Collapsible "Linked from (N)" list at the bottom of a note's pane (issue
 * #50). Absent entirely with no backlinks -- rendered by the caller only when
 * `entries.length > 0`, matching the "no empty state" acceptance criterion.
 */
export function BacklinksSection({ entries, onSelect }: BacklinksSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="backlinks-section">
      <button
        type="button"
        className="backlinks-section__header"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((expanded) => !expanded)}
      >
        <span className="backlinks-section__disclosure" data-expanded={isExpanded || undefined} aria-hidden="true" />
        Linked from ({entries.length})
      </button>
      {isExpanded && (
        <ul className="backlinks-section__list">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button type="button" className="backlinks-section__item" onClick={() => onSelect(entry.path)}>
                <span className="backlinks-section__title">{entry.title}</span>
                {entry.directory_path !== "" && (
                  <span className="backlinks-section__location">{entry.directory_path}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
