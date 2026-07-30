import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_SEARCH_NOTES, type SearchResult } from "../ipc";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

/**
 * Drives the search input's panel-swap: below `MIN_QUERY_LENGTH`, `results` is
 * `null` and the tree stays shown; at or above it, a debounced `search_notes`
 * call populates `results` (§8).
 *
 * `seq` guards against the one genuine correctness trap here -- a slow older
 * search resolving after a faster newer one and overwriting fresher results.
 * Each call carries an incrementing sequence number; a response is applied
 * only if its echoed `seq` still matches the latest one this hook sent,
 * dropping anything superseded regardless of resolution order.
 */
export function useSearch() {
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSeqRef = useRef(0);

  const runSearch = useCallback((searchQuery: string) => {
    const seq = ++latestSeqRef.current;
    setIsSearching(true);

    invoke<SearchResult[]>(COMMAND_SEARCH_NOTES, { query: searchQuery, seq })
      .then((response) => {
        if (seq !== latestSeqRef.current) {
          return;
        }
        setResults(response);
        setIsSearching(false);
      })
      .catch(() => {
        if (seq !== latestSeqRef.current) {
          return;
        }
        setResults([]);
        setIsSearching(false);
      });
  }, []);

  const clearDebounce = () => {
    if (debounceTimeoutRef.current !== null) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
  };

  const setQuery = useCallback((nextQuery: string) => {
    setQueryState(nextQuery);
    clearDebounce();

    if (nextQuery.length < MIN_QUERY_LENGTH) {
      // Below the minimum invalidates any in-flight/previous search too, so a
      // stale response can never repopulate results after the tree is restored.
      latestSeqRef.current += 1;
      setIsSearching(false);
      setResults(null);
      return;
    }

    debounceTimeoutRef.current = setTimeout(() => runSearch(nextQuery), SEARCH_DEBOUNCE_MS);
  }, [runSearch]);

  const clear = useCallback(() => setQuery(""), [setQuery]);

  useEffect(() => clearDebounce, []);

  return { query, results, isSearching, setQuery, clear };
}
