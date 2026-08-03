//! Cross-note link resolution (`[Title](note:ULID)`).
//!
//! One traversal of a root yields both maps the frontend needs: the notes that
//! carry an ID (so a `note:` href can be resolved to a path) and, for each
//! target ID, the notes linking to it. Both require every file's body, so
//! splitting them into two commands would double the IO for no gain.
//!
//! Links are same-root only by design -- no other root is ever scanned, so a
//! link to a note living elsewhere is simply unresolvable here.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::notes::split_frontmatter;
use crate::search::walk_markdown_files;

/// The `note:` URL scheme carrying a target note's ULID.
const NOTE_SCHEME: &str = "note:";

/// A note that can be linked to, i.e. one that already has a frontmatter ID.
/// Carries the fields the picker filters and displays on, so opening the picker
/// needs no second command.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LinkedNote {
    pub id: String,
    pub path: String,
    pub directory_path: String,
    pub title: String,
}

/// `notes` resolves a `note:` ULID to a path; `backlinks` maps a target ULID to
/// the paths of the notes linking to it. Both are built in this one traversal;
/// the frontend's "Linked from" section (issue #50) reads `backlinks` from the
/// same cached scan `notes` already powers, needing no second command.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScanLinksResult {
    pub notes: Vec<LinkedNote>,
    pub backlinks: BTreeMap<String, Vec<String>>,
}

/// Extracts the ULIDs targeted by every `[label](note:ULID)` link in a body.
///
/// Hand-rolled rather than pulling in a markdown parser: the target shape is
/// narrow, and a full parse would still have to be reconciled with what
/// `remark-gfm` accepts on the frontend. Scanning for the `](note:` pivot means
/// an image (`![alt](note:...)`) is matched too, which is intended -- it is
/// still a reference to that note for backlink purposes.
///
/// Known limitation: with no markdown context, a link written inside a code
/// fence or backticks counts as a real link. That only over-reports backlinks
/// (a note documenting the syntax appears to link to it), never resolution,
/// which reads `notes` instead. Worth revisiting when backlinks get a consumer.
fn extract_link_targets(body: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut rest = body;

    while let Some(pivot) = rest.find("](") {
        let after_paren = &rest[pivot + "](".len()..];
        rest = after_paren;

        let Some(url) = after_paren.split(')').next() else {
            continue;
        };
        // A URL containing whitespace never closes a markdown link cleanly; a
        // markdown title (`](note:X "t")`) would land here too, and trimming it
        // off is what keeps the ULID clean.
        let url = url.split_whitespace().next().unwrap_or("");

        if let Some(id) = url.strip_prefix(NOTE_SCHEME) {
            if !id.is_empty() {
                targets.push(id.to_string());
            }
        }
    }

    targets
}

/// Walks `root_path` once, collecting linkable notes and the backlink map.
///
/// Deliberately read-only: a note whose frontmatter has no `id` is absent from
/// `notes` and is never backfilled here (spec §9.5 -- a read command must not
/// write). Such a note can still *link out*, so it still contributes backlinks.
/// A file that cannot be read is skipped rather than failing the whole scan,
/// matching `search_root`.
pub fn scan_links(root_path: &Path) -> ScanLinksResult {
    let mut files = Vec::new();
    walk_markdown_files(root_path, &mut files);

    let mut notes = Vec::new();
    let mut backlinks: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for absolute_path in files {
        let Ok(relative_path) = absolute_path.strip_prefix(root_path) else {
            continue;
        };
        let relative_path = relative_path.to_string_lossy().replace('\\', "/");

        let Ok(raw) = fs::read_to_string(&absolute_path) else {
            continue;
        };
        let (id, body) = split_frontmatter(&raw);

        for target in extract_link_targets(body) {
            backlinks
                .entry(target)
                .or_default()
                .push(relative_path.clone());
        }

        let Some(id) = id else {
            continue;
        };
        let Some(title) = absolute_path.file_stem() else {
            continue;
        };

        let directory_path = relative_path
            .rsplit_once('/')
            .map_or("", |(dir, _)| dir)
            .to_string();

        notes.push(LinkedNote {
            id,
            path: relative_path,
            directory_path,
            title: title.to_string_lossy().into_owned(),
        });
    }

    // Ordering is not guaranteed by `read_dir`; sorting keeps the picker list
    // and the backlink lists stable between scans of an unchanged root.
    notes.sort_by(|a, b| (&a.title, &a.path).cmp(&(&b.title, &b.path)));
    for paths in backlinks.values_mut() {
        paths.sort();
        paths.dedup();
    }

    ScanLinksResult { notes, backlinks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_note(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn with_id(id: &str, body: &str) -> String {
        format!("---\nid: {id}\n---\n{body}")
    }

    #[test]
    fn maps_each_note_with_an_id_to_its_relative_path() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "alpha.md", &with_id("01AAA", "body"));
        write_note(temp_dir.path(), "folder/beta.md", &with_id("01BBB", "body"));

        let result = scan_links(temp_dir.path());

        let mapped: Vec<(&str, &str)> = result
            .notes
            .iter()
            .map(|note| (note.id.as_str(), note.path.as_str()))
            .collect();
        assert_eq!(
            mapped,
            vec![("01AAA", "alpha.md"), ("01BBB", "folder/beta.md")]
        );
    }

    #[test]
    fn exposes_title_and_directory_path_for_the_picker() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "projects/archive/beta.md",
            &with_id("01BBB", "body"),
        );
        write_note(temp_dir.path(), "alpha.md", &with_id("01AAA", "body"));

        let result = scan_links(temp_dir.path());

        assert_eq!(result.notes[0].title, "alpha");
        assert_eq!(result.notes[0].directory_path, "");
        assert_eq!(result.notes[1].title, "beta");
        assert_eq!(result.notes[1].directory_path, "projects/archive");
    }

    #[test]
    fn builds_a_backlink_map_from_note_links() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "source.md",
            &with_id("01SRC", "see [Target](note:01TGT) for more"),
        );
        write_note(
            temp_dir.path(),
            "other.md",
            &with_id("01OTH", "also [Target](note:01TGT)"),
        );
        write_note(temp_dir.path(), "target.md", &with_id("01TGT", "body"));

        let result = scan_links(temp_dir.path());

        assert_eq!(
            result.backlinks.get("01TGT"),
            Some(&vec!["other.md".to_string(), "source.md".to_string()])
        );
    }

    #[test]
    fn a_note_linked_twice_from_one_source_is_listed_once() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "source.md",
            &with_id("01SRC", "[a](note:01TGT) and again [b](note:01TGT)"),
        );

        let result = scan_links(temp_dir.path());

        assert_eq!(
            result.backlinks.get("01TGT"),
            Some(&vec!["source.md".to_string()])
        );
    }

    #[test]
    fn a_note_without_an_id_is_absent_from_the_map_and_is_not_backfilled() {
        let temp_dir = TempDir::new().unwrap();
        let raw = "no frontmatter here";
        write_note(temp_dir.path(), "plain.md", raw);

        let result = scan_links(temp_dir.path());

        assert!(result.notes.is_empty());
        assert_eq!(
            fs::read_to_string(temp_dir.path().join("plain.md")).unwrap(),
            raw,
            "scanning must not write an id back (spec §9.5)"
        );
    }

    #[test]
    fn a_note_without_an_id_still_contributes_its_outgoing_links() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "plain.md", "links to [T](note:01TGT)");

        let result = scan_links(temp_dir.path());

        assert!(result.notes.is_empty());
        assert_eq!(
            result.backlinks.get("01TGT"),
            Some(&vec!["plain.md".to_string()])
        );
    }

    #[test]
    fn ordinary_links_do_not_become_backlinks() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "source.md",
            &with_id("01SRC", "[site](https://example.com) and [rel](./other.md)"),
        );

        let result = scan_links(temp_dir.path());

        assert!(result.backlinks.is_empty());
    }

    #[test]
    fn a_link_target_in_frontmatter_is_not_scanned() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "source.md",
            "---\nid: 01SRC\nnote: \"[x](note:01TGT)\"\n---\nplain body",
        );

        let result = scan_links(temp_dir.path());

        assert!(result.backlinks.is_empty());
    }

    #[test]
    fn a_link_with_a_markdown_title_still_yields_a_clean_ulid() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "source.md",
            &with_id("01SRC", "[T](note:01TGT \"hover text\")"),
        );

        let result = scan_links(temp_dir.path());

        assert_eq!(
            result.backlinks.get("01TGT"),
            Some(&vec!["source.md".to_string()])
        );
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_notes_are_skipped() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "real.md", &with_id("01REAL", "body"));
        std::os::unix::fs::symlink(
            temp_dir.path().join("real.md"),
            temp_dir.path().join("link.md"),
        )
        .unwrap();

        let result = scan_links(temp_dir.path());

        let paths: Vec<&str> = result.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["real.md"]);
    }

    #[test]
    fn dotfile_directories_are_skipped() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), ".git/hook.md", &with_id("01GIT", "body"));
        write_note(temp_dir.path(), "visible.md", &with_id("01VIS", "body"));

        let result = scan_links(temp_dir.path());

        let paths: Vec<&str> = result.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["visible.md"]);
    }
}
