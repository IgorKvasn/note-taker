use std::fs;
use std::path::Path;

use serde::Serialize;
use ulid::Ulid;
use unicode_normalization::UnicodeNormalization;

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

/// Whether `body` still contains any leftover `<<<<<<<`/`=======`/`>>>>>>>`
/// conflict marker line. Shared by `open_note` (deriving `is_conflicted`) and
/// `sync::mark_resolved` (blocking resolution while markers remain).
pub(crate) fn has_conflict_markers(body: &str) -> bool {
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

/// Characters the filesystem/git tooling can't safely round-trip as part of a
/// title: path separators (on either Unix or Windows, since notes may sync
/// across machines), the Windows drive-letter separator, and any ASCII control
/// character including DEL.
const INVALID_TITLE_CHARS: [char; 3] = ['/', '\\', ':'];

fn is_invalid_title_char(c: char) -> bool {
    INVALID_TITLE_CHARS.contains(&c) || c.is_control()
}

/// Validates and NFC-normalizes a title before it is used as a filename,
/// checking for invalid characters and duplicates against `existing_siblings`
/// (the names already present in the same directory the title would be
/// created in -- title uniqueness is per-directory, matching filesystem
/// semantics, not per-root).
///
/// Rejects rather than silently sanitizing invalid characters. Normalizes to
/// NFC before comparing so an NFD-composed incoming title is still caught as a
/// duplicate of an NFC name already on disk (existing siblings are normalized
/// too, since files written by other tools/machines may be NFD).
pub fn validate_title(existing_siblings: &[String], title: &str) -> Result<String, String> {
    if let Some(bad_char) = title.chars().find(|c| is_invalid_title_char(*c)) {
        return Err(format!("title contains an invalid character: {bad_char:?}"));
    }

    let normalized = title.nfc().collect::<String>();

    let is_duplicate = existing_siblings
        .iter()
        .any(|sibling| sibling.nfc().collect::<String>() == normalized);

    if is_duplicate {
        return Err(format!("\"{normalized}\" already exists in this folder"));
    }

    Ok(normalized)
}

/// Lists the filenames already present in `dir`, for duplicate-title checks.
/// Returns an empty list for a directory that doesn't exist yet, since a new
/// directory has no siblings to collide with.
pub(crate) fn sibling_names(dir: &Path) -> Result<Vec<String>, String> {
    match fs::read_dir(dir) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// Creates a new note at `path` with fresh frontmatter carrying a new ULID and
/// an empty body. The title (the filename) is validated against its siblings
/// in the same directory before anything is written -- a rejected title
/// writes nothing.
pub fn create_note(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "note path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "note path has no filename".to_string())?
        .to_string_lossy()
        .into_owned();

    let siblings = sibling_names(parent)?;
    let normalized_name = validate_title(&siblings, &file_name)?;

    write_note(&parent.join(normalized_name), &Ulid::generate().to_string(), "")
}

/// Creates a new, empty directory at `path`. A bare `mkdir` -- intermediate
/// directories are not created, since the target is always a direct child of
/// an existing tree node -- and never touches git (spec §4/§9.4: an empty
/// directory produces no commit, an accepted gap).
pub fn create_folder(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "folder path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "folder path has no filename".to_string())?
        .to_string_lossy()
        .into_owned();

    let siblings = sibling_names(parent)?;
    let normalized_name = validate_title(&siblings, &file_name)?;

    fs::create_dir(parent.join(normalized_name)).map_err(|error| error.to_string())
}

/// Permanently deletes the note or folder at `path` -- a note via
/// `remove_file`, a folder and its whole subtree via `remove_dir_all`. There is
/// no app-level trash (issue #23): the only recovery path is git history, via
/// the sync chain's `git add -A` picking up the removal on the next sync.
pub fn delete_item(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;

    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

/// Moves or renames a note or directory from `from_path` to `to_path`, both
/// absolute, via `git mv` -- covering rename (same parent) and move (different
/// parent) with one operation, since `git mv` treats files and directories
/// identically and a rename is just a move whose parent doesn't change.
///
/// Rejects a move of a directory into its own descendant before ever touching
/// git -- `git mv` itself doesn't reliably guard against this, and it must
/// hold regardless of what the frontend's drag-and-drop already checked.
/// Validates the destination name against its new siblings exactly like
/// `create_note`/`create_folder` (duplicate/invalid-character checks), so a
/// rejected move writes nothing.
pub fn move_item(repo_path: &Path, from_path: &Path, to_path: &Path) -> Result<(), String> {
    if to_path == from_path || to_path.starts_with(from_path) {
        return Err("cannot move a folder into itself or one of its own subfolders".to_string());
    }

    let parent = to_path.parent().ok_or_else(|| "destination path has no parent directory".to_string())?;
    let file_name = to_path
        .file_name()
        .ok_or_else(|| "destination path has no filename".to_string())?
        .to_string_lossy()
        .into_owned();

    let siblings = sibling_names(parent)?;
    let normalized_name = validate_title(&siblings, &file_name)?;
    let destination = parent.join(normalized_name);

    let from_relative = from_path.strip_prefix(repo_path).map_err(|error| error.to_string())?;
    let to_relative = destination.strip_prefix(repo_path).map_err(|error| error.to_string())?;

    crate::gitutil::run_git_expecting_success(
        repo_path,
        &["mv", &from_relative.to_string_lossy(), &to_relative.to_string_lossy()],
    )
}

/// Strips a raw file's leading `---`-delimited YAML frontmatter block, keeping
/// only the `id` extraction private to this module -- search (§8) needs the
/// body without frontmatter but has no business reading the ID.
pub fn strip_frontmatter(raw: &str) -> &str {
    split_frontmatter(raw).1
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
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, contents).unwrap();
        path
    }

    fn write_dir(dir: &TempDir, name: &str) -> std::path::PathBuf {
        let path = dir.path().join(name);
        fs::create_dir_all(&path).unwrap();
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

    #[test]
    fn validate_title_rejects_each_invalid_character() {
        for bad_char in ['/', '\\', ':', '\u{0007}'] {
            let title = format!("note{bad_char}title");
            let result = validate_title(&[], &title);
            assert!(result.is_err(), "expected {bad_char:?} to be rejected");
        }
    }

    #[test]
    fn validate_title_does_not_sanitize_it_just_rejects() {
        let result = validate_title(&[], "bad/name.md");
        assert_eq!(
            result.unwrap_err(),
            "title contains an invalid character: '/'"
        );
    }

    #[test]
    fn validate_title_rejects_a_duplicate_in_the_same_directory() {
        let siblings = vec!["existing.md".to_string()];
        assert!(validate_title(&siblings, "existing.md").is_err());
    }

    #[test]
    fn validate_title_allows_the_same_title_among_different_siblings() {
        let siblings = vec!["other.md".to_string()];
        assert!(validate_title(&siblings, "existing.md").is_ok());
    }

    #[test]
    fn validate_title_normalizes_to_nfc() {
        // "e" + combining acute accent (NFD) -- should normalize to the
        // single precomposed "é" (NFC) codepoint.
        let nfd_title = "cafe\u{0301}.md";
        let normalized = validate_title(&[], nfd_title).unwrap();

        assert_eq!(normalized, "café.md");
        assert_eq!(normalized.chars().count(), 7, "café.md as NFC is 7 codepoints, one per visible character");
    }

    #[test]
    fn validate_title_catches_an_nfd_title_matching_an_existing_nfc_name() {
        // Existing sibling on disk is NFC-composed ("é" as one codepoint);
        // the incoming title spells the same name in NFD (decomposed).
        let siblings = vec!["café.md".to_string()];
        let nfd_title = "cafe\u{0301}.md";

        assert!(validate_title(&siblings, nfd_title).is_err());
    }

    #[test]
    fn create_note_writes_fresh_frontmatter_with_a_new_ulid() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");

        create_note(&path).unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with("---\nid: "));
        assert!(on_disk.ends_with("---\n"));
    }

    #[test]
    fn create_note_twice_in_succession_gets_different_ids() {
        let dir = TempDir::new().unwrap();

        create_note(&dir.path().join("first.md")).unwrap();
        create_note(&dir.path().join("second.md")).unwrap();

        let first = read_note(&dir.path().join("first.md")).unwrap();
        let second = read_note(&dir.path().join("second.md")).unwrap();

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn create_note_rejects_a_duplicate_title_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        write_file(&dir, "note.md", "---\nid: 01J8X\n---\noriginal\n");

        let result = create_note(&dir.path().join("note.md"));

        assert!(result.is_err());
        let on_disk = fs::read_to_string(dir.path().join("note.md")).unwrap();
        assert_eq!(on_disk, "---\nid: 01J8X\n---\noriginal\n", "original file must be untouched");
    }

    #[test]
    fn create_note_rejects_an_invalid_character_and_writes_nothing() {
        let dir = TempDir::new().unwrap();

        let result = create_note(&dir.path().join("bad:name.md"));

        assert!(result.is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn create_note_allows_the_same_title_in_a_different_directory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("other")).unwrap();
        write_file(&dir, "note.md", "---\nid: 01J8X\n---\noriginal\n");

        let result = create_note(&dir.path().join("other/note.md"));

        assert!(result.is_ok());
    }

    #[test]
    fn create_folder_makes_a_bare_directory() {
        let dir = TempDir::new().unwrap();

        create_folder(&dir.path().join("new-folder")).unwrap();

        assert!(dir.path().join("new-folder").is_dir());
    }

    #[test]
    fn create_folder_rejects_a_duplicate_title_in_the_same_directory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("existing")).unwrap();

        let result = create_folder(&dir.path().join("existing"));

        assert!(result.is_err());
    }

    #[test]
    fn create_folder_allows_the_same_title_in_a_different_root() {
        let root_a = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();
        fs::create_dir(root_a.path().join("shared-name")).unwrap();

        let result = create_folder(&root_b.path().join("shared-name"));

        assert!(result.is_ok());
    }

    #[test]
    fn create_folder_makes_no_git_visible_change() {
        let dir = TempDir::new().unwrap();

        // No .git directory exists at all -- if create_folder touched git in
        // any way this would fail, proving it is git-independent (spec §4/§9.4).
        create_folder(&dir.path().join("new-folder")).unwrap();

        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn delete_item_removes_a_note_file() {
        let dir = TempDir::new().unwrap();
        let path = write_file(&dir, "note.md", "---\nid: 01J8X\n---\nbody\n");

        delete_item(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn delete_item_removes_a_folder_and_its_whole_subtree() {
        let dir = TempDir::new().unwrap();
        let folder_path = dir.path().join("my-folder");
        fs::create_dir(&folder_path).unwrap();
        fs::create_dir(folder_path.join("nested-folder")).unwrap();
        fs::write(folder_path.join("child.md"), "content").unwrap();
        fs::write(folder_path.join("nested-folder/grandchild.md"), "content").unwrap();

        delete_item(&folder_path).unwrap();

        assert!(!folder_path.exists());
    }

    #[test]
    fn delete_item_leaves_siblings_untouched() {
        let dir = TempDir::new().unwrap();
        let target = write_file(&dir, "target.md", "content");
        let sibling = write_file(&dir, "sibling.md", "content");

        delete_item(&target).unwrap();

        assert!(!target.exists());
        assert!(sibling.exists());
    }

    #[test]
    fn delete_item_errors_on_a_nonexistent_path_and_writes_nothing() {
        let dir = TempDir::new().unwrap();

        let result = delete_item(&dir.path().join("does-not-exist.md"));

        assert!(result.is_err());
    }

    fn git(repo_path: &Path, args: &[&str]) -> String {
        let output = crate::gitutil::run_git(repo_path, args).unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn init_repo_with_committed_note(dir: &TempDir, relative: &str, contents: &str) {
        git(dir.path(), &["init"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        write_file(dir, relative, contents);
        git(dir.path(), &["add", relative]);
        git(dir.path(), &["commit", "-m", "add note"]);
    }

    #[test]
    fn move_item_renames_within_the_same_directory() {
        let dir = TempDir::new().unwrap();
        init_repo_with_committed_note(&dir, "old.md", "---\nid: 01J8X\n---\nbody\n");

        move_item(dir.path(), &dir.path().join("old.md"), &dir.path().join("new.md")).unwrap();

        assert!(!dir.path().join("old.md").exists());
        assert!(dir.path().join("new.md").exists());
    }

    #[test]
    fn move_item_moves_a_note_into_a_different_directory() {
        let dir = TempDir::new().unwrap();
        write_dir(&dir, "folder");
        init_repo_with_committed_note(&dir, "note.md", "---\nid: 01J8X\n---\nbody\n");

        move_item(dir.path(), &dir.path().join("note.md"), &dir.path().join("folder/note.md")).unwrap();

        assert!(!dir.path().join("note.md").exists());
        assert!(dir.path().join("folder/note.md").exists());
    }

    #[test]
    fn move_item_moves_a_folder_with_its_whole_subtree() {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        write_file(&dir, "source/nested/note.md", "---\nid: 01J8X\n---\nbody\n");
        write_dir(&dir, "destination");
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "add tree"]);

        move_item(dir.path(), &dir.path().join("source"), &dir.path().join("destination/source")).unwrap();

        assert!(!dir.path().join("source").exists());
        assert!(dir.path().join("destination/source/nested/note.md").exists());
    }

    #[test]
    fn move_item_preserves_the_frontmatter_id_byte_identical_on_rename() {
        let dir = TempDir::new().unwrap();
        let original = "---\nid: 01J8XKEEP\n---\nbody\n";
        init_repo_with_committed_note(&dir, "old.md", original);

        move_item(dir.path(), &dir.path().join("old.md"), &dir.path().join("new.md")).unwrap();

        let on_disk = fs::read_to_string(dir.path().join("new.md")).unwrap();
        assert_eq!(on_disk, original);
    }

    #[test]
    fn move_item_preserves_the_frontmatter_id_byte_identical_on_move_to_another_directory() {
        let dir = TempDir::new().unwrap();
        write_dir(&dir, "folder");
        let original = "---\nid: 01J8XKEEP\n---\nbody\n";
        init_repo_with_committed_note(&dir, "note.md", original);

        move_item(dir.path(), &dir.path().join("note.md"), &dir.path().join("folder/note.md")).unwrap();

        let on_disk = fs::read_to_string(dir.path().join("folder/note.md")).unwrap();
        assert_eq!(on_disk, original);
    }

    #[test]
    fn move_item_stages_a_git_mv_preserving_history_via_log_follow() {
        let dir = TempDir::new().unwrap();
        init_repo_with_committed_note(&dir, "old.md", "---\nid: 01J8X\n---\nbody\n");

        move_item(dir.path(), &dir.path().join("old.md"), &dir.path().join("new.md")).unwrap();
        git(dir.path(), &["commit", "-m", "rename note"]);

        let log = git(dir.path(), &["log", "--follow", "--oneline", "--", "new.md"]);
        assert!(log.contains("add note"), "git log --follow on the new path must show the original commit, got: {log}");
    }

    #[test]
    fn move_item_rejects_a_move_into_a_directory_already_containing_that_title() {
        let dir = TempDir::new().unwrap();
        write_dir(&dir, "folder");
        write_file(&dir, "folder/note.md", "---\nid: 01J8XOTHER\n---\nother\n");
        init_repo_with_committed_note(&dir, "note.md", "---\nid: 01J8X\n---\nbody\n");

        let result = move_item(dir.path(), &dir.path().join("note.md"), &dir.path().join("folder/note.md"));

        assert!(result.is_err());
        assert!(dir.path().join("note.md").exists(), "source must be untouched on rejection");
    }

    #[test]
    fn move_item_rejects_an_invalid_character_in_the_destination_name() {
        let dir = TempDir::new().unwrap();
        init_repo_with_committed_note(&dir, "note.md", "---\nid: 01J8X\n---\nbody\n");

        let result = move_item(dir.path(), &dir.path().join("note.md"), &dir.path().join("bad:name.md"));

        assert!(result.is_err());
        assert!(dir.path().join("note.md").exists(), "source must be untouched on rejection");
    }

    #[test]
    fn move_item_rejects_dragging_a_folder_into_its_own_descendant() {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init"]);
        write_dir(&dir, "parent/child");

        let result = move_item(
            dir.path(),
            &dir.path().join("parent"),
            &dir.path().join("parent/child/parent"),
        );

        assert!(result.is_err());
        assert!(dir.path().join("parent").exists());
        assert!(dir.path().join("parent/child").exists());
    }

    #[test]
    fn move_item_rejects_moving_a_path_onto_itself() {
        let dir = TempDir::new().unwrap();
        init_repo_with_committed_note(&dir, "note.md", "---\nid: 01J8X\n---\nbody\n");

        let result = move_item(dir.path(), &dir.path().join("note.md"), &dir.path().join("note.md"));

        assert!(result.is_err());
    }
}
