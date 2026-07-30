import type { EditorView, KeyBinding } from "@codemirror/view";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import {
  insertLink,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleOrderedList,
  toggleWrap,
} from "./toolbarCommands";

function runCommand(command: (state: EditorState) => TransactionSpec): (view: EditorView) => boolean {
  return (view) => {
    view.dispatch(command(view.state));
    return true;
  };
}

/**
 * Keyboard shortcuts for the formatting commands also available from
 * `NoteToolbar`. Bindings are placed ahead of `defaultKeymap`/`historyKeymap`
 * in the extensions list (precedence is by registration order), which matters
 * for `Mod-i`: CodeMirror's default keymap already binds it to
 * `selectParentSyntax`, and italic must win here.
 *
 * Headings use `Mod-Alt-1/2/3` rather than `Mod-1/2/3` to avoid OS/browser
 * tab-switching shortcuts. Strikethrough and inline code have no universal
 * convention, so `Mod-Shift-x` and `Mod-e` were picked (matching common
 * markdown editors) and are documented in each toolbar button's tooltip.
 */
export const noteEditorKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: runCommand((state) => toggleWrap(state, "**")) },
  { key: "Mod-i", run: runCommand((state) => toggleWrap(state, "_")) },
  { key: "Mod-Shift-x", run: runCommand((state) => toggleWrap(state, "~~")) },
  { key: "Mod-e", run: runCommand((state) => toggleWrap(state, "`")) },
  { key: "Mod-k", run: runCommand(insertLink) },
  { key: "Mod-Alt-1", run: runCommand((state) => toggleHeading(state, 1)) },
  { key: "Mod-Alt-2", run: runCommand((state) => toggleHeading(state, 2)) },
  { key: "Mod-Alt-3", run: runCommand((state) => toggleHeading(state, 3)) },
  { key: "Mod-Shift-8", run: runCommand(toggleBulletList) },
  { key: "Mod-Shift-7", run: runCommand(toggleOrderedList) },
  { key: "Mod-Shift-.", run: runCommand(toggleBlockquote) },
];
