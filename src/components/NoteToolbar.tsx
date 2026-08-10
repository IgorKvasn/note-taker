import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { LinkedNote } from "../ipc";
import { NoteLinkPicker } from "./NoteLinkPicker";
import {
  insertCodeBlock,
  insertHorizontalRule,
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
   * the 🖼 button (issue #75). Absent (e.g. in tests) leaves it a no-op. */
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
// button here doesn't dispatch a CM6 command directly: it opens a file
// dialog first (issue #75), so it can't be folded into this uniform
// `ToolbarButtonSpec` shape.
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
        <button
          type="button"
          className="note-toolbar__button"
          title="Image"
          disabled={view === null || isAttaching}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAttachImage?.()}
        >
          🖼
        </button>
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
