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

const RGBA_BYTES_PER_PIXEL: usize = 4;

/// PNG-encodes a raw RGBA buffer, as read from the system clipboard (issue
/// #91). The clipboard yields undecorated pixels, not an encoded image, so
/// this must run before [`write_attachment`] -- whose magic-byte sniff would
/// otherwise reject the raw buffer outright.
///
/// Validates the buffer against `width x height x 4` first: a mismatch means
/// the clipboard handed back something other than what its own dimensions
/// describe, which would otherwise panic inside the encoder.
pub fn encode_rgba_as_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("clipboard image has zero width or height".to_string());
    }

    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(RGBA_BYTES_PER_PIXEL))
        .ok_or_else(|| "clipboard image dimensions are implausibly large".to_string())?;

    if rgba.len() != expected {
        return Err(format!(
            "clipboard image buffer is {} bytes but {width}x{height} RGBA needs {expected}",
            rgba.len()
        ));
    }

    let mut png_bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .and_then(|mut writer| writer.write_image_data(rgba))
        .map_err(|error| format!("could not PNG-encode the clipboard image: {error}"))?;

    Ok(png_bytes)
}

/// Reads `absolute_path` server-side and otherwise behaves exactly like
/// [`write_attachment`] (spec §11.3): same magic-byte validation, same ULID
/// generation, same `.attachments/` write. `original_name` is `None` so the
/// written filename is derived from `absolute_path`'s own file name -- this
/// is the one narrow, spec-sanctioned exception to absolute paths never
/// crossing the IPC boundary, shared plumbing for the file-manager-path paste
/// case (#77) and drag-and-drop (#78).
pub fn import_attachment(root_path: &Path, absolute_path: &Path) -> Result<String, String> {
    let bytes = fs::read(absolute_path).map_err(|error| error.to_string())?;
    let original_name = absolute_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    write_attachment(root_path, &bytes, original_name.as_deref())
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

    #[test]
    fn import_attachment_reads_a_real_file_and_writes_it_into_attachments_with_its_name() {
        let root = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        let source_path = source.path().join("vacation.png");
        fs::write(&source_path, PNG_BYTES).unwrap();

        let reference = import_attachment(root.path(), &source_path).unwrap();

        assert!(reference.starts_with(ATTACHMENT_SCHEME));
        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
        let path = find_attachment_path(root.path(), id).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(file_name.starts_with(&format!("{id}-vacation")));
        assert!(file_name.ends_with(".png"));
        assert_eq!(fs::read(&path).unwrap(), PNG_BYTES);
    }

    #[test]
    fn import_attachment_rejects_non_image_content_even_with_an_image_like_extension_and_path() {
        let root = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        let source_path = source.path().join("fake.png");
        fs::write(&source_path, b"not actually an image").unwrap();

        let result = import_attachment(root.path(), &source_path);

        assert!(result.is_err());
        assert!(
            !root.path().join(ATTACHMENTS_DIR).exists(),
            "a rejected import must create nothing"
        );
    }

    #[test]
    fn import_attachment_errors_when_the_source_path_does_not_exist() {
        let root = TempDir::new().unwrap();

        let result = import_attachment(root.path(), Path::new("/nonexistent/does-not-exist.png"));

        assert!(result.is_err());
    }

    #[test]
    fn encode_rgba_as_png_produces_bytes_that_pass_the_magic_byte_sniff() {
        let rgba = vec![0xFF; 2 * 3 * RGBA_BYTES_PER_PIXEL];

        let png_bytes = encode_rgba_as_png(&rgba, 2, 3).unwrap();

        assert_eq!(sniff_image_extension(&png_bytes).unwrap(), "png");
    }

    #[test]
    fn encode_rgba_as_png_output_is_accepted_by_write_attachment_end_to_end() {
        let dir = TempDir::new().unwrap();
        let rgba = vec![0x7F; 4 * 4 * RGBA_BYTES_PER_PIXEL];
        let png_bytes = encode_rgba_as_png(&rgba, 4, 4).unwrap();

        let reference = write_attachment(dir.path(), &png_bytes, None).unwrap();

        let id = reference.strip_prefix(ATTACHMENT_SCHEME).unwrap();
        let path = find_attachment_path(dir.path(), id).unwrap();
        assert_eq!(path.extension().unwrap().to_str().unwrap(), "png");
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            format!("{id}-pasted.png"),
            "a clipboard paste has no filename, so it takes the `pasted` default"
        );
    }

    #[test]
    fn encode_rgba_as_png_rejects_a_buffer_that_does_not_match_the_stated_dimensions() {
        // One pixel short of 2x2 RGBA -- the shape that would panic inside the
        // encoder if it reached it.
        let rgba = vec![0xFF; 3 * RGBA_BYTES_PER_PIXEL];

        let result = encode_rgba_as_png(&rgba, 2, 2);

        assert!(
            result.is_err(),
            "a short buffer must be rejected, not panic"
        );
    }

    #[test]
    fn encode_rgba_as_png_rejects_zero_dimensions_rather_than_emitting_an_empty_image() {
        let result = encode_rgba_as_png(&[], 0, 0);

        assert!(result.is_err());
    }

    #[test]
    fn encode_rgba_as_png_rejects_dimensions_that_overflow_a_buffer_length() {
        let result = encode_rgba_as_png(&[0xFF; 4], u32::MAX, u32::MAX);

        assert!(
            result.is_err(),
            "an overflowing width x height x 4 must be reported, not wrap around"
        );
    }

    #[test]
    fn import_attachment_twice_in_succession_produces_collision_free_filenames() {
        let root = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        let source_path = source.path().join("photo.png");
        fs::write(&source_path, PNG_BYTES).unwrap();

        let first = import_attachment(root.path(), &source_path).unwrap();
        let second = import_attachment(root.path(), &source_path).unwrap();

        assert_ne!(first, second);
        let entries: Vec<_> = fs::read_dir(root.path().join(ATTACHMENTS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 2);
    }
}
