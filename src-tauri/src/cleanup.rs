//! Orphaned-attachment cleanup (spec §11.5), mirroring `links.rs`'s `note:`
//! scan in technique: plain substring matching for `attachment:<ULID>`
//! occurrences, frontmatter excluded, no fenced-code-block awareness. Accepts
//! the same rare false-negative edge case `links.rs` does -- a bare reference
//! written inside a code fence still counts as "referenced".
//!
//! The reference scan is meant to run once per session and be cached (issue
//! #79); [`ReferenceCache`] is that cache, owned as Tauri-managed state the
//! same way `sync::SyncManager` is, and updated incrementally by
//! [`ReferenceCache::update_note`] on every save rather than rescanned wholesale.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::attachments::ATTACHMENT_SCHEME;
use crate::notes::split_frontmatter;
use crate::search::walk_markdown_files;

const ATTACHMENTS_DIR: &str = ".attachments";

/// An attachment younger than this is never cleaned up regardless of
/// reference status -- guards against a `git pull` race where the attachment
/// file arrives before the note that references it (spec §11.5).
const GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);

/// Extracts the ULIDs referenced by `attachment:<ULID>` occurrences in `body`,
/// via plain substring matching -- deliberately not reusing `links.rs`'s
/// `](scheme:` pivot, since an attachment reference is only ever meaningful as
/// an image source (`![alt](attachment:ULID)`), but a plain substring scan
/// (matching wherever the scheme text appears, image markup or not) is what
/// the spec calls for here, same rationale as the `note:` scan: cheap, and the
/// only false negative it accepts is a reference sitting inside a code fence
/// or backticks being (over-)counted as real. A ULID never contains `)`, `"`,
/// whitespace, or `]`, so scanning up to the first such character is enough to
/// isolate it from whatever follows.
fn extract_referenced_ids(body: &str) -> HashSet<String> {
    let mut ids = HashSet::new();
    let mut rest = body;

    while let Some(pivot) = rest.find(ATTACHMENT_SCHEME) {
        let after_scheme = &rest[pivot + ATTACHMENT_SCHEME.len()..];
        rest = after_scheme;

        let end = after_scheme
            .find(|c: char| c == ')' || c == '"' || c == ']' || c.is_whitespace())
            .unwrap_or(after_scheme.len());
        let id = &after_scheme[..end];
        if !id.is_empty() {
            ids.insert(id.to_string());
        }
    }

    ids
}

/// The set of `attachment:<ULID>` references found in one note's body
/// (frontmatter excluded), keyed by the note's root-relative path.
type NoteReferences = HashMap<String, HashSet<String>>;

/// Walks `root_path` once, extracting `attachment:<ULID>` references from
/// every note body. A file that cannot be read is skipped rather than failing
/// the whole scan, matching `links::scan_links`.
fn scan_references(root_path: &Path) -> NoteReferences {
    let mut files = Vec::new();
    walk_markdown_files(root_path, &mut files);

    let mut references = NoteReferences::new();
    for absolute_path in files {
        let Ok(relative_path) = absolute_path.strip_prefix(root_path) else {
            continue;
        };
        let relative_path = relative_path.to_string_lossy().replace('\\', "/");

        let Ok(raw) = fs::read_to_string(&absolute_path) else {
            continue;
        };
        let (_, body) = split_frontmatter(&raw);
        references.insert(relative_path, extract_referenced_ids(body));
    }

    references
}

/// Session-level cache of one root's reference scan (issue #79 -- "runs once
/// per session ... cached; each note save incrementally updates the cache").
/// Owned as Tauri-managed state, mirroring `sync::SyncManager`'s per-root
/// `Mutex<HashMap<...>>` shape.
#[derive(Default)]
pub struct ReferenceCache {
    by_root: Mutex<HashMap<String, NoteReferences>>,
}

impl ReferenceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns this root's cached references, scanning and populating the
    /// cache on first use this session. Later calls reuse the cached value
    /// without touching the filesystem again.
    fn get_or_scan(&self, root_id: &str, root_path: &Path) -> NoteReferences {
        let mut by_root = self.by_root.lock().unwrap();
        by_root
            .entry(root_id.to_string())
            .or_insert_with(|| scan_references(root_path))
            .clone()
    }

    /// Incrementally updates just `path`'s entry after a note save, so a save
    /// never triggers a full root rescan. Only meaningful once a scan has
    /// already populated this root's cache; a root with no cached entry yet
    /// is left alone, since the first scan will read this (already-saved)
    /// content anyway.
    pub fn update_note(&self, root_id: &str, path: &str, content: &str) {
        let mut by_root = self.by_root.lock().unwrap();
        if let Some(references) = by_root.get_mut(root_id) {
            let (_, body) = split_frontmatter(content);
            references.insert(path.to_string(), extract_referenced_ids(body));
        }
    }
}

/// One attachment file slated for (or excluded from) cleanup.
struct AttachmentFile {
    path: std::path::PathBuf,
    id: String,
    size: u64,
    modified: SystemTime,
}

/// Lists `.attachments/`'s files, extracting each one's ULID from its
/// `<ULID>-<name>.<ext>` filename. A file whose metadata can't be read (or
/// whose name doesn't start with a ULID-shaped prefix) is skipped rather than
/// failing the whole listing.
fn list_attachment_files(root_path: &Path) -> Vec<AttachmentFile> {
    let attachments_dir = root_path.join(ATTACHMENTS_DIR);
    let Ok(entries) = fs::read_dir(&attachments_dir) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some((id, _)) = file_name.split_once('-') else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };

        files.push(AttachmentFile {
            path,
            id: id.to_string(),
            size: metadata.len(),
            modified,
        });
    }

    files
}

/// True if `modified` is old enough to leave the 24-hour grace period as of
/// `now` -- an attachment younger than that is never a cleanup candidate,
/// regardless of reference status.
fn is_past_grace_period(modified: SystemTime, now: SystemTime) -> bool {
    match now.duration_since(modified) {
        Ok(age) => age >= GRACE_PERIOD,
        // A `modified` time at or after `now` (clock skew, or freshly written
        // this instant) is never past the grace period.
        Err(_) => false,
    }
}

/// Every id referenced across `references` plus `extra_reference_text` (the
/// currently-open note's live, possibly-unsaved buffer -- issue #79's
/// "additional reference source", omitted by passing `None` when no note is
/// open).
fn all_referenced_ids(
    references: &NoteReferences,
    extra_reference_text: Option<&str>,
) -> HashSet<String> {
    let mut ids: HashSet<String> = references.values().flatten().cloned().collect();
    if let Some(text) = extra_reference_text {
        ids.extend(extract_referenced_ids(text));
    }
    ids
}

/// One attachment identified as orphaned: unreferenced by any note (including
/// `extra_reference_text`) and past the 24-hour grace period.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OrphanedAttachment {
    /// The root this attachment was found in -- needed once a preview spans
    /// multiple roots (issue #89), so execute can call `notes::delete_item`
    /// against the right one.
    pub root_id: String,
    /// Root-relative path (`.attachments/<file>`), suitable for
    /// `notes::delete_item`.
    pub path: String,
    pub size: u64,
}

/// A preview of what cleanup would delete: the count and total size the
/// Settings dialog reports before the user confirms (spec §11.5).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct CleanupPreview {
    pub attachments: Vec<OrphanedAttachment>,
    pub total_size: u64,
}

/// Finds every attachment in `root_path` that is unreferenced by any note
/// (per `cache`'s scan, plus `extra_reference_text` if a note is open) and
/// past the 24-hour grace period. Read-only -- callers decide whether/how to
/// delete what's returned.
pub fn find_orphaned_attachments(
    root_id: &str,
    root_path: &Path,
    cache: &ReferenceCache,
    extra_reference_text: Option<&str>,
) -> CleanupPreview {
    let references = cache.get_or_scan(root_id, root_path);
    let referenced_ids = all_referenced_ids(&references, extra_reference_text);
    let now = SystemTime::now();

    let mut attachments = Vec::new();
    let mut total_size = 0;
    for file in list_attachment_files(root_path) {
        if referenced_ids.contains(&file.id) {
            continue;
        }
        if !is_past_grace_period(file.modified, now) {
            continue;
        }

        let Ok(relative_path) = file.path.strip_prefix(root_path) else {
            continue;
        };
        total_size += file.size;
        attachments.push(OrphanedAttachment {
            root_id: root_id.to_string(),
            path: relative_path.to_string_lossy().replace('\\', "/"),
            size: file.size,
        });
    }

    CleanupPreview {
        attachments,
        total_size,
    }
}

/// Runs [`find_orphaned_attachments`] over every root in `roots`, summing the
/// results into one flat [`CleanupPreview`] -- the shared loop-all-roots shape
/// behind the Settings dialog's all-roots preview/execute commands (issue
/// #89), mirroring the per-root loop the silent startup trigger already uses.
/// `open_root_id`/`open_note_content` are the open note's root and live
/// buffer, if any; the buffer is only passed into the scan for the root whose
/// id matches `open_root_id` -- every other root scans disk-only, same as the
/// background trigger already treats every root that isn't currently open.
pub fn find_orphaned_attachments_across_roots(
    roots: &[crate::config::RootConfig],
    cache: &ReferenceCache,
    open_root_id: Option<&str>,
    open_note_content: Option<&str>,
) -> CleanupPreview {
    let mut combined = CleanupPreview::default();
    for root in roots {
        let extra_reference_text = if Some(root.id.as_str()) == open_root_id {
            open_note_content
        } else {
            None
        };
        let preview =
            find_orphaned_attachments(&root.id, Path::new(&root.path), cache, extra_reference_text);
        combined.attachments.extend(preview.attachments);
        combined.total_size += preview.total_size;
    }
    combined
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;
    use tempfile::TempDir;

    fn write_note(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// Writes an attachment file with a specific mtime, backdated by `age`
    /// from now -- `filetime` isn't a dependency here, so backdating goes
    /// through `set_file_mtime`'s std-only equivalent: write, then set the
    /// modification time via `File::set_modified`.
    fn write_attachment_aged(root: &Path, file_name: &str, bytes: &[u8], age: Duration) {
        let dir = root.join(ATTACHMENTS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file_name);
        fs::write(&path, bytes).unwrap();
        let modified = SystemTime::now() - age;
        let file = fs::File::open(&path).unwrap();
        file.set_modified(modified).unwrap();
    }

    #[test]
    fn extract_referenced_ids_finds_a_plain_substring_reference() {
        let ids = extract_referenced_ids("see ![img](attachment:01AAA) here");
        assert_eq!(ids, HashSet::from(["01AAA".to_string()]));
    }

    #[test]
    fn extract_referenced_ids_finds_a_bare_reference_not_wrapped_in_image_markup() {
        // Plain substring matching, same as links.rs's technique -- no markdown
        // structure is required around the scheme text.
        let ids = extract_referenced_ids("attachment:01AAA is mentioned in prose");
        assert_eq!(ids, HashSet::from(["01AAA".to_string()]));
    }

    #[test]
    fn extract_referenced_ids_finds_multiple_distinct_references() {
        let ids = extract_referenced_ids("![a](attachment:01AAA) and ![b](attachment:01BBB)");
        assert_eq!(
            ids,
            HashSet::from(["01AAA".to_string(), "01BBB".to_string()])
        );
    }

    #[test]
    fn extract_referenced_ids_is_empty_for_a_body_with_no_references() {
        let ids = extract_referenced_ids("nothing to see here");
        assert!(ids.is_empty());
    }

    #[test]
    fn scan_references_excludes_frontmatter() {
        let temp_dir = TempDir::new().unwrap();
        write_note(
            temp_dir.path(),
            "note.md",
            "---\nid: 01SRC\ncover: \"attachment:01FRONT\"\n---\n![img](attachment:01BODY)",
        );

        let references = scan_references(temp_dir.path());

        let ids = &references["note.md"];
        assert!(ids.contains("01BODY"));
        assert!(
            !ids.contains("01FRONT"),
            "a reference in frontmatter must not be scanned"
        );
    }

    #[test]
    fn find_orphaned_attachments_excludes_a_referenced_attachment_regardless_of_age() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "note.md", "![img](attachment:01USED)");
        write_attachment_aged(
            temp_dir.path(),
            "01USED-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();

        let preview = find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        assert!(preview.attachments.is_empty());
    }

    #[test]
    fn find_orphaned_attachments_excludes_an_unreferenced_attachment_within_the_grace_period() {
        let temp_dir = TempDir::new().unwrap();
        write_attachment_aged(
            temp_dir.path(),
            "01FRESH-photo.png",
            b"bytes",
            Duration::from_secs(60 * 60),
        );
        let cache = ReferenceCache::new();

        let preview = find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        assert!(
            preview.attachments.is_empty(),
            "an attachment younger than 24h must be excluded regardless of reference status"
        );
    }

    #[test]
    fn find_orphaned_attachments_includes_an_unreferenced_attachment_past_the_grace_period() {
        let temp_dir = TempDir::new().unwrap();
        write_attachment_aged(
            temp_dir.path(),
            "01STALE-photo.png",
            b"12345",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();

        let preview = find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        assert_eq!(preview.attachments.len(), 1);
        assert_eq!(preview.attachments[0].root_id, "root");
        assert_eq!(
            preview.attachments[0].path,
            ".attachments/01STALE-photo.png"
        );
        assert_eq!(preview.attachments[0].size, 5);
        assert_eq!(preview.total_size, 5);
    }

    #[test]
    fn find_orphaned_attachments_treats_a_live_buffer_reference_as_used() {
        let temp_dir = TempDir::new().unwrap();
        // The referencing note hasn't been saved to disk yet -- only the live
        // buffer mentions it.
        write_attachment_aged(
            temp_dir.path(),
            "01LIVE-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();

        let preview = find_orphaned_attachments(
            "root",
            temp_dir.path(),
            &cache,
            Some("![img](attachment:01LIVE)"),
        );

        assert!(
            preview.attachments.is_empty(),
            "a reference in the live unsaved buffer must prevent cleanup"
        );
    }

    #[test]
    fn find_orphaned_attachments_scans_once_and_reuses_the_cache() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "note.md", "![img](attachment:01USED)");
        write_attachment_aged(
            temp_dir.path(),
            "01USED-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();

        find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        // The note is rewritten with the reference removed, but *without*
        // going through `update_note` -- if the scan reused the stale cache
        // (as intended for a within-session call), the attachment still
        // reads as referenced.
        write_note(temp_dir.path(), "note.md", "no reference anymore");
        let preview = find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        assert!(
            preview.attachments.is_empty(),
            "a second call within the same cache must reuse the first scan, not rescan disk"
        );
    }

    #[test]
    fn update_note_incrementally_reflects_a_save_without_rescanning() {
        let temp_dir = TempDir::new().unwrap();
        write_note(temp_dir.path(), "note.md", "![img](attachment:01USED)");
        write_attachment_aged(
            temp_dir.path(),
            "01USED-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();
        find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        // Disk is left stale (still references 01USED) but the cache is told
        // the note was saved with the reference removed.
        cache.update_note("root", "note.md", "no reference anymore");
        let preview = find_orphaned_attachments("root", temp_dir.path(), &cache, None);

        assert_eq!(preview.attachments.len(), 1);
        assert_eq!(preview.attachments[0].path, ".attachments/01USED-photo.png");
    }

    fn root_config(id: &str, path: &Path) -> crate::config::RootConfig {
        crate::config::RootConfig {
            id: id.to_string(),
            path: path.to_string_lossy().into_owned(),
            auto_sync: false,
            remote_url: String::new(),
            sync_debounce_secs: 5,
        }
    }

    #[test]
    fn find_orphaned_attachments_across_roots_sums_counts_and_sizes_across_roots() {
        let root_a = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();
        write_attachment_aged(
            root_a.path(),
            "01AAA-photo.png",
            b"12345",
            Duration::from_secs(48 * 60 * 60),
        );
        write_attachment_aged(
            root_b.path(),
            "01BBB-photo.png",
            b"1234567",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();
        let roots = [
            root_config("root-a", root_a.path()),
            root_config("root-b", root_b.path()),
        ];

        let preview = find_orphaned_attachments_across_roots(&roots, &cache, None, None);

        assert_eq!(preview.attachments.len(), 2);
        assert_eq!(preview.total_size, 12);
        assert!(preview
            .attachments
            .iter()
            .any(|attachment| attachment.root_id == "root-a" && attachment.size == 5));
        assert!(preview
            .attachments
            .iter()
            .any(|attachment| attachment.root_id == "root-b" && attachment.size == 7));
    }

    #[test]
    fn find_orphaned_attachments_across_roots_scopes_the_open_buffer_to_its_own_root() {
        let root_a = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();
        // Same ULID referenced only in the open note's live buffer, present as
        // an unreferenced-on-disk attachment in both roots.
        write_attachment_aged(
            root_a.path(),
            "01LIVE-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        write_attachment_aged(
            root_b.path(),
            "01LIVE-photo.png",
            b"bytes",
            Duration::from_secs(48 * 60 * 60),
        );
        let cache = ReferenceCache::new();
        let roots = [
            root_config("root-a", root_a.path()),
            root_config("root-b", root_b.path()),
        ];

        let preview = find_orphaned_attachments_across_roots(
            &roots,
            &cache,
            Some("root-a"),
            Some("![img](attachment:01LIVE)"),
        );

        assert_eq!(
            preview.attachments.len(),
            1,
            "the buffer reference must protect only its own root's attachment"
        );
        assert_eq!(preview.attachments[0].root_id, "root-b");
    }

    #[test]
    fn find_orphaned_attachments_across_roots_returns_nothing_for_an_empty_root_list() {
        let cache = ReferenceCache::new();

        let preview = find_orphaned_attachments_across_roots(&[], &cache, None, None);

        assert!(preview.attachments.is_empty());
        assert_eq!(preview.total_size, 0);
    }
}
