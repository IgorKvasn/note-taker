import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { LinkedNote } from "../ipc";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { NoteLinkPicker } from "./NoteLinkPicker";
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertNoteLink,
  insertTable,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleOrderedList,
  toggleTaskList,
  toggleWrap,
} from "./toolbarCommands";
import "./NoteToolbar.css";

interface NoteToolbarProps {
  view: EditorView | null;
  /** Linkable notes in the current root; same-root only by design. */
  linkableNotes?: LinkedNote[];
  /** Triggers the image-attach flow (file dialog, then write + insert) for
   * the 🖼 button's "Attach image file…" menu item (issue #75, wired into the
   * menu by #76). Absent (e.g. in tests) leaves it a no-op. */
  onAttachImage?: () => void;
  /** Disables the 🖼 button while a pick+write is already in flight, in
   * addition to the existing `view === null` rule. */
  isAttaching?: boolean;
}

interface ToolbarButtonSpec {
  label: string;
  title: string;
  run: (view: EditorView) => void;
}

function dispatchCommand(view: EditorView, run: (view: EditorView) => void) {
  run(view);
  view.focus();
}

// The last group of `GROUPS`' plain, CM6-dispatching buttons -- rendered
// separately below, interleaved with the 🖼 button, which unlike every other
// button here doesn't dispatch a CM6 command directly: it opens a menu
// (issue #76) offering either a direct CM6 dispatch or a file dialog, so it
// can't be folded into this uniform `ToolbarButtonSpec` shape.
const INLINE_GROUPS: ToolbarButtonSpec[][] = [
  [
    { label: "B", title: "Bold (Ctrl/Cmd+B)", run: (view) => view.dispatch(toggleWrap(view.state, "**")) },
    { label: "I", title: "Italic (Ctrl/Cmd+I)", run: (view) => view.dispatch(toggleWrap(view.state, "_")) },
    {
      label: "S",
      title: "Strikethrough (Ctrl/Cmd+Shift+X)",
      run: (view) => view.dispatch(toggleWrap(view.state, "~~")),
    },
    { label: "</>", title: "Inline code (Ctrl/Cmd+E)", run: (view) => view.dispatch(toggleWrap(view.state, "`")) },
  ],
  [
    { label: "H1", title: "Heading 1 (Ctrl/Cmd+Alt+1)", run: (view) => view.dispatch(toggleHeading(view.state, 1)) },
    { label: "H2", title: "Heading 2 (Ctrl/Cmd+Alt+2)", run: (view) => view.dispatch(toggleHeading(view.state, 2)) },
    { label: "H3", title: "Heading 3 (Ctrl/Cmd+Alt+3)", run: (view) => view.dispatch(toggleHeading(view.state, 3)) },
  ],
  [
    {
      label: "•",
      title: "Bullet list (Ctrl/Cmd+Shift+8)",
      run: (view) => view.dispatch(toggleBulletList(view.state)),
    },
    {
      label: "1.",
      title: "Ordered list (Ctrl/Cmd+Shift+7)",
      run: (view) => view.dispatch(toggleOrderedList(view.state)),
    },
    { label: "☑", title: "Task list", run: (view) => view.dispatch(toggleTaskList(view.state)) },
  ],
];

const LAST_GROUP_BEFORE_IMAGE: ToolbarButtonSpec[] = [
  {
    label: "❝",
    title: "Blockquote (Ctrl/Cmd+Shift+.)",
    run: (view) => view.dispatch(toggleBlockquote(view.state)),
  },
  { label: "🔗", title: "Link (Ctrl/Cmd+K)", run: (view) => view.dispatch(insertLink(view.state)) },
];

const LAST_GROUP_AFTER_IMAGE: ToolbarButtonSpec[] = [
  { label: "⊞", title: "Table", run: (view) => view.dispatch(insertTable(view.state)) },
  { label: "{ }", title: "Code block", run: (view) => view.dispatch(insertCodeBlock(view.state)) },
  { label: "—", title: "Horizontal rule", run: (view) => view.dispatch(insertHorizontalRule(view.state)) },
];

interface ImageMenuProps {
  onInsertUrl: () => void;
  onAttachFile: () => void;
  onClose: () => void;
}

/**
 * The 🖼 button's dropdown (issue #76): one glyph now maps to two distinct
 * actions -- the pre-#75 typed-URL insert, kept unchanged, and #75's
 * file-attach flow -- with no sensible default for a bare click. Dismissal
 * (click-away, Escape) reuses `useDismissableMenu`, the same hook
 * `TreeContextMenu` uses, rather than a second copy of that logic.
 */
function ImageMenu({ onInsertUrl, onAttachFile, onClose }: ImageMenuProps) {
  const menuRef = useDismissableMenu<HTMLDivElement>(onClose);

  return (
    <div ref={menuRef} className="note-toolbar__image-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onInsertUrl();
          onClose();
        }}
      >
        Insert image URL…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onAttachFile();
          onClose();
        }}
      >
        Attach image file…
      </button>
    </div>
  );
}

function ToolbarButton({ view, button }: { view: EditorView | null; button: ToolbarButtonSpec }) {
  return (
    <button
      type="button"
      className="note-toolbar__button"
      title={button.title}
      disabled={view === null}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (view !== null) {
          dispatchCommand(view, button.run);
        }
      }}
    >
      {button.label}
    </button>
  );
}

export function NoteToolbar({ view, linkableNotes = [], onAttachImage, isAttaching = false }: NoteToolbarProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isImageMenuOpen, setIsImageMenuOpen] = useState(false);

  return (
    <div className="note-toolbar" data-testid="note-toolbar">
      {INLINE_GROUPS.map((group, groupIndex) => (
        <div className="note-toolbar__group" key={groupIndex}>
          {group.map((button) => (
            <ToolbarButton key={button.title} view={view} button={button} />
          ))}
        </div>
      ))}
      <div className="note-toolbar__group">
        {LAST_GROUP_BEFORE_IMAGE.map((button) => (
          <ToolbarButton key={button.title} view={view} button={button} />
        ))}
        <div className="note-toolbar__image-menu-anchor">
          <button
            type="button"
            className="note-toolbar__button"
            title="Image"
            disabled={view === null || isAttaching}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setIsImageMenuOpen(true)}
          >
            🖼
          </button>
          {isImageMenuOpen && (
            <ImageMenu
              onInsertUrl={() => {
                if (view !== null) {
                  dispatchCommand(view, (target) => target.dispatch(insertImage(target.state)));
                }
              }}
              onAttachFile={() => onAttachImage?.()}
              onClose={() => setIsImageMenuOpen(false)}
            />
          )}
        </div>
        {LAST_GROUP_AFTER_IMAGE.map((button) => (
          <ToolbarButton key={button.title} view={view} button={button} />
        ))}
      </div>
      <div className="note-toolbar__group">
        <button
          type="button"
          className="note-toolbar__button"
          title="Link to note"
          disabled={view === null}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setIsPickerOpen(true)}
        >
          🔖
        </button>
      </div>
      {isPickerOpen && (
        <NoteLinkPicker
          notes={linkableNotes}
          onCancel={() => {
            setIsPickerOpen(false);
            view?.focus();
          }}
          onSelect={(note) => {
            setIsPickerOpen(false);
            if (view !== null) {
              dispatchCommand(view, (target) => target.dispatch(insertNoteLink(target.state, note.title, note.id)));
            }
          }}
        />
      )}
    </div>
  );
}
