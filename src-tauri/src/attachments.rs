//! Image attachments (`attachment:<ULID>`), mirroring the `note:` cross-note
//! link mechanism (spec §11): a custom URL scheme resolved by the app, stored
//! as plain files committed to git.
//!
//! Every attachment lives in one per-root `.attachments/` directory. The
//! dot-prefix means `tree::list_tree` and `search::walk_markdown_files`
//! already skip it with no new code, and `config::resolve_path_in_root`
//! already accepts `.attachments/foo.png` as two `Normal` path components.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use ulid::Ulid;

use crate::notes::split_frontmatter;
use crate::search::walk_markdown_files;

/// The `attachment:` URL scheme carrying a target attachment's ULID.
const ATTACHMENT_SCHEME: &str = "attachment:";

const ATTACHMENTS_DIR: &str = ".attachments";

/// A pull can bring an attachment in before the note referencing it (or before
/// a root has fully synced); a naive cleanup scan would see it as unreferenced
/// and delete it. `git checkout`/`pull` sets mtime to "now" for any file it
/// writes, so this window is exactly what a fresh pull's mtime looks like.
const CLEANUP_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);

/// Recognized image formats, sniffed from magic bytes -- never from a
/// client-supplied extension or MIME type (spec §11.3).
enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    fn extension(&self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Gif => "gif",
            ImageFormat::Webp => "webp",
        }
    }
}

/// Sniffs `bytes` against known image magic numbers. `None` for anything else,
/// including a mislabeled non-image file -- the caller has no fallback format.
fn sniff_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    None
}

/// Strips a name down to its filesystem-safe stem for embedding in the
/// generated filename -- an original name is user/tool-supplied (a pasted
/// screenshot's suggested name, or a dragged file's basename) and is never
/// trusted as a path component. Only the stem survives; any extension the
/// caller supplied is replaced by the sniffed format's own.
fn sanitized_stem(original_name: Option<&str>) -> String {
    let name = original_name.unwrap_or("pasted");
    // Take only the final path segment, ignoring any directory components a
    // caller-supplied name might carry, then drop any extension.
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = base.rsplit_once('.').map_or(base, |(stem, _)| stem);

    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    if cleaned.is_empty() {
        "pasted".to_string()
    } else {
        cleaned
    }
}

fn attachments_dir(root_path: &Path) -> PathBuf {
    root_path.join(ATTACHMENTS_DIR)
}

/// Validates `bytes` as a recognized image format and writes it into
/// `<root>/.attachments/<ULID>-<stem>.<ext>`, creating the directory on demand.
/// Returns the `attachment:<ULID>` reference to insert into the note.
pub fn write_attachment(
    root_path: &Path,
    bytes: &[u8],
    original_name: Option<&str>,
) -> Result<String, String> {
    let format = sniff_image_format(bytes)
        .ok_or_else(|| "not a recognized image format (PNG, JPEG, GIF, or WebP)".to_string())?;

    let dir = attachments_dir(root_path);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let id = Ulid::generate().to_string();
    let stem = sanitized_stem(original_name);
    let file_name = format!("{id}-{stem}.{}", format.extension());

    fs::write(dir.join(file_name), bytes).map_err(|error| error.to_string())?;

    Ok(format!("{ATTACHMENT_SCHEME}{id}"))
}

/// Reads `absolute_path` server-side, then behaves exactly like
/// [`write_attachment`] -- same sniffing, same ULID generation, same write.
/// This is a deliberate, narrow exception to the rule that absolute paths
/// never cross the IPC boundary (spec §11.3): shared plumbing between
/// drag-and-drop and the `text/uri-list` paste case.
pub fn import_attachment(root_path: &Path, absolute_path: &Path) -> Result<String, String> {
    let bytes = fs::read(absolute_path).map_err(|error| error.to_string())?;
    let original_name = absolute_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    write_attachment(root_path, &bytes, original_name.as_deref())
}

/// Resolves `id` to its file in `.attachments/` via a directory-list
/// prefix-match -- no content scan needed, unlike `note:` link resolution,
/// since the ULID is embedded in the filename itself.
pub fn read_attachment(root_path: &Path, id: &str) -> Result<Vec<u8>, String> {
    let dir = attachments_dir(root_path);
    let prefix = format!("{id}-");

    let entries = fs::read_dir(&dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(&prefix) {
            return fs::read(entry.path()).map_err(|error| error.to_string());
        }
    }

    Err(format!("no attachment found for id {id}"))
}

/// Extracts the ULIDs referenced by `attachment:<ULID>` in a body -- a plain
/// substring scan, mirroring `links::extract_link_targets` exactly (spec
/// §11.6), including its accepted false-negative for a reference written
/// inside a code fence.
fn extract_attachment_references(body: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = body;

    while let Some(pivot) = rest.find("](") {
        let after_paren = &rest[pivot + "](".len()..];
        rest = after_paren;

        let Some(url) = after_paren.split(')').next() else {
            continue;
        };
        let url = url.split_whitespace().next().unwrap_or("");

        if let Some(id) = url.strip_prefix(ATTACHMENT_SCHEME) {
            if !id.is_empty() {
                ids.push(id.to_string());
            }
        }
    }

    ids
}

/// Every `attachment:<ULID>` referenced anywhere in `root_path`'s notes, plus
/// an optional live (possibly unsaved) buffer's own references -- so an
/// attachment referenced only on-screen isn't treated as orphaned. Frontmatter
/// is excluded from the scan, matching the note-link scan.
fn referenced_ids(
    root_path: &Path,
    open_buffer_content: Option<&str>,
) -> std::collections::HashSet<String> {
    let mut files = Vec::new();
    walk_markdown_files(root_path, &mut files);

    let mut ids = std::collections::HashSet::new();
    for absolute_path in files {
        let Ok(raw) = fs::read_to_string(&absolute_path) else {
            continue;
        };
        let (_, body) = split_frontmatter(&raw);
        ids.extend(extract_attachment_references(body));
    }

    if let Some(buffer) = open_buffer_content {
        let (_, body) = split_frontmatter(buffer);
        ids.extend(extract_attachment_references(body));
    }

    ids
}

/// One attachment file deleted by [`cleanup_unused_attachments`], reported
/// back so a manual trigger can show what it removed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeletedAttachment {
    pub file_name: String,
    pub size_bytes: u64,
}

/// Deletes every attachment in `.attachments/` that no note references,
/// guarded by a 24-hour mtime grace period against a race with `git pull`
/// (spec §11.6): a pull can bring an attachment in before the note that
/// references it, or before a root has fully synced.
///
/// `open_buffer_content` is the currently-open note's live buffer, if any --
/// its references count as live alongside the full-root disk scan.
///
/// `dry_run` computes the same orphan list without deleting anything, so the
/// Settings dialog's manual trigger can show "N unused attachments, X MB --
/// Delete?" before committing to it (spec §11.6).
pub fn cleanup_unused_attachments(
    root_path: &Path,
    open_buffer_content: Option<&str>,
    dry_run: bool,
) -> Result<Vec<DeletedAttachment>, String> {
    let dir = attachments_dir(root_path);

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let live_ids = referenced_ids(root_path, open_buffer_content);
    let now = SystemTime::now();
    let mut deleted = Vec::new();

    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = file_name.split_once('-').map(|(id, _)| id.to_string()) else {
            continue;
        };

        if live_ids.contains(&id) {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age < CLEANUP_GRACE_PERIOD {
            continue;
        }

        let size_bytes = metadata.len();
        if !dry_run {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
        deleted.push(DeletedAttachment {
            file_name,
            size_bytes,
        });
    }

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
    const JPEG_BYTES: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0];
    const GIF_BYTES: &[u8] = b"GIF89a\0\0\0\0";
    const WEBP_BYTES: &[u8] = b"RIFF\0\0\0\0WEBP\0\0\0\0";

    fn write_note(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn write_attachment_accepts_a_real_png_and_returns_its_reference() {
        let dir = TempDir::new().unwrap();

        let reference = write_attachment(dir.path(), PNG_BYTES, Some("screenshot.png")).unwrap();

        assert!(reference.starts_with("attachment:"));
        let id = reference.strip_prefix("attachment:").unwrap();
        let expected_dir = dir.path().join(".attachments");
        let entries: Vec<_> = fs::read_dir(&expected_dir).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let file_name = entries[0].as_ref().unwrap().file_name();
        assert!(file_name
            .to_string_lossy()
            .starts_with(&format!("{id}-screenshot.png")));
    }

    #[test]
    fn write_attachment_detects_jpeg_gif_and_webp_by_magic_bytes() {
        let dir = TempDir::new().unwrap();

        let jpeg_ref = write_attachment(dir.path(), JPEG_BYTES, Some("a.bin")).unwrap();
        let gif_ref = write_attachment(dir.path(), GIF_BYTES, Some("b.bin")).unwrap();
        let webp_ref = write_attachment(dir.path(), WEBP_BYTES, Some("c.bin")).unwrap();

        let jpeg_id = jpeg_ref.strip_prefix("attachment:").unwrap();
        let gif_id = gif_ref.strip_prefix("attachment:").unwrap();
        let webp_id = webp_ref.strip_prefix("attachment:").unwrap();

        assert!(dir
            .path()
            .join(".attachments")
            .join(format!("{jpeg_id}-a.jpg"))
            .exists());
        assert!(dir
            .path()
            .join(".attachments")
            .join(format!("{gif_id}-b.gif"))
            .exists());
        assert!(dir
            .path()
            .join(".attachments")
            .join(format!("{webp_id}-c.webp"))
            .exists());
    }

    #[test]
    fn write_attachment_rejects_non_image_content_regardless_of_claimed_extension() {
        let dir = TempDir::new().unwrap();

        let result = write_attachment(dir.path(), b"not an image at all", Some("fake.png"));

        assert!(result.is_err());
        assert!(!dir.path().join(".attachments").exists());
    }

    #[test]
    fn write_attachment_rejects_a_text_file_claiming_to_be_a_jpeg() {
        let dir = TempDir::new().unwrap();

        let result = write_attachment(dir.path(), b"hello world", Some("evil.jpg"));

        assert!(result.is_err());
    }

    #[test]
    fn write_attachment_with_no_original_name_falls_back_to_pasted() {
        let dir = TempDir::new().unwrap();

        let reference = write_attachment(dir.path(), PNG_BYTES, None).unwrap();

        let id = reference.strip_prefix("attachment:").unwrap();
        assert!(dir
            .path()
            .join(".attachments")
            .join(format!("{id}-pasted.png"))
            .exists());
    }

    #[test]
    fn write_attachment_twice_never_collides_even_with_the_same_original_name() {
        let dir = TempDir::new().unwrap();

        let first = write_attachment(dir.path(), PNG_BYTES, Some("shot.png")).unwrap();
        let second = write_attachment(dir.path(), PNG_BYTES, Some("shot.png")).unwrap();

        assert_ne!(first, second);
        assert_eq!(
            fs::read_dir(dir.path().join(".attachments"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn sanitized_stem_strips_path_separators_from_a_hostile_original_name() {
        assert_eq!(sanitized_stem(Some("../../etc/passwd")), "passwd");
        assert_eq!(sanitized_stem(Some("..\\windows\\system32")), "system32");
    }

    #[test]
    fn import_attachment_reads_bytes_server_side_and_mirrors_write_attachment() {
        let source_dir = TempDir::new().unwrap();
        let root_dir = TempDir::new().unwrap();
        let source_path = source_dir.path().join("photo.png");
        fs::write(&source_path, PNG_BYTES).unwrap();

        let reference = import_attachment(root_dir.path(), &source_path).unwrap();

        let id = reference.strip_prefix("attachment:").unwrap();
        assert!(root_dir
            .path()
            .join(".attachments")
            .join(format!("{id}-photo.png"))
            .exists());
    }

    #[test]
    fn import_attachment_rejects_a_non_image_file() {
        let source_dir = TempDir::new().unwrap();
        let root_dir = TempDir::new().unwrap();
        let source_path = source_dir.path().join("notes.md");
        fs::write(&source_path, "# just markdown").unwrap();

        let result = import_attachment(root_dir.path(), &source_path);

        assert!(result.is_err());
    }

    #[test]
    fn read_attachment_resolves_by_prefix_match_and_returns_raw_bytes() {
        let dir = TempDir::new().unwrap();
        let reference = write_attachment(dir.path(), PNG_BYTES, Some("shot.png")).unwrap();
        let id = reference.strip_prefix("attachment:").unwrap();

        let bytes = read_attachment(dir.path(), id).unwrap();

        assert_eq!(bytes, PNG_BYTES);
    }

    #[test]
    fn read_attachment_errors_on_an_unknown_id() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();

        let result = read_attachment(dir.path(), "01NONEXISTENT");

        assert!(result.is_err());
    }

    #[test]
    fn read_attachment_errors_when_the_attachments_directory_does_not_exist_yet() {
        let dir = TempDir::new().unwrap();

        let result = read_attachment(dir.path(), "01ANY");

        assert!(result.is_err());
    }

    fn set_mtime(path: &Path, age: Duration) {
        let target = SystemTime::now() - age;
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(target).unwrap();
    }

    #[test]
    fn cleanup_deletes_an_old_unreferenced_attachment() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01OLD-orphan.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].file_name, "01OLD-orphan.png");
        assert!(!attachment_path.exists());
    }

    #[test]
    fn cleanup_dry_run_reports_without_deleting() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01DRY-orphan.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));

        let deleted = cleanup_unused_attachments(dir.path(), None, true).unwrap();

        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].file_name, "01DRY-orphan.png");
        assert!(attachment_path.exists(), "dry run must not delete anything");
    }

    #[test]
    fn cleanup_spares_a_recently_written_attachment_within_the_grace_period() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01FRESH-orphan.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        // No `set_mtime` call -- freshly written, well inside the grace period.

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert!(deleted.is_empty());
        assert!(attachment_path.exists());
    }

    #[test]
    fn cleanup_spares_an_old_attachment_still_referenced_by_a_note() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01USED-photo.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));
        write_note(dir.path(), "note.md", "![alt](attachment:01USED)");

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert!(deleted.is_empty());
        assert!(attachment_path.exists());
    }

    #[test]
    fn cleanup_spares_an_old_attachment_referenced_only_in_the_open_unsaved_buffer() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01BUFFER-photo.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));

        let deleted =
            cleanup_unused_attachments(dir.path(), Some("![alt](attachment:01BUFFER)"), false)
                .unwrap();

        assert!(deleted.is_empty());
        assert!(attachment_path.exists());
    }

    #[test]
    fn cleanup_ignores_frontmatter_references() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01FM-photo.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));
        write_note(
            dir.path(),
            "note.md",
            "---\nid: 01SRC\nnote: \"[x](attachment:01FM)\"\n---\nplain body",
        );

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert_eq!(
            deleted.len(),
            1,
            "frontmatter reference must not count as live"
        );
    }

    #[test]
    fn cleanup_is_a_no_op_when_the_attachments_directory_does_not_exist() {
        let dir = TempDir::new().unwrap();

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert!(deleted.is_empty());
    }

    #[test]
    fn cleanup_reports_deleted_file_sizes() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".attachments")).unwrap();
        let attachment_path = dir.path().join(".attachments/01SIZED-orphan.png");
        fs::write(&attachment_path, PNG_BYTES).unwrap();
        set_mtime(&attachment_path, Duration::from_secs(25 * 60 * 60));

        let deleted = cleanup_unused_attachments(dir.path(), None, false).unwrap();

        assert_eq!(deleted[0].size_bytes, PNG_BYTES.len() as u64);
    }

    #[test]
    fn extract_attachment_references_ignores_note_links() {
        let ids = extract_attachment_references("[a](note:01X) and ![b](attachment:01Y)");
        assert_eq!(ids, vec!["01Y".to_string()]);
    }
}
