//! Image attachment storage (`attachment:<ULID>`), mirroring `note:` link
//! resolution end to end (spec §11): a per-root `.attachments/` directory,
//! magic-byte-validated writes, and prefix-match reads.
//!
//! `.attachments/` is dot-prefixed, so `list_tree` (`tree.rs`) and search
//! (`search.rs`) already skip it, and `resolve_path_in_root` (`config.rs`)
//! already accepts `.attachments/foo.png` as two ordinary path segments --
//! nothing in this module needs to special-case any of that.

use std::fs;
use std::path::{Path, PathBuf};

use ulid::Ulid;

/// The `attachment:` URL scheme carrying an attachment's ULID.
pub const ATTACHMENT_SCHEME: &str = "attachment:";

const ATTACHMENTS_DIR: &str = ".attachments";

/// One recognized image format, carrying both its magic-byte signature and
/// the extension a validated file is named with -- the extension is always
/// derived from sniffed content, never from a client-supplied claim.
struct ImageFormat {
    signature: &'static [u8],
    extension: &'static str,
}

/// Allowed image formats (spec §11.3): PNG, JPEG, GIF, WebP. WebP's signature
/// checks the RIFF container's 4-byte type at offset 8 as part of the match,
/// since `RIFF????WEBP` isn't a contiguous prefix -- handled separately below
/// rather than forced into this table's simple-prefix shape.
const SIMPLE_SIGNATURES: &[ImageFormat] = &[
    ImageFormat {
        signature: &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        extension: "png",
    },
    ImageFormat {
        signature: &[0xFF, 0xD8, 0xFF],
        extension: "jpg",
    },
    ImageFormat {
        signature: b"GIF87a",
        extension: "gif",
    },
    ImageFormat {
        signature: b"GIF89a",
        extension: "gif",
    },
];

const WEBP_RIFF_PREFIX: &[u8] = b"RIFF";
const WEBP_TYPE: &[u8] = b"WEBP";
const WEBP_TYPE_OFFSET: usize = 8;

/// Sniffs `bytes` against the allowed image formats' magic-byte signatures,
/// returning the extension to name the file with. Never trusts a
/// client-supplied extension or MIME type (spec §11.3) -- the caller passes
/// only the bytes.
fn sniff_image_extension(bytes: &[u8]) -> Result<&'static str, String> {
    for format in SIMPLE_SIGNATURES {
        if bytes.starts_with(format.signature) {
            return Ok(format.extension);
        }
    }

    if bytes.starts_with(WEBP_RIFF_PREFIX)
        && bytes.len() >= WEBP_TYPE_OFFSET + WEBP_TYPE.len()
        && &bytes[WEBP_TYPE_OFFSET..WEBP_TYPE_OFFSET + WEBP_TYPE.len()] == WEBP_TYPE
    {
        return Ok("webp");
    }

    Err("file content is not a recognized image format (PNG, JPEG, GIF, or WebP)".to_string())
}

/// Strips a name down to a filesystem-safe stem: no path separators (which
/// would let a crafted `original_name` escape `.attachments/`) and no
/// pre-existing extension (the extension is always the sniffed one, never
/// whatever the client claimed).
fn sanitize_original_name(original_name: Option<&str>) -> String {
    let name = original_name.unwrap_or("pasted");
    let stem = Path::new(name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "pasted".to_string());

    // Path separators surviving `file_stem()` (e.g. a name that is only
    // separators, like "/" or "\\") would still let the joined filename land
    // outside `.attachments/` -- replaced outright rather than rejected, since
    // this is an app-generated fallback, not user-facing validation like
    // `notes::validate_title`.
    stem.replace(['/', '\\'], "_")
}

/// Writes `bytes` into `root_path`'s `.attachments/` directory, generating a
/// fresh ULID and validating content by magic-byte sniffing. Returns the
/// `attachment:<ULID>` reference to insert into a note.
///
/// Creates `.attachments/` on demand via `fs::create_dir_all` -- never via
/// `notes::create_folder` -- so a write always follows in the same call and
/// the empty-directory-produces-no-commit gap (spec §9.4) never applies here.
pub fn write_attachment(
    root_path: &Path,
    bytes: &[u8],
    original_name: Option<&str>,
) -> Result<String, String> {
    let extension = sniff_image_extension(bytes)?;
    let id = Ulid::generate().to_string();
    let stem = sanitize_original_name(original_name);

    let attachments_dir = root_path.join(ATTACHMENTS_DIR);
    fs::create_dir_all(&attachments_dir).map_err(|error| error.to_string())?;

    let file_name = format!("{id}-{stem}.{extension}");
    fs::write(attachments_dir.join(file_name), bytes).map_err(|error| error.to_string())?;

    Ok(format!("{ATTACHMENT_SCHEME}{id}"))
}

/// Resolves `id` to its file in `.attachments/` via a prefix-match directory
/// listing (the filename is `<ULID>-<name>.<ext>`, so the ULID is always a
/// prefix) and returns its raw bytes.
pub fn read_attachment(root_path: &Path, id: &str) -> Result<Vec<u8>, String> {
    let path = find_attachment_path(root_path, id)?;
    fs::read(path).map_err(|error| error.to_string())
}

/// The prefix-match lookup `read_attachment` uses, split out so tests can
/// assert on resolution without also asserting on file contents.
fn find_attachment_path(root_path: &Path, id: &str) -> Result<PathBuf, String> {
    let attachments_dir = root_path.join(ATTACHMENTS_DIR);
    let prefix = format!("{id}-");

    let entries = fs::read_dir(&attachments_dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            return Ok(entry.path());
        }
    }

    Err(format!("no attachment found for id {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // A minimal valid PNG signature -- content after the 8-byte magic number
    // is irrelevant to sniffing, so tests never need a real decodable image.
    const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0];
    const JPEG_BYTES: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0];
    const GIF_BYTES: &[u8] = b"GIF89a\x00\x00";
    const WEBP_BYTES: &[u8] = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

    #[test]
    fn write_attachment_accepts_valid_png_bytes_regardless_of_claimed_extension() {
        let dir = TempDir::new().unwrap();

        let reference = write_attachment(dir.path(), PNG_BYTES, Some("photo.txt")).unwrap();

        assert!(reference.starts_with(ATTACHMENT_SCHEME));
        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
        let entries: Vec<_> = fs::read_dir(dir.path().join(ATTACHMENTS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].starts_with(&format!("{id}-photo")));
        assert!(
            entries[0].ends_with(".png"),
            "extension must be sniffed, not client-claimed: {entries:?}"
        );
    }

    #[test]
    fn write_attachment_accepts_each_allowed_format() {
        let dir = TempDir::new().unwrap();

        for (bytes, expected_ext) in [
            (PNG_BYTES, "png"),
            (JPEG_BYTES, "jpg"),
            (GIF_BYTES, "gif"),
            (WEBP_BYTES, "webp"),
        ] {
            let reference = write_attachment(dir.path(), bytes, None).unwrap();
            let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
            let path = find_attachment_path(dir.path(), id).unwrap();
            assert_eq!(path.extension().unwrap().to_str().unwrap(), expected_ext);
        }
    }

    #[test]
    fn write_attachment_rejects_non_image_content_even_with_an_image_like_extension() {
        let dir = TempDir::new().unwrap();

        let result = write_attachment(dir.path(), b"not actually an image", Some("photo.png"));

        assert!(result.is_err());
        assert!(
            !dir.path().join(ATTACHMENTS_DIR).exists(),
            "a rejected write must create nothing"
        );
    }

    #[test]
    fn write_attachment_creates_the_attachments_directory_on_demand() {
        let dir = TempDir::new().unwrap();
        assert!(!dir.path().join(ATTACHMENTS_DIR).exists());

        write_attachment(dir.path(), PNG_BYTES, None).unwrap();

        assert!(dir.path().join(ATTACHMENTS_DIR).is_dir());
    }

    #[test]
    fn write_attachment_names_a_pasted_image_with_no_original_name() {
        let dir = TempDir::new().unwrap();

        let reference = write_attachment(dir.path(), PNG_BYTES, None).unwrap();

        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
        let path = find_attachment_path(dir.path(), id).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(file_name, format!("{id}-pasted.png"));
    }

    #[test]
    fn write_attachment_twice_in_succession_produces_collision_free_filenames() {
        let dir = TempDir::new().unwrap();

        let first = write_attachment(dir.path(), PNG_BYTES, Some("photo.png")).unwrap();
        let second = write_attachment(dir.path(), PNG_BYTES, Some("photo.png")).unwrap();

        assert_ne!(first, second);
        let entries: Vec<_> = fs::read_dir(dir.path().join(ATTACHMENTS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            entries.len(),
            2,
            "same original name must not collide, each write gets its own ULID"
        );
    }

    #[test]
    fn sanitize_original_name_strips_path_separators_so_a_write_cannot_escape_the_directory() {
        let dir = TempDir::new().unwrap();

        let reference = write_attachment(dir.path(), PNG_BYTES, Some("../../etc/passwd")).unwrap();

        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
        // If the traversal weren't neutralized, this lookup (scoped to
        // `.attachments/`) would find nothing because the file landed elsewhere.
        assert!(find_attachment_path(dir.path(), id).is_ok());
    }

    #[test]
    fn read_attachment_returns_the_bytes_written() {
        let dir = TempDir::new().unwrap();
        let reference = write_attachment(dir.path(), PNG_BYTES, Some("photo.png")).unwrap();
        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();

        let bytes = read_attachment(dir.path(), id).unwrap();

        assert_eq!(bytes, PNG_BYTES);
    }

    #[test]
    fn read_attachment_resolves_by_ulid_prefix_match_ignoring_the_rest_of_the_filename() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(ATTACHMENTS_DIR)).unwrap();
        fs::write(
            dir.path()
                .join(ATTACHMENTS_DIR)
                .join("01ABCDEF-vacation-photo.jpg"),
            JPEG_BYTES,
        )
        .unwrap();

        let bytes = read_attachment(dir.path(), "01ABCDEF").unwrap();

        assert_eq!(bytes, JPEG_BYTES);
    }

    #[test]
    fn read_attachment_errors_when_no_file_matches_the_id() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(ATTACHMENTS_DIR)).unwrap();

        let result = read_attachment(dir.path(), "01NOTFOUND");

        assert!(result.is_err());
    }

    #[test]
    fn read_attachment_errors_when_the_attachments_directory_does_not_exist_yet() {
        let dir = TempDir::new().unwrap();

        let result = read_attachment(dir.path(), "01ANYTHING");

        assert!(result.is_err());
    }
}
