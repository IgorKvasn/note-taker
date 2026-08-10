import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { COMMAND_IMPORT_ATTACHMENT, COMMAND_WRITE_ATTACHMENT } from "../ipc";
import { formatAttachment } from "./attachments";

/** Inserts `![alt](attachment:<id>)` at `pos`, with no placeholder and the
 * cursor placed after -- mirrors `insertNoteLink`'s resolved-selection insert
 * (spec §11.1). Used once a `write_attachment`/`import_attachment` call has
 * already resolved, unlike `insertLinkLike`'s `url` placeholder for an
 * unresolved typed URL. */
export function insertAttachmentReference(view: EditorView, pos: number, reference: string) {
  const insert = formatAttachment("image", reference.slice("attachment:".length));
  view.dispatch({
    changes: { from: pos, to: pos, insert },
    selection: { anchor: pos + insert.length },
  });
}

/** Reads a `File` (e.g. from `clipboardData.files`) as raw bytes for
 * `write_attachment`'s `bytes: Vec<u8>` parameter -- serde deserializes a
 * plain JSON number array into a byte vector; there's no raw-body path for
 * command *arguments* the way `read_attachment`'s `Response` return has. */
async function fileToByteArray(file: File): Promise<number[]> {
  const buffer = await file.arrayBuffer();
  return Array.from(new Uint8Array(buffer));
}

/** Writes clipboard/dropped image bytes to the vault, returning the
 * `attachment:<id>` reference to insert. */
export async function writeAttachmentFile(rootId: string, file: File): Promise<string> {
  const bytes = await fileToByteArray(file);
  const originalName = file.name === "" ? null : file.name;
  return invoke<string>(COMMAND_WRITE_ATTACHMENT, { rootId, bytes, originalName });
}

/** Imports a file already on disk (a dropped or pasted `file:///` path) into
 * the vault, returning the `attachment:<id>` reference to insert. */
export async function importAttachmentPath(rootId: string, absolutePath: string): Promise<string> {
  return invoke<string>(COMMAND_IMPORT_ATTACHMENT, { rootId, absolutePath });
}

/** The first `file:///` URI in a `text/uri-list` payload, decoded to an
 * absolute filesystem path, or `null` if the list is empty or has no `file:`
 * entry. `text/uri-list` may list multiple URIs one per line, with `#`-led
 * comment lines to skip (RFC 2483). */
export function firstFilePathFromUriList(uriList: string): string | null {
  for (const line of uriList.split("\r\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("file://")) {
      return decodeURIComponent(line.slice("file://".length));
    }
    return null;
  }
  return null;
}
