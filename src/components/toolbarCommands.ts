import { type ChangeSpec, EditorSelection, type EditorState, type Line, type TransactionSpec } from "@codemirror/state";

/** Wraps or, if already wrapped (markers just inside or outside the selection), unwraps `marker`. */
export function toggleWrap(state: EditorState, marker: string): TransactionSpec {
  return state.changeByRange((range) => {
    const { from, to } = range;
    const markerLength = marker.length;

    const outsideBefore = state.sliceDoc(from - markerLength, from);
    const outsideAfter = state.sliceDoc(to, to + markerLength);
    if (outsideBefore === marker && outsideAfter === marker) {
      return {
        changes: { from: from - markerLength, to: to + markerLength, insert: state.sliceDoc(from, to) },
        range: EditorSelection.range(from - markerLength, to - markerLength),
      };
    }

    const insideBefore = state.sliceDoc(from, from + markerLength);
    const insideAfter = state.sliceDoc(to - markerLength, to);
    if (insideBefore === marker && insideAfter === marker && from + markerLength <= to - markerLength) {
      return {
        changes: { from, to, insert: state.sliceDoc(from + markerLength, to - markerLength) },
        range: EditorSelection.range(from, to - 2 * markerLength),
      };
    }

    return {
      changes: { from, to, insert: `${marker}${state.sliceDoc(from, to)}${marker}` },
      range: EditorSelection.range(from + markerLength, to + markerLength),
    };
  });
}

const HEADING_PREFIX = /^(#{1,6}) /;

/** Toggles an `#`-prefix heading on the touched line; a different level replaces rather than stacks. */
export function toggleHeading(state: EditorState, level: number): TransactionSpec {
  const prefix = `${"#".repeat(level)} `;

  return state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const existing = HEADING_PREFIX.exec(line.text);

    const insert = existing !== null && existing[1].length === level ? "" : prefix;
    const removeLength = existing !== null ? existing[0].length : 0;
    const delta = insert.length - removeLength;

    return {
      changes: { from: line.from, to: line.from + removeLength, insert },
      range: EditorSelection.range(range.from + delta, range.to + delta),
    };
  });
}

function touchedLines(state: EditorState, from: number, to: number): Line[] {
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const lines: Line[] = [];
  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
    lines.push(state.doc.line(lineNumber));
  }
  return lines;
}

/**
 * Shared line-prefix toggle for bullet/ordered/task lists and blockquote: the
 * first touched line's current state decides on vs. off for every touched line.
 */
function toggleLinePrefixes(
  state: EditorState,
  matchPrefix: (lineText: string) => string | null,
  makePrefix: (lineIndex: number) => string,
): TransactionSpec {
  return state.changeByRange((range) => {
    const lines = touchedLines(state, range.from, range.to);
    const firstIsOn = matchPrefix(lines[0].text) !== null;

    const changes: ChangeSpec[] = [];
    let lineIndex = 0;
    for (const line of lines) {
      const existing = matchPrefix(line.text);
      if (firstIsOn) {
        if (existing !== null) {
          changes.push({ from: line.from, to: line.from + existing.length, insert: "" });
        }
      } else {
        changes.push({ from: line.from, to: line.from, insert: makePrefix(lineIndex) });
        lineIndex++;
      }
    }

    const changeSet = state.changes(changes);
    return {
      changes,
      range: EditorSelection.range(changeSet.mapPos(range.from), changeSet.mapPos(range.to, 1)),
    };
  });
}

const BULLET_PREFIX = /^- /;

export function toggleBulletList(state: EditorState): TransactionSpec {
  return toggleLinePrefixes(state, (text) => (BULLET_PREFIX.test(text) ? BULLET_PREFIX.exec(text)![0] : null), () => "- ");
}

const ORDERED_PREFIX = /^\d+\. /;

/** Toggles numbered-list prefixes; touched lines are renumbered sequentially from 1. */
export function toggleOrderedList(state: EditorState): TransactionSpec {
  return toggleLinePrefixes(
    state,
    (text) => (ORDERED_PREFIX.test(text) ? ORDERED_PREFIX.exec(text)![0] : null),
    (lineIndex) => `${lineIndex + 1}. `,
  );
}

const TASK_PREFIX = /^- \[[ x]\] /;

export function toggleTaskList(state: EditorState): TransactionSpec {
  return toggleLinePrefixes(state, (text) => (TASK_PREFIX.test(text) ? TASK_PREFIX.exec(text)![0] : null), () => "- [ ] ");
}

const BLOCKQUOTE_PREFIX = /^> /;

export function toggleBlockquote(state: EditorState): TransactionSpec {
  return toggleLinePrefixes(
    state,
    (text) => (BLOCKQUOTE_PREFIX.test(text) ? BLOCKQUOTE_PREFIX.exec(text)![0] : null),
    () => "> ",
  );
}

function insertLinkLike(state: EditorState, open: string, placeholderLabel: string): TransactionSpec {
  return state.changeByRange((range) => {
    const label = state.sliceDoc(range.from, range.to) || placeholderLabel;
    const insert = `${open}[${label}](url)`;
    const urlStart = range.from + insert.length - "url)".length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + "url".length),
    };
  });
}

/** Inserts `[label](url)`, using the selection as the label and leaving the cursor on `url`. */
export function insertLink(state: EditorState): TransactionSpec {
  return insertLinkLike(state, "", "label");
}

/** Inserts `![alt](url)`, using the selection as the alt text and leaving the cursor on `url`. */
export function insertImage(state: EditorState): TransactionSpec {
  return insertLinkLike(state, "!", "alt");
}

/**
 * Inserts `template` on a new line after the current line, adding a leading
 * newline only if the current line isn't already empty. `cursorOffset` places
 * the resulting selection at that offset within `template`, or at the end when
 * omitted.
 */
function insertTemplate(state: EditorState, template: string, cursorOffset?: number): TransactionSpec {
  return state.changeByRange((range) => {
    const line = state.doc.lineAt(range.to);
    const needsLeadingNewline = line.text.length > 0;
    const insert = needsLeadingNewline ? `\n${template}` : template;
    const insertAt = line.to;
    const templateStart = insertAt + (needsLeadingNewline ? 1 : 0);
    const cursor = templateStart + (cursorOffset ?? template.length);
    return {
      changes: { from: insertAt, to: insertAt, insert },
      range: EditorSelection.cursor(cursor),
    };
  });
}

export function insertTable(state: EditorState): TransactionSpec {
  return insertTemplate(state, "| Header | Header |\n| --- | --- |\n| Cell | Cell |");
}

export function insertCodeBlock(state: EditorState): TransactionSpec {
  return insertTemplate(state, "```\n\n```", "```\n".length);
}

export function insertHorizontalRule(state: EditorState): TransactionSpec {
  return insertTemplate(state, "---");
}
