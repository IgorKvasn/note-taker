import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { LinkedNote } from "../ipc";
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
  /** Opens the native file picker and attaches the chosen image (spec §11.1). */
  onAttachImageFile?: () => void;
  /** Disables 🖼 while an attach (paste, drop, or picker) is in flight, in
   * addition to the existing `view === null` rule. */
  isAttaching?: boolean;
}

interface ImageMenuProps {
  onInsertUrl: () => void;
  onAttachFile: () => void;
  onClose: () => void;
}

/** The 🖼 button's menu (spec §11.1) -- the toolbar's one exception to the
 * flat-row-no-dropdowns framing, since one glyph now maps to two distinct
 * actions with no natural default for a bare click. Dismissed like
 * `TreeContextMenu`: click-away, Escape, or item selection. */
function ImageMenu({ onInsertUrl, onAttachFile, onClose }: ImageMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="note-toolbar__image-menu" role="menu">
      <button type="button" role="menuitem" onClick={onInsertUrl}>
        Insert image URL…
      </button>
      <button type="button" role="menuitem" onClick={onAttachFile}>
        Attach image file…
      </button>
    </div>
  );
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

const GROUPS: ToolbarButtonSpec[][] = [
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
  [
    {
      label: "❝",
      title: "Blockquote (Ctrl/Cmd+Shift+.)",
      run: (view) => view.dispatch(toggleBlockquote(view.state)),
    },
    { label: "🔗", title: "Link (Ctrl/Cmd+K)", run: (view) => view.dispatch(insertLink(view.state)) },
    { label: "⊞", title: "Table", run: (view) => view.dispatch(insertTable(view.state)) },
    { label: "{ }", title: "Code block", run: (view) => view.dispatch(insertCodeBlock(view.state)) },
    { label: "—", title: "Horizontal rule", run: (view) => view.dispatch(insertHorizontalRule(view.state)) },
  ],
];

export function NoteToolbar({
  view,
  linkableNotes = [],
  onAttachImageFile,
  isAttaching = false,
}: NoteToolbarProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isImageMenuOpen, setIsImageMenuOpen] = useState(false);

  return (
    <div className="note-toolbar" data-testid="note-toolbar">
      {GROUPS.map((group, groupIndex) => (
        <div className="note-toolbar__group" key={groupIndex}>
          {group.map((button) => (
            <button
              key={button.title}
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
          ))}
        </div>
      ))}
      <div className="note-toolbar__group note-toolbar__group--image">
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
            onClose={() => setIsImageMenuOpen(false)}
            onInsertUrl={() => {
              setIsImageMenuOpen(false);
              if (view !== null) {
                dispatchCommand(view, (target) => target.dispatch(insertImage(target.state)));
              }
            }}
            onAttachFile={() => {
              setIsImageMenuOpen(false);
              onAttachImageFile?.();
            }}
          />
        )}
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
