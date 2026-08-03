use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::notes::strip_frontmatter;

/// A single match's `[start, end)` offset within `snippet`, counted in UTF-16
/// code units -- the same unit JavaScript string indices use -- so the
/// frontend can slice `snippet` directly to highlight these ranges rather
/// than the backend baking in markup.
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
    /// The first body match's UTF-16 offset within the note's full body (not
    /// the snippet), for the frontend to scroll the editor there and place
    /// the cursor (spec §8) -- CodeMirror's document offsets are also UTF-16
    /// code units, so this needs no further conversion on the frontend.
    /// `None` for a title-only hit -- there is no body position to scroll to.
    pub first_match_offset: Option<usize>,
    pub seq: u64,
}

/// Counts non-overlapping, case-insensitive occurrences of `query` in
/// `haystack` (`"aa"` in `"aaaa"` counts 2, not 3) and returns each match's
/// UTF-16 offset into `haystack`, restarting the search just past the
/// previous match's end.
///
/// `char::to_lowercase()` is not length-preserving (e.g. `İ` (U+0130) lowers
/// to `i` followed by a combining dot above, 1 char growing to 2), so matches
/// found in a lowercased copy of `haystack` cannot be reported as offsets into
/// that copy -- they would drift past the end of the original string and
/// panic on slicing. Instead, every original char's lowercase expansion is
/// appended to `lower_buf` alongside a record of where that char started (in
/// UTF-16 units) in the original.
///
/// A raw byte-level substring search over `lower_buf` can still land on a
/// "match" that starts or ends strictly inside one char's expansion rather
/// than on a boundary between two chars' expansions -- e.g. searching for the
/// literal two-char sequence "combining dot above" + `i` inside `"İİ"`'s
/// lowercased form (`"i" + dot + i + dot`) finds a byte range spanning the
/// second half of the first `İ`'s expansion and the first half of the
/// second's, which does not correspond to any real span of original
/// characters. Such candidates are skipped (not reported, not panicked on) by
/// advancing one byte and retrying, since they are byte-string coincidences,
/// not genuine matches.
fn find_matches(haystack: &str, query_lower: &str) -> Vec<MatchRange> {
    if query_lower.is_empty() {
        return Vec::new();
    }

    let mut lower_buf = String::new();
    // Parallel to `lower_buf`: (byte offset into lower_buf, UTF-16 offset into
    // haystack) for the start of each original char's lowercase expansion,
    // plus a final sentinel pair for the end of both strings.
    let mut boundaries = Vec::new();
    let mut utf16_offset = 0usize;

    for ch in haystack.chars() {
        boundaries.push((lower_buf.len(), utf16_offset));
        lower_buf.extend(ch.to_lowercase());
        utf16_offset += ch.len_utf16();
    }
    boundaries.push((lower_buf.len(), utf16_offset));

    let to_original_offset = |lower_byte_offset: usize| -> Option<usize> {
        boundaries
            .binary_search_by_key(&lower_byte_offset, |&(lower_offset, _)| lower_offset)
            .ok()
            .map(|index| boundaries[index].1)
    };

    let mut matches = Vec::new();
    let mut search_from = 0;

    while search_from <= lower_buf.len() {
        let Some(found_at) = lower_buf[search_from..].find(query_lower) else {
            break;
        };
        let lower_start = search_from + found_at;
        let lower_end = lower_start + query_lower.len();

        match (to_original_offset(lower_start), to_original_offset(lower_end)) {
            (Some(start), Some(end)) => {
                matches.push(MatchRange { start, end });
                search_from = lower_end;
            }
            // Byte-string coincidence straddling an expansion boundary, not a
            // real match against original characters -- retry from the next
            // char boundary in `lower_buf` (not simply `lower_start + 1`,
            // which can itself split a multi-byte char and panic on slicing).
            _ => {
                let mut next = lower_start + 1;
                while next < lower_buf.len() && !lower_buf.is_char_boundary(next) {
                    next += 1;
                }
                search_from = next;
            }
        }
    }

    matches
}

/// The first non-blank line of a note body, shown unhighlighted for a
/// title-only hit.
fn first_content_line(body: &str) -> &str {
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
}

/// The byte offset in `text` corresponding to `utf16_offset` UTF-16 code
/// units in, i.e. the position a JavaScript string index of `utf16_offset`
/// would refer to. Assumes `utf16_offset` lands on a char boundary, which
/// holds for every offset this module produces or consumes.
fn byte_offset_for_utf16(text: &str, utf16_offset: usize) -> usize {
    let mut utf16_count = 0;
    for (byte_offset, ch) in text.char_indices() {
        if utf16_count == utf16_offset {
            return byte_offset;
        }
        utf16_count += ch.len_utf16();
    }
    text.len()
}

/// The line containing `body_offset` (a body-relative UTF-16 offset), along
/// with that offset translated to be relative to the returned line (also in
/// UTF-16 units).
fn line_containing(body: &str, body_offset: usize) -> (&str, usize) {
    let byte_offset = byte_offset_for_utf16(body, body_offset);
    let line_start = body[..byte_offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = body[byte_offset..]
        .find('\n')
        .map_or(body.len(), |index| byte_offset + index);
    let line = &body[line_start..line_end];
    let line_offset = body[line_start..byte_offset].encode_utf16().count();
    (line, line_offset)
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
            let relative_path = absolute_path
                .strip_prefix(root_path)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            let raw = fs::read_to_string(&absolute_path).ok()?;
            let body = strip_frontmatter(&raw);
            let title = absolute_path.file_stem()?.to_string_lossy().into_owned();

            let found = search_note(&title, body, query_lower)?;
            let directory_path = relative_path
                .rsplit_once('/')
                .map_or("", |(dir, _)| dir)
                .to_string();

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

    results.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| a.title.cmp(&b.title))
    });
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
    fn find_matches_handles_lowercase_expansion_that_grows_byte_length() {
        // 'İ' (U+0130, Turkish dotted capital I) is 2 bytes but lowercases to
        // "i" + combining dot above (U+0069 U+0307), which is 3 bytes -- a
        // haystack of 5 of these plus "x" is 11 bytes but lowercases to 16
        // bytes, so a naive byte offset from the lowercased copy would land
        // past the end of the 11-byte original and panic on slicing.
        let matches = find_matches("İİİİİx", "x");
        assert_eq!(matches.len(), 1);
        // UTF-16 offset: each 'İ' is one UTF-16 code unit, so "x" starts at 5.
        assert_eq!(matches[0], MatchRange { start: 5, end: 6 });
    }

    #[test]
    fn find_matches_skips_a_byte_level_match_that_straddles_two_expansions() {
        // 'İ' lowercases to "i" + combining dot above (U+0307). Lowercasing
        // "İİ" therefore gives "i\u{0307}i\u{0307}". The literal query
        // "\u{0307}i" (already lowercase) is a byte-for-byte substring of
        // that, spanning the tail of the first İ's expansion and the head of
        // the second's -- but that span doesn't correspond to any real
        // character range in the original "İİ", so it must not be reported
        // (and must not panic).
        assert!(find_matches("İİ", "\u{0307}i").is_empty());
    }

    #[test]
    fn find_matches_still_finds_a_genuine_match_after_skipping_a_straddling_one() {
        // Same straddling byte sequence as above, but followed by real text
        // that should still be found.
        let matches = find_matches("İİx", "\u{0307}i");
        assert!(matches.is_empty());
        let matches = find_matches("İİx", "x");
        assert_eq!(matches, vec![MatchRange { start: 2, end: 3 }]);
    }

    #[test]
    fn find_matches_reports_utf16_offsets_not_byte_offsets() {
        // "café " is 5 chars but 6 bytes ('é' is 2 bytes in UTF-8), and both
        // are 5 UTF-16 code units ('é' is 1 code unit) -- the match should be
        // reported at the UTF-16/JS-string-index position, not the byte one.
        let matches = find_matches("café préféré est ici", "préféré");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0], MatchRange { start: 5, end: 12 });
    }

    #[test]
    fn search_note_folds_title_and_body_matches_into_one_count() {
        let found = search_note("docker notes", "some docker compose config", "docker").unwrap();
        assert_eq!(found.match_count, 2);
    }

    #[test]
    fn search_note_title_only_hit_returns_first_content_line_unhighlighted() {
        let found = search_note(
            "docker notes",
            "\n  \nfirst real line\nsecond line",
            "docker",
        )
        .unwrap();
        assert_eq!(found.match_count, 1);
        assert_eq!(found.snippet, "first real line");
        assert!(found.snippet_matches.is_empty());
    }

    #[test]
    fn search_note_body_match_snippet_highlights_the_matching_line() {
        let found = search_note(
            "title",
            "first line\nhas docker compose here\nthird",
            "docker compose",
        )
        .unwrap();
        assert_eq!(found.snippet, "has docker compose here");
        assert_eq!(
            found.snippet_matches,
            vec![MatchRange { start: 4, end: 18 }]
        );
    }

    #[test]
    fn search_note_first_match_offset_is_relative_to_the_full_body_not_the_snippet() {
        let found = search_note(
            "title",
            "first line\nhas docker compose here\nthird",
            "docker compose",
        )
        .unwrap();
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
    fn search_note_does_not_panic_on_length_changing_lowercase_mapping() {
        // Regression test for a panic where offsets from a lowercased copy of
        // the body (whose byte length can grow, e.g. 'İ' -> "i" + combining
        // dot above) were applied to the original, shorter string.
        let found = search_note("title", "İİİİİx", "x").unwrap();
        assert_eq!(found.match_count, 1);
        assert_eq!(found.snippet, "İİİİİx");
        assert_eq!(found.snippet_matches, vec![MatchRange { start: 5, end: 6 }]);
    }

    #[test]
    fn search_note_snippet_matches_align_with_utf16_offsets_for_multibyte_prefix() {
        // Regression test: match ranges must be usable as JS (UTF-16) string
        // indices, not raw UTF-8 byte offsets, so a multi-byte character
        // before the match must not shift the reported range.
        let found = search_note(
            "title",
            "first line\nMon café préféré est ici\nthird",
            "préféré",
        )
        .unwrap();
        assert_eq!(found.snippet, "Mon café préféré est ici");
        // "préféré" starts after "Mon café " (9 UTF-16 units: 'é' is 1 unit).
        assert_eq!(
            found.snippet_matches,
            vec![MatchRange { start: 9, end: 16 }]
        );
    }

    #[test]
    fn search_root_excludes_frontmatter_from_matching_and_snippets() {
        let dir = TempDir::new().unwrap();
        write_note(
            dir.path(),
            "note.md",
            "---\nid: 01J8XULIDVALUE\n---\nplain body content\n",
        );

        let results = search_root("root-1", dir.path(), "01j8xulidvalue", 0);
        assert!(
            results.is_empty(),
            "a frontmatter ULID must not be findable"
        );

        let results = search_root("root-1", dir.path(), "plain body", 0);
        assert_eq!(results.len(), 1);
        assert!(!results[0].snippet.contains("01J8X"));
    }

    #[test]
    fn search_root_finds_raw_markdown_syntax() {
        let dir = TempDir::new().unwrap();
        write_note(
            dir.path(),
            "note.md",
            "---\nid: 1\n---\nsee **bold** and [link](http://example.com/path)\n",
        );

        assert_eq!(search_root("root-1", dir.path(), "**bold**", 0).len(), 1);
        assert_eq!(
            search_root("root-1", dir.path(), "example.com/path", 0).len(),
            1
        );
    }

    #[test]
    fn search_root_searches_titles_but_not_directory_names() {
        let dir = TempDir::new().unwrap();
        write_note(
            dir.path(),
            "keyword-folder/note.md",
            "---\nid: 1\n---\nirrelevant\n",
        );
        write_note(dir.path(), "keyword.md", "---\nid: 2\n---\nirrelevant\n");

        let results = search_root("root-1", dir.path(), "keyword", 0);

        assert_eq!(results.len(), 1, "directory names must not be searched");
        assert_eq!(results[0].title, "keyword");
    }

    #[test]
    fn search_root_skips_git_directory_dotfiles_and_symlinks() {
        let dir = TempDir::new().unwrap();
        write_note(
            dir.path(),
            ".git/some-object.md",
            "---\nid: 1\n---\nneedle\n",
        );
        write_note(dir.path(), ".trash/note.md", "---\nid: 2\n---\nneedle\n");
        write_note(dir.path(), "visible.md", "---\nid: 3\n---\nneedle\n");

        #[cfg(unix)]
        {
            write_note(dir.path(), "real-target.md", "---\nid: 4\n---\nneedle\n");
            std::os::unix::fs::symlink(
                dir.path().join("real-target.md"),
                dir.path().join("link.md"),
            )
            .unwrap();
        }

        let results = search_root("root-1", dir.path(), "needle", 0);

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert!(titles.contains(&"visible.md".trim_end_matches(".md")));
        assert_eq!(
            results.len(),
            if cfg!(unix) { 2 } else { 1 },
            "only visible.md and real-target.md should be found"
        );
    }

    #[test]
    fn search_notes_orders_by_match_count_descending_then_title_alphabetical() {
        let dir = TempDir::new().unwrap();
        write_note(
            dir.path(),
            "zebra.md",
            "---\nid: 1\n---\nneedle needle needle\n",
        );
        write_note(dir.path(), "apple.md", "---\nid: 2\n---\nneedle\n");
        write_note(dir.path(), "banana.md", "---\nid: 3\n---\nneedle needle\n");

        let results = search_notes(
            "needle",
            0,
            &[("root-1".to_string(), dir.path().to_path_buf())],
        );

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["zebra", "banana", "apple"]);
    }

    #[test]
    fn search_notes_ties_break_alphabetically_by_title() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "zebra.md", "---\nid: 1\n---\nneedle\n");
        write_note(dir.path(), "apple.md", "---\nid: 2\n---\nneedle\n");

        let results = search_notes(
            "needle",
            0,
            &[("root-1".to_string(), dir.path().to_path_buf())],
        );

        let titles: Vec<&str> = results.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["apple", "zebra"]);
    }

    #[test]
    fn search_notes_echoes_the_seq_it_was_given() {
        let dir = TempDir::new().unwrap();
        write_note(dir.path(), "note.md", "---\nid: 1\n---\nneedle\n");

        let results = search_notes(
            "needle",
            42,
            &[("root-1".to_string(), dir.path().to_path_buf())],
        );

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
