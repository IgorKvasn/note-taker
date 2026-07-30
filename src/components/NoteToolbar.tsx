import type { EditorView } from "@codemirror/view";
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertImage,
  insertLink,
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
    { label: "B", title: "Bold", run: (view) => view.dispatch(toggleWrap(view.state, "**")) },
    { label: "I", title: "Italic", run: (view) => view.dispatch(toggleWrap(view.state, "_")) },
    { label: "S", title: "Strikethrough", run: (view) => view.dispatch(toggleWrap(view.state, "~~")) },
    { label: "</>", title: "Inline code", run: (view) => view.dispatch(toggleWrap(view.state, "`")) },
  ],
  [
    { label: "H1", title: "Heading 1", run: (view) => view.dispatch(toggleHeading(view.state, 1)) },
    { label: "H2", title: "Heading 2", run: (view) => view.dispatch(toggleHeading(view.state, 2)) },
    { label: "H3", title: "Heading 3", run: (view) => view.dispatch(toggleHeading(view.state, 3)) },
  ],
  [
    { label: "•", title: "Bullet list", run: (view) => view.dispatch(toggleBulletList(view.state)) },
    { label: "1.", title: "Ordered list", run: (view) => view.dispatch(toggleOrderedList(view.state)) },
    { label: "☑", title: "Task list", run: (view) => view.dispatch(toggleTaskList(view.state)) },
  ],
  [
    { label: "❝", title: "Blockquote", run: (view) => view.dispatch(toggleBlockquote(view.state)) },
    { label: "🔗", title: "Link", run: (view) => view.dispatch(insertLink(view.state)) },
    { label: "🖼", title: "Image", run: (view) => view.dispatch(insertImage(view.state)) },
    { label: "⊞", title: "Table", run: (view) => view.dispatch(insertTable(view.state)) },
    { label: "{ }", title: "Code block", run: (view) => view.dispatch(insertCodeBlock(view.state)) },
    { label: "—", title: "Horizontal rule", run: (view) => view.dispatch(insertHorizontalRule(view.state)) },
  ],
];

export function NoteToolbar({ view }: NoteToolbarProps) {
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
    </div>
  );
}
