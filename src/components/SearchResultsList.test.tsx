import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchResultsList } from "./SearchResultsList";
import type { RootConfig, SearchResult } from "../ipc";

const ROOT_A: RootConfig = { id: "01ROOT-A", path: "/home/user/notes", auto_sync: false, remote_url: "", sync_debounce_secs: 5 };

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    root_id: ROOT_A.id,
    path: "folder/note.md",
    directory_path: "folder",
    title: "note",
    match_count: 1,
    snippet: "a match here",
    snippet_matches: [{ start: 2, end: 7 }],
    first_match_offset: 2,
    seq: 0,
    ...overrides,
  };
}

describe("SearchResultsList", () => {
  it("shows a no-matches empty state when there are no results", () => {
    render(<SearchResultsList results={[]} roots={[ROOT_A]} onSelect={() => {}} />);

    expect(screen.getByTestId("search-results-empty").textContent).toMatch(/no matches/i);
  });

  it("renders one row per result with title, snippet, and root/directory as secondary text", () => {
    render(<SearchResultsList results={[result()]} roots={[ROOT_A]} onSelect={() => {}} />);

    expect(screen.getByText("note")).toBeDefined();
    expect(screen.getByText(/notes.*folder/)).toBeDefined();
  });

  it("highlights snippet_matches within the snippet", () => {
    render(<SearchResultsList results={[result()]} roots={[ROOT_A]} onSelect={() => {}} />);

    const mark = document.querySelector("mark");
    expect(mark?.textContent).toBe("match");
  });

  it("renders a title-only hit's snippet with no highlight", () => {
    render(
      <SearchResultsList
        results={[result({ snippet: "first content line", snippet_matches: [] })]}
        roots={[ROOT_A]}
        onSelect={() => {}}
      />,
    );

    expect(document.querySelector("mark")).toBeNull();
    expect(screen.getByText("first content line")).toBeDefined();
  });

  it("calls onSelect with the clicked result", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const theResult = result();

    render(<SearchResultsList results={[theResult]} roots={[ROOT_A]} onSelect={onSelect} />);
    await user.click(screen.getByText("note"));

    expect(onSelect).toHaveBeenCalledWith(theResult);
  });

  it("shows a searching indicator alongside stale results while a newer search is in flight", () => {
    render(<SearchResultsList results={[result()]} roots={[ROOT_A]} isSearching onSelect={() => {}} />);

    expect(screen.getByTestId("search-results-searching")).toBeDefined();
    expect(screen.getByTestId("search-results")).toBeDefined();
  });

  it("shows no searching indicator once the search has settled", () => {
    render(<SearchResultsList results={[result()]} roots={[ROOT_A]} isSearching={false} onSelect={() => {}} />);

    expect(screen.queryByTestId("search-results-searching")).toBeNull();
  });
});
