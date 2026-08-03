/**
 * The `note:` URL scheme carrying a target note's ULID, e.g.
 * `[Title](note:01J7ABC...)`. Mirrors `NOTE_SCHEME` in
 * `src-tauri/src/links.rs`; the two must stay in step by hand.
 *
 * An ordinary markdown link with a custom scheme, rather than `[[wikilinks]]`,
 * so `remark-gfm` parses it and CodeMirror highlights it with no new plugin on
 * either side (spec §9.2 requires edit and view mode to agree).
 */
export const NOTE_LINK_SCHEME = "note";
export const NOTE_LINK_PROTOCOL = `${NOTE_LINK_SCHEME}:`;

/** Shown on a link whose target is not in the current root, whatever the cause. */
export const BROKEN_NOTE_LINK_TITLE = "Linked note not found (it may not have synced yet).";

/**
 * Returns the ULID a `note:` href points at, or `null` for any other href.
 * Empty (`note:`) counts as not a note link -- there is no ID to resolve.
 */
export function noteLinkTarget(href: string | undefined): string | null {
  if (href === undefined || !href.startsWith(NOTE_LINK_PROTOCOL)) {
    return null;
  }

  const id = href.slice(NOTE_LINK_PROTOCOL.length);
  return id === "" ? null : id;
}

/** Builds the markdown a picker selection inserts at the cursor. */
export function formatNoteLink(title: string, id: string): string {
  return `[${title}](${NOTE_LINK_PROTOCOL}${id})`;
}
