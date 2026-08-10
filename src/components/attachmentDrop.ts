import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { COMMAND_IMPORT_ATTACHMENT } from "../ipc";
import { attachmentTarget, formatAttachment } from "./attachments";

/** Logical (CSS-pixel) coordinates -- the caller converts the native event's
 * `PhysicalPosition` before calling in, since both `DOMRect` (from
 * `getBoundingClientRect`) and `EditorView.posAtCoords` operate in CSS
 * pixels, not the device pixels the native drag-drop event reports. */
export interface LogicalPoint {
  x: number;
  y: number;
}

/** True if `point` falls within `rect` -- used to hit-test a webview-scoped
 * native drag-drop event's position against the editor pane's bounds (issue
 * #78), since the event itself carries no notion of which DOM element it's
 * over. */
export function isWithinRect(point: LogicalPoint, rect: DOMRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

/** Extracts the file name a rejection error should name, from an absolute
 * path. */
function fileNameOf(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export interface AttachmentDropHandlers {
  /** Called once per rejected path, naming it in the message -- per-file, so
   * one bad file among several dropped ones doesn't block the others'
   * captured error from being reported. */
  onImportError?: (message: string) => void;
}

/** Imports one dropped path and, on success, inserts its `attachment:`
 * reference at `pos`, returning the offset just past the inserted text so the
 * next file in the same drop can be placed immediately after it. Resolves to
 * `pos` unchanged on failure (nothing was inserted, so the next insert
 * shouldn't be shifted for it) after reporting the failure via
 * `onImportError`, naming `path`. Chained by `handleAttachmentDrop` below so
 * imports happen strictly in sequence -- both matching "inserted in
 * sequence" and letting each insert's position be based on the real length
 * of what came before it, rather than an assumed one. */
function importAndInsertOne(
  path: string,
  pos: number,
  view: EditorView,
  rootId: string,
  handlers: AttachmentDropHandlers,
): Promise<number> {
  const alt = fileNameOf(path);

  return invoke<string>(COMMAND_IMPORT_ATTACHMENT, { rootId, absolutePath: path })
    .then((reference) => {
      const id = attachmentTarget(reference) ?? reference;
      const insert = formatAttachment(alt, id);
      view.dispatch({
        changes: { from: pos, to: pos, insert },
        selection: { anchor: pos + insert.length },
      });
      view.focus();
      return pos + insert.length;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      handlers.onImportError?.(`${alt}: ${message}`);
      return pos;
    });
}

/**
 * Handles a native webview drop event's file paths (issue #78): hit-tests
 * `position` against the editor pane's `rect` and, if inside, imports each
 * path in sequence via `import_attachment`, inserting an `attachment:`
 * reference for each at the drop position -- computed once via
 * `view.posAtCoords`, not the current text cursor. Each subsequent file's
 * reference is inserted immediately after the previous one actually landed
 * (or at the same position, if the previous one was rejected).
 *
 * A position outside the editor pane's bounds (e.g. over the notes tree) is
 * a no-op, leaving the tree's own drag-to-move handling untouched. A path
 * that fails `import_attachment`'s magic-byte validation is reported through
 * `onImportError` (naming the file) without blocking the other paths in the
 * same drop.
 *
 * Returns `true` if the drop was within bounds and thus handled (regardless
 * of whether individual imports succeed), `false` if it was outside bounds.
 * The caller does not need to await anything -- imports and inserts happen
 * asynchronously in the background.
 */
export function handleAttachmentDrop(
  paths: string[],
  position: LogicalPoint,
  view: EditorView,
  editorRect: DOMRect,
  rootId: string,
  handlers: AttachmentDropHandlers = {},
): boolean {
  if (!isWithinRect(position, editorRect)) {
    return false;
  }

  const dropPos = view.posAtCoords(position, false);

  paths.reduce<Promise<number>>(
    (chain, path) => chain.then((pos) => importAndInsertOne(path, pos, view, rootId, handlers)),
    Promise.resolve(dropPos),
  );

  return true;
}
