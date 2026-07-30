use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::notes::strip_frontmatter;

/// A single match's `[start, end)` character offset within `snippet` -- the
/// frontend highlights these ranges rather than the backend baking in markup.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

/// One row per note (spec §8), never one row per match.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchResult {
    pub root_id: String,
    /// Path relative to the root, for re-opening the note on click.
    pub path: String,
    /// Slash-separated, relative to the root, directory only (no filename).
    pub directory_path: String,
    pub title: String,
    pub match_count: usize,
    pub snippet: String,
    /// Ranges within `snippet` to highlight. Empty for a title-only hit, whose
    /// snippet is the note's first content line shown unhighlighted -- the
    /// absent highlight is itself the signal that the match was in the title
    /// (spec §8), so the frontend must tell the two cases apart rather than
    /// inferring it from an empty vec meaning "no matches at all".
    pub snippet_matches: Vec<MatchRange>,
    /// The first body match's character offset within the note's full body
    /// (not the snippet), for the frontend to scroll the editor there and
    /// place the cursor (spec §8). `None` for a title-only hit -- there is no
    /// body position to scroll to.
    pub first_match_offset: Option<usize>,
    pub seq: u64,
}

/// Counts non-overlapping, case-insensitive occurrences of `query` in
/// `haystack` (`"aa"` in `"aaaa"` counts 2, not 3) and returns each match's
/// character offset, restarting the search just past the previous match's end.
fn find_matches(haystack: &str, query_lower: &str) -> Vec<MatchRange> {
    if query_lower.is_empty() {
        return Vec::new();
    }

    let haystack_lower = haystack.to_lowercase();
    let mut matches = Vec::new();
    let mut search_from = 0;

    while let Some(found_at) = haystack_lower[search_from..].find(query_lower) {
        let start = search_from + found_at;
        let end = start + query_lower.len();
        matches.push(MatchRange { start, end });
        search_from = end;
    }

    matches
}

/// The first non-blank line of a note body, shown unhighlighted for a
/// title-only hit.
fn first_content_line(body: &str) -> &str {
    body.lines().find(|line| !line.trim().is_empty()).unwrap_or("")
}

/// The line containing `body_offset` (a body-relative character offset),
/// along with that offset translated to be relative to the returned line.
fn line_containing(body: &str, body_offset: usize) -> (&str, usize) {
    let line_start = body[..body_offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = body[body_offset..].find('\n').map_or(body.len(), |index| body_offset + index);
    (&body[line_start..line_end], body_offset - line_start)
}

struct NoteMatch {
    match_count: usize,
    snippet: String,
    snippet_matches: Vec<MatchRange>,
    first_match_offset: Option<usize>,
}

/// Searches one note's title and body, returning `None` if neither matches.
/// Title occurrences fold into the same count as body occurrences (spec §8:
/// "one rule"), but the snippet always describes the body: a body match
/// highlights its first occurrence's line, while a title-only hit falls back
/// to the first content line, unhighlighted.
fn search_note(title: &str, body: &str, query_lower: &str) -> Option<NoteMatch> {
    let title_matches = find_matches(title, query_lower).len();
    let body_matches = find_matches(body, query_lower);
    let match_count = title_matches + body_matches.len();

    if match_count == 0 {
        return None;
    }

    let (snippet, snippet_matches, first_match_offset) = match body_matches.first() {
        Some(first) => {
            let (line, line_offset) = line_containing(body, first.start);
            let line_start_in_body = first.start - line_offset;
            let line_relative_matches: Vec<MatchRange> = body_matches
                .iter()
                .filter(|candidate| {
                    let (candidate_line, _) = line_containing(body, candidate.start);
                    std::ptr::eq(candidate_line.as_ptr(), line.as_ptr())
                })
                .map(|candidate| MatchRange {
                    start: candidate.start - line_start_in_body,
                    end: candidate.end - line_start_in_body,
                })
                .collect();
            (line.to_string(), line_relative_matches, Some(first.start))
        }
        None => (first_content_line(body).to_string(), Vec::new(), None),
    };

    Some(NoteMatch {
        match_count,
        snippet,
        snippet_matches,
        first_match_offset,
    })
}

/// Recursively walks `root_path` for `*.md` files, mirroring `tree.rs`'s skip
/// rules (dotfiles/dot-directories, no symlink follow) since search shares the
/// same traversal contract (spec §8). Unlike `list_tree`, unreadable
/// subdirectories are skipped rather than erroring: one bad directory in one
/// root must not blank out results from every other root.
fn walk_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            walk_markdown_files(&entry.path(), files);
        } else if file_type.is_file() && name.ends_with(".md") {
            files.push(entry.path());
        }
    }
}

/// Searches one root, returning a result for every note whose title or body
/// contains `query` (case-insensitively). A note that can't be read (permission
/// error, vanished mid-walk) is skipped rather than failing the whole search.
fn search_root(root_id: &str, root_path: &Path, query_lower: &str, seq: u64) -> Vec<SearchResult> {
    let mut files = Vec::new();
    walk_markdown_files(root_path, &mut files);

    files
        .into_iter()
        .filter_map(|absolute_path| {
            let relative_path = absolute_path.strip_prefix(root_path).ok()?.to_string_lossy().replace('\\', "/");
            let raw = fs::read_to_string(&absolute_path).ok()?;
            let body = strip_frontmatter(&raw);
            let title = absolute_path.file_stem()?.to_string_lossy().into_owned();

            let found = search_note(&title, body, query_lower)?;
            let directory_path = relative_path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();

            Some(SearchResult {
                root_id: root_id.to_string(),
                path: relative_path,
                directory_path,
                title,
                match_count: found.match_count,
                snippet: found.snippet,
                snippet_matches: found.snippet_matches,
                first_match_offset: found.first_match_offset,
                seq,
            })
        })
        .collect()
}

/// Stateless full-text search across every configured root (spec §8, §9.4).
/// `seq` is not interpreted here -- it is echoed back on every result purely so
/// the frontend can discard a response overtaken by a newer request; the
/// backend needs no cancellation machinery of its own since each call is
/// independent.
pub fn search_notes(query: &str, seq: u64, roots: &[(String, PathBuf)]) -> Vec<SearchResult> {
    let query_lower = query.to_lowercase();

    let mut results: Vec<SearchResult> = roots
        .iter()
        .flat_map(|(root_id, root_path)| search_root(root_id, root_path, &query_lower, seq))
        .collect();

    results.sort_by(|a, b| b.match_count.cmp(&a.match_count).then_with(|| a.title.cmp(&b.title)));
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_note(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn find_matches_counts_non_overlapping_occurrences() {
        assert_eq!(find_matches("aaaa", "aa").len(), 2);
    }

    #[test]
    fn find_matches_is_case_insensitive() {
        let matches = find_matches("Docker Compose", "docker compose");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0], MatchRange { start: 0, end: 14 });
    }

    #[test]
    fn find_matches_treats_query_as_a_whole_substring_not_tokens() {
        // "compose docker" (reversed word order) must not match "docker compose".
        assert_eq!(find_matches("docker compose", "compose docker").len(), 0);
    }

    #[test]
    fn find_matches_returns_empty_for_no_match() {
        assert!(find_matches("hello world", "xyz").is_empty());
    }

    #[test]
    fn search_note_folds_title_and_body_matches_into_one_count() {
        let found = search_note("docker notes", "some docker compose config", "docker").unwrap();
        assert_eq!(found.match_count, 2);
    }

    #[test]
    fn search_note_title_only_hit_returns_first_content_line_unhighlighted() {
        let found = search_note("docker notes", "\n  \nfirst real line\nsecond line", "docker").unwrap();
        assert_eq!(found.match_count, 1);
        assert_eq!(found.snippet, "first real line");
        assert!(found.snippet_matches.is_empty());
    }

    #[test]
    fn search_note_body_match_snippet_highlights_the_matching_line() {
        let found = search_note("title", "first line\nhas docker compose here\nthird", "docker compose").unwrap();
        assert_eq!(found.snippet, "has docker compose here");
        assert_eq!(found.snippet_matches, vec![MatchRange { start: 4, end: 18 }]);
    }

    #[test]
    fn search_note_first_match_offset_is_relative_to_the_full_body_not_the_snippet() {
        let found = search_note("title", "first line\nhas docker compose here\nthird", "docker compose").unwrap();
        // "docker compose" starts at index 4 of the second line, and the second
        // line starts at body index 11 ("first line\n" is 11 chars).
        assert_eq!(found.first_match_offset, Some(15));
    }

    #[test]
    fn search_note_title_only_hit_has_no_first_match_offset() {
        let found = search_note("docker notes", "first real line\nsecond line", "docker").unwrap();
        assert_eq!(found.first_match_offset, None);
    }

    #[test]
    fn search_note_returns_none_when_neither_title_nor_body_match() {
        assert!(search_note("title", "body text", "xyz").is_none());
    }

    #[test]
    fn search_root_excludes_frontmatter_from_matching_and_snippets() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "note.md", "---\nid: 01J8XULIDVALUE\n---\nplain body content\n");

        let results = search_root("root-1", dir.path(), "01j8xulidvalue", 0);
        assert!(results.is_empty(), "a frontmatter ULID must not be findable");

        let results = search_root("root-1", dir.path(), "plain body", 0);
        assert_eq!(results.len(), 1);
        assert!(!results[0].snippet.contains("01J8X"));
    }

    #[test]
    fn search_root_finds_raw_markdown_syntax() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "note.md", "---\nid: 1\n---\nsee **bold** and [link](http://example.com/path)\n");

        assert_eq!(search_root("root-1", dir.path(), "**bold**", 0).len(), 1);
        assert_eq!(search_root("root-1", dir.path(), "example.com/path", 0).len(), 1);
    }

    #[test]
    fn search_root_searches_titles_but_not_directory_names() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "keyword-folder/note.md", "---\nid: 1\n---\nirrelevant\n");
        write_note(dir.path(), "keyword.md", "---\nid: 2\n---\nirrelevant\n");

        let results = search_root("root-1", dir.path(), "keyword", 0);

        assert_eq!(results.len(), 1, "directory names must not be searched");
        assert_eq!(results[0].title, "keyword");
    }

    #[test]
    fn search_root_skips_git_directory_dotfiles_and_symlinks() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), ".git/some-object.md", "---\nid: 1\n---\nneedle\n");
        write_note(dir.path(), ".trash/note.md", "---\nid: 2\n---\nneedle\n");
        write_note(dir.path(), "visible.md", "---\nid: 3\n---\nneedle\n");

        #[cfg(unix)]
        {
            write_note(dir.path(), "real-target.md", "---\nid: 4\n---\nneedle\n");
            std::os::unix::fs::symlink(dir.path().join("real-target.md"), dir.path().join("link.md")).unwrap();
        }

        let results = search_root("root-1", dir.path(), "needle", 0);

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert!(titles.contains(&"visible.md".trim_end_matches(".md")));
        assert_eq!(results.len(), if cfg!(unix) { 2 } else { 1 }, "only visible.md and real-target.md should be found");
    }

    #[test]
    fn search_notes_orders_by_match_count_descending_then_title_alphabetical() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "zebra.md", "---\nid: 1\n---\nneedle needle needle\n");
        write_note(dir.path(), "apple.md", "---\nid: 2\n---\nneedle\n");
        write_note(dir.path(), "banana.md", "---\nid: 3\n---\nneedle needle\n");

        let results = search_notes("needle", 0, &[("root-1".to_string(), dir.path().to_path_buf())]);

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["zebra", "banana", "apple"]);
    }

    #[test]
    fn search_notes_ties_break_alphabetically_by_title() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "zebra.md", "---\nid: 1\n---\nneedle\n");
        write_note(dir.path(), "apple.md", "---\nid: 2\n---\nneedle\n");

        let results = search_notes("needle", 0, &[("root-1".to_string(), dir.path().to_path_buf())]);

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["apple", "zebra"]);
    }

    #[test]
    fn search_notes_echoes_the_seq_it_was_given() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "note.md", "---\nid: 1\n---\nneedle\n");

        let results = search_notes("needle", 42, &[("root-1".to_string(), dir.path().to_path_buf())]);

        assert_eq!(results[0].seq, 42);
    }

    #[test]
    fn search_notes_skips_a_missing_root_silently() {
        let missing = PathBuf::from("/this/path/does/not/exist/hopefully");
        let results = search_notes("needle", 0, &[("root-1".to_string(), missing)]);
        assert!(results.is_empty());
    }

    #[test]
    fn search_notes_spans_multiple_roots() {
        let dir_a = TempDir::new().unwrap();
        let dir_b = TempDir::new().unwrap();
        write_note(dir_a.path(), "note-a.md", "---\nid: 1\n---\nneedle\n");
        write_note(dir_b.path(), "note-b.md", "---\nid: 2\n---\nneedle\n");

        let results = search_notes(
            "needle",
            0,
            &[
                ("root-a".to_string(), dir_a.path().to_path_buf()),
                ("root-b".to_string(), dir_b.path().to_path_buf()),
            ],
        );

        assert_eq!(results.len(), 2);
    }

    #[test]
    fn search_notes_below_query_length_is_not_this_functions_concern() {
        // The 2-character minimum is enforced by the frontend before it ever calls
        // search_notes (spec §8); the backend still answers a 1-character query --
        // it just isn't invoked with one in practice.
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "note.md", "---\nid: 1\n---\na\n");

        let results = search_notes("a", 0, &[("root-1".to_string(), dir.path().to_path_buf())]);
        assert_eq!(results.len(), 1);
    }
}
