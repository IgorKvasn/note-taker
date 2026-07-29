use std::fs;
use std::path::Path;

use serde::Serialize;
use ulid::Ulid;

/// Everything the frontend needs to render an opened note in one call --
/// deliberately not split into a content read and a separate conflict check,
/// which would let the frontend hold content without having checked it
/// (spec §9.4).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OpenNoteResult {
    pub content: String,
    pub id: String,
    pub is_conflicted: bool,
}

/// Reads a note for display, backfilling its ID if absent (see [`read_note`]),
/// and derives conflict state: `false` immediately unless `root_path` has a
/// `MERGE_HEAD` (an in-progress merge), in which case the file is scanned for
/// leftover `<<<<<<<`/`=======`/`>>>>>>>` markers (spec §7).
pub fn open_note(root_path: &Path, path: &Path) -> Result<OpenNoteResult, String> {
    let note = read_note(path)?;
    let is_conflicted = root_path.join(".git").join("MERGE_HEAD").exists() && has_conflict_markers(&note.body);

    Ok(OpenNoteResult {
        content: note.body,
        id: note.id,
        is_conflicted,
    })
}

fn has_conflict_markers(body: &str) -> bool {
    body.lines().any(|line| {
        line.starts_with("<<<<<<< ") || line == "=======" || line.starts_with(">>>>>>> ")
    })
}

/// Writes edited content back to disk, returning as soon as the write completes --
/// it does not wait on git (spec §7). The existing frontmatter ID is preserved by
/// re-reading it from disk rather than trusting a value the frontend might hold
/// stale, since the ID never round-trips back from `open_note`'s caller.
pub fn save_note(path: &Path, content: &str) -> Result<(), String> {
    let existing = read_note(path)?;
    write_note(path, &existing.id, content)
}

/// A note's content with frontmatter already stripped, plus the ID that
/// frontmatter carried (or was just backfilled).
pub struct ReadNote {
    pub body: String,
    pub id: String,
}

/// Reads a note from disk, extracting its frontmatter ID. If the file has no
/// `id` in its frontmatter, one is generated and written back immediately --
/// this is the one and only backfill point (spec §9.5: never during the tree
/// walk, only on open).
pub fn read_note(path: &Path) -> Result<ReadNote, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let (existing_id, body) = split_frontmatter(&raw);

    match existing_id {
        Some(id) => Ok(ReadNote { body: body.to_string(), id }),
        None => {
            let id = Ulid::generate().to_string();
            write_note(path, &id, body)?;
            Ok(ReadNote { body: body.to_string(), id })
        }
    }
}

/// Writes `body` back to `path`, prepending the frontmatter block carrying `id`.
pub fn write_note(path: &Path, id: &str, body: &str) -> Result<(), String> {
    let raw = format!("---\nid: {id}\n---\n{body}");
    fs::write(path, raw).map_err(|error| error.to_string())
}

/// Splits a raw file's leading `---`-delimited YAML frontmatter block from its
/// body, returning the `id` field if the block exists and parses. Absence of a
/// well-formed block (no delimiters, or no `id` key) is not an error -- it just
/// means the caller backfills.
fn split_frontmatter(raw: &str) -> (Option<String>, &str) {
    let Some(after_open) = raw.strip_prefix("---\n") else {
        return (None, raw);
    };

    let Some(close_index) = after_open.find("\n---\n") else {
        return (None, raw);
    };

    let yaml_block = &after_open[..close_index];
    let body = &after_open[close_index + "\n---\n".len()..];

    (extract_id_field(yaml_block), body)
}

fn extract_id_field(yaml_block: &str) -> Option<String> {
    let documents = yaml_rust2::YamlLoader::load_from_str(yaml_block).ok()?;
    let document = documents.first()?;
    document["id"].as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(dir: &TempDir, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn reads_the_id_and_strips_frontmatter_from_an_already_tagged_note() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8XEXISTING\n---\n# Hello\n\nBody text.\n");

        let note = read_note(&path).unwrap();

        assert_eq!(note.id, "01J8XEXISTING");
        assert_eq!(note.body, "# Hello\n\nBody text.\n");
    }

    #[test]
    fn backfills_a_fresh_ulid_and_writes_it_to_disk_when_frontmatter_is_absent() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "# Hello\n\nBody text.\n");

        let note = read_note(&path).unwrap();

        assert!(!note.id.is_empty());
        assert_eq!(note.body, "# Hello\n\nBody text.\n");

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, format!("---\nid: {}\n---\n# Hello\n\nBody text.\n", note.id));
    }

    #[test]
    fn leaves_an_existing_id_byte_identical_on_disk() {
        let dir = TempDir::new().unwrap();
        let original = "---\nid: 01J8XEXISTING\n---\n# Hello\n\nBody text.\n";
        let path = write_file(&dir, "note.md", original);

        read_note(&path).unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, original, "reading a note that already has an id must not rewrite the file");
    }

    #[test]
    fn write_note_reconstructs_the_frontmatter_block_around_the_body() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");

        write_note(&path, "01J8XNEW", "# Title\n\nUpdated body.\n").unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "---\nid: 01J8XNEW\n---\n# Title\n\nUpdated body.\n");
    }

    #[test]
    fn open_note_is_never_conflicted_when_the_root_has_no_merge_head() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8X\n---\nplain content\n");

        let result = open_note(dir.path(), &path).unwrap();

        assert_eq!(result.content, "plain content\n");
        assert_eq!(result.id, "01J8X");
        assert!(!result.is_conflicted);
    }

    #[test]
    fn open_note_is_conflicted_when_merge_head_exists_and_markers_remain() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/MERGE_HEAD"), "deadbeef\n").unwrap();
        let path = write_file(
            &dir,
            "note.md",
            "---\nid: 01J8X\n---\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
        );

        let result = open_note(dir.path(), &path).unwrap();

        assert!(result.is_conflicted);
    }

    #[test]
    fn open_note_is_not_conflicted_when_merge_head_exists_but_markers_are_gone() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/MERGE_HEAD"), "deadbeef\n").unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8X\n---\nresolved content\n");

        let result = open_note(dir.path(), &path).unwrap();

        assert!(!result.is_conflicted);
    }

    #[test]
    fn save_note_writes_content_and_preserves_the_existing_id() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8XKEEP\n---\noriginal\n");

        save_note(&path, "edited content\n").unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "---\nid: 01J8XKEEP\n---\nedited content\n");
    }

    #[test]
    fn save_note_returns_without_any_git_operation() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8X\n---\noriginal\n");

        // No .git directory exists at all -- if save_note touched git in any way
        // this would fail, proving the write is git-independent (spec §7).
        save_note(&path, "no git here\n").unwrap();

        assert!(!dir.path().join(".git").exists());
    }
}
