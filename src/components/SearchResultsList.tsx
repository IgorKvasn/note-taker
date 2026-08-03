import type { ReactNode } from "react";
import type { RootConfig, SearchResult } from "../ipc";
import "./SearchResultsList.css";

interface SearchResultsListProps {
  results: SearchResult[];
  roots: RootConfig[];
  /** Whether a debounced search is currently in flight (issue #60) -- shows a
   * subtle inline indicator above the (possibly stale) results below it. */
  isSearching?: boolean;
  onSelect: (result: SearchResult) => void;
}

function rootLabel(roots: RootConfig[], rootId: string): string {
  const root = roots.find((candidate) => candidate.id === rootId);
  if (root === undefined) {
    return rootId;
  }
  const normalized = root.path.replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : root.path;
}

/** Renders a snippet with `snippet_matches` highlighted, or as plain text
 * when there are none -- the title-only-hit case (spec §8), where the absent
 * highlight is itself the honest signal that the match was in the title. */
function renderSnippet(result: SearchResult): ReactNode {
  if (result.snippet_matches.length === 0) {
    return result.snippet;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;

  result.snippet_matches.forEach((match, index) => {
    if (match.start > cursor) {
      parts.push(result.snippet.slice(cursor, match.start));
    }
    parts.push(<mark key={index}>{result.snippet.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  });

  if (cursor < result.snippet.length) {
    parts.push(result.snippet.slice(cursor));
  }

  return parts;
}

export function SearchResultsList({ results, roots, isSearching = false, onSelect }: SearchResultsListProps) {
  if (results.length === 0) {
    return (
      <>
        {isSearching && (
          <p className="search-results__searching" data-testid="search-results-searching">
            Searching…
          </p>
        )}
        <p className="search-results__empty" data-testid="search-results-empty">
          No matches
        </p>
      </>
    );
  }

  return (
    <>
      {isSearching && (
        <p className="search-results__searching" data-testid="search-results-searching">
          Searching…
        </p>
      )}
      <ul className="search-results" data-testid="search-results">
        {results.map((result) => (
          <li key={`${result.root_id}:${result.path}`}>
            <button type="button" className="search-results__item" onClick={() => onSelect(result)}>
              <span className="search-results__title">{result.title}</span>
              <span className="search-results__snippet">{renderSnippet(result)}</span>
              <span className="search-results__location">
                {rootLabel(roots, result.root_id)}
                {result.directory_path ? ` / ${result.directory_path}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
