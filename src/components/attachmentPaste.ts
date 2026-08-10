import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { COMMAND_IMPORT_ATTACHMENT, COMMAND_WRITE_ATTACHMENT } from "../ipc";
import { attachmentTarget, formatAttachment } from "./attachments";

/**
 * The `file:///`-style URI a file manager's "copy" places on the clipboard as
 * a `text/uri-list` entry -- possibly alongside a comment line (RFC 2483),
 * which is why this scans line by line rather than trusting the whole entry
 * to be one bare URI.
 */
const FILE_URI_PREFIX = "file://";

/** Picks the first `file://` URI out of a `text/uri-list` payload, ignoring
 * `#`-prefixed comment lines and any non-file URIs mixed in. */
function firstFileUri(uriList: string): string | null {
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FILE_URI_PREFIX)) {
      return trimmed;
    }
  }
  return null;
}

/** Converts a `file://` URI to the plain absolute path `import_attachment`
 * expects, via the platform-agnostic `URL` parser rather than a hand-rolled
 * prefix strip -- correctly undoes percent-encoding (e.g. `%20` -> space). */
function fileUriToPath(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname);
}

/** The first image file in a paste's `clipboardData.files`, or `null` if
 * none of them are recognizable image bytes. Branches on the browser-supplied
 * `File.type`, which itself reflects the OS/clipboard's own content sniffing
 * -- never a hardcoded format list, per spec §11's format-agnostic paste
 * requirement (the backend's magic-byte check is still the real gate). */
function firstImageFile(files: FileList): File | null {
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) {
      return file;
    }
  }
  return null;
}

/** Inserts an `attachment:` reference at `pos` in `view`, placing the cursor
 * immediately after it -- mirrors the toolbar attach-file flow's insertion
 * (`NoteEditor.tsx`'s `attachImageFile`), so paste and toolbar-attach behave
 * identically once the reference is in hand. Guards against the view having
 * unmounted (e.g. a note switch) while the write/import was in flight. */
function insertAttachmentReference(view: EditorView, pos: number, alt: string, reference: string) {
  const id = attachmentTarget(reference) ?? reference;
  const insert = formatAttachment(alt, id);
  view.dispatch({
    changes: { from: pos, to: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}

export interface AttachmentPasteHandlers {
  onImportError?: (error: string) => void;
}

/**
 * Handles a paste event on the editor (issue #77): claims and inserts an
 * attachment for image bytes or a `file:///` path, otherwise leaves the event
 * unclaimed so CodeMirror's own paste handling runs. Must decide synchronously
 * whether to claim the paste -- `preventDefault()` is called (if at all)
 * before any async work starts, per spec §11's paste requirement.
 *
 * Returns `true` if the event was claimed (regardless of whether the async
 * write/import eventually succeeds), `false` if it was left alone.
 */
export function handleAttachmentPaste(
  event: ClipboardEvent,
  view: EditorView,
  rootId: string,
  handlers: AttachmentPasteHandlers = {},
): boolean {
  const clipboardData = event.clipboardData;
  if (clipboardData === null) {
    return false;
  }

  const imageFile = firstImageFile(clipboardData.files);
  const fileUri = imageFile === null ? firstFileUri(clipboardData.getData("text/uri-list")) : null;

  if (imageFile === null && fileUri === null) {
    return false;
  }

  event.preventDefault();
  const pos = view.state.selection.main.head;

  const writePromise =
    imageFile !== null
      ? imageFile
          .arrayBuffer()
          .then((buffer) =>
            invoke<string>(COMMAND_WRITE_ATTACHMENT, {
              rootId,
              bytes: Array.from(new Uint8Array(buffer)),
              originalName: imageFile.name || null,
            }),
          )
      : invoke<string>(COMMAND_IMPORT_ATTACHMENT, { rootId, absolutePath: fileUriToPath(fileUri!) });

  const alt = imageFile !== null ? imageFile.name : fileUriToPath(fileUri!).split("/").pop() || "";

  writePromise
    .then((reference) => insertAttachmentReference(view, pos, alt, reference))
    .catch((error: unknown) => handlers.onImportError?.(error instanceof Error ? error.message : String(error)));

  return true;
}
