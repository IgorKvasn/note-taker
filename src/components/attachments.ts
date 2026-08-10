/**
 * The `attachment:` URL scheme carrying an image's ULID, e.g.
 * `![alt](attachment:01J7ABC...)`. Mirrors `ATTACHMENT_SCHEME` in
 * `src-tauri/src/attachments.rs`; the two must stay in step by hand.
 *
 * Resolved by the app exactly as `note:` links are (spec §9.2, §11.4), but
 * widened on `src` instead of `href` -- an attachment is an image to render,
 * not a navigation target.
 */
export const ATTACHMENT_SCHEME = "attachment";
export const ATTACHMENT_PROTOCOL = `${ATTACHMENT_SCHEME}:`;

/** Shown on an attachment whose file is not found, whatever the cause. */
export const BROKEN_ATTACHMENT_TITLE = "Attached image not found (it may not have synced yet).";

/**
 * Returns the ULID an `attachment:` src points at, or `null` for any other
 * src. Empty (`attachment:`) counts as not an attachment reference -- there
 * is no ID to resolve.
 */
export function attachmentTarget(src: string | undefined): string | null {
  if (src === undefined || !src.startsWith(ATTACHMENT_PROTOCOL)) {
    return null;
  }

  const id = src.slice(ATTACHMENT_PROTOCOL.length);
  return id === "" ? null : id;
}

/** Builds the markdown an insert (paste, drop, or file-picker attach) writes at the cursor. */
export function formatAttachment(alt: string, id: string): string {
  return `![${alt}](${ATTACHMENT_PROTOCOL}${id})`;
}
