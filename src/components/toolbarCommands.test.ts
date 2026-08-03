import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
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

function stateWithSelection(doc: string, from: number, to: number = from): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(from, to) });
}

describe("toggleWrap", () => {
  it("wraps a plain selection with the given markers", () => {
    const state = stateWithSelection("hello world", 6, 11);

    const spec = toggleWrap(state, "**");
    const result = state.update(spec);

    expect(result.state.doc.toString()).toBe("hello **world**");
  });

  it("strips markers when the selection is exactly the wrapped content, markers just outside", () => {
    const state = stateWithSelection("hello **world**", 8, 13);

    const spec = toggleWrap(state, "**");
    const result = state.update(spec);

    expect(result.state.doc.toString()).toBe("hello world");
  });

  it("strips markers when the selection includes the markers themselves", () => {
    const state = stateWithSelection("hello **world**", 6, 15);

    const spec = toggleWrap(state, "**");
    const result = state.update(spec);

    expect(result.state.doc.toString()).toBe("hello world");
  });

  it("inserts both markers with the cursor between them for an empty selection", () => {
    const state = stateWithSelection("hello ", 6);

    const spec = toggleWrap(state, "**");
    const result = state.update(spec);

    expect(result.state.doc.toString()).toBe("hello ****");
    expect(result.state.selection.main.from).toBe(8);
    expect(result.state.selection.main.to).toBe(8);
  });
});

describe("toggleHeading", () => {
  it("adds the heading prefix to a plain line", () => {
    const state = stateWithSelection("hello", 2);

    const result = state.update(toggleHeading(state, 1));

    expect(result.state.doc.toString()).toBe("# hello");
  });

  it("removes the prefix when the same level is re-applied", () => {
    const state = stateWithSelection("# hello", 3);

    const result = state.update(toggleHeading(state, 1));

    expect(result.state.doc.toString()).toBe("hello");
  });

  it("replaces a different heading level rather than stacking it", () => {
    const state = stateWithSelection("## hello", 3);

    const result = state.update(toggleHeading(state, 1));

    expect(result.state.doc.toString()).toBe("# hello");
  });
});

describe("toggleBulletList", () => {
  it("adds the bullet prefix to every touched line", () => {
    const state = stateWithSelection("one\ntwo\nthree", 0, 13);

    const result = state.update(toggleBulletList(state));

    expect(result.state.doc.toString()).toBe("- one\n- two\n- three");
  });

  it("uses the first touched line's state to decide the toggle direction", () => {
    const state = stateWithSelection("- one\ntwo\n- three", 0, 17);

    const result = state.update(toggleBulletList(state));

    expect(result.state.doc.toString()).toBe("one\ntwo\nthree");
  });
});

describe("toggleOrderedList", () => {
  it("adds sequential numbering to every touched line", () => {
    const state = stateWithSelection("one\ntwo\nthree", 0, 13);

    const result = state.update(toggleOrderedList(state));

    expect(result.state.doc.toString()).toBe("1. one\n2. two\n3. three");
  });

  it("removes numbering when the first touched line is already numbered", () => {
    const state = stateWithSelection("1. one\n2. two\n3. three", 0, 22);

    const result = state.update(toggleOrderedList(state));

    expect(result.state.doc.toString()).toBe("one\ntwo\nthree");
  });
});

describe("toggleTaskList", () => {
  it("adds the task prefix to every touched line", () => {
    const state = stateWithSelection("one\ntwo", 0, 7);

    const result = state.update(toggleTaskList(state));

    expect(result.state.doc.toString()).toBe("- [ ] one\n- [ ] two");
  });

  it("removes the task prefix when the first touched line already has one", () => {
    const state = stateWithSelection("- [ ] one\n- [x] two", 0, 19);

    const result = state.update(toggleTaskList(state));

    expect(result.state.doc.toString()).toBe("one\ntwo");
  });
});

describe("toggleBlockquote", () => {
  it("adds the blockquote prefix to every touched line", () => {
    const state = stateWithSelection("one\ntwo", 0, 7);

    const result = state.update(toggleBlockquote(state));

    expect(result.state.doc.toString()).toBe("> one\n> two");
  });

  it("removes the blockquote prefix when the first touched line already has one", () => {
    const state = stateWithSelection("> one\ntwo", 0, 9);

    const result = state.update(toggleBlockquote(state));

    expect(result.state.doc.toString()).toBe("one\ntwo");
  });
});

describe("insertLink", () => {
  it("uses the selection as the label and places the cursor on the url placeholder", () => {
    const state = stateWithSelection("see docs here", 4, 8);

    const result = state.update(insertLink(state));

    expect(result.state.doc.toString()).toBe("see [docs](url) here");
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe("url");
  });

  it("inserts an empty label placeholder when there is no selection", () => {
    const state = stateWithSelection("", 0);

    const result = state.update(insertLink(state));

    expect(result.state.doc.toString()).toBe("[label](url)");
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe("url");
  });
});

describe("insertImage", () => {
  it("uses the selection as the alt text and places the cursor on the url placeholder", () => {
    const state = stateWithSelection("see logo here", 4, 8);

    const result = state.update(insertImage(state));

    expect(result.state.doc.toString()).toBe("see ![logo](url) here");
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe("url");
  });
});

describe("insertHorizontalRule", () => {
  it("adds a leading newline when the current line is not empty", () => {
    const state = stateWithSelection("some text", 9);

    const result = state.update(insertHorizontalRule(state));

    expect(result.state.doc.toString()).toBe("some text\n---");
  });

  it("does not add a blank line when the current line is already empty", () => {
    const state = stateWithSelection("some text\n", 10);

    const result = state.update(insertHorizontalRule(state));

    expect(result.state.doc.toString()).toBe("some text\n---");
  });
});

describe("insertTable", () => {
  it("inserts the table template on a new line", () => {
    const state = stateWithSelection("intro", 5);

    const result = state.update(insertTable(state));

    expect(result.state.doc.toString()).toBe(
      "intro\n| Header | Header |\n| --- | --- |\n| Cell | Cell |",
    );
  });
});

describe("insertCodeBlock", () => {
  it("inserts a fenced code block template with the cursor inside", () => {
    const state = stateWithSelection("intro", 5);

    const result = state.update(insertCodeBlock(state));

    expect(result.state.doc.toString()).toBe("intro\n```\n\n```");
    expect(result.state.selection.main.from).toBe("intro\n```\n".length);
  });
});

describe("insertNoteLink", () => {
  it("inserts a note link using the note's title when there is no selection", () => {
    const state = stateWithSelection("see ", 4);

    const result = state.update(insertNoteLink(state, "Architecture", "01ARCH"));

    expect(result.state.doc.toString()).toBe("see [Architecture](note:01ARCH)");
  });

  it("leaves the cursor after the inserted link, with no placeholder selected", () => {
    const state = stateWithSelection("", 0);

    const result = state.update(insertNoteLink(state, "Architecture", "01ARCH"));

    const inserted = "[Architecture](note:01ARCH)";
    expect(result.state.selection.main.empty).toBe(true);
    expect(result.state.selection.main.from).toBe(inserted.length);
  });

  it("uses the selection as the label, keeping the authored text", () => {
    const state = stateWithSelection("see the design doc", 4, 18);

    const result = state.update(insertNoteLink(state, "Architecture", "01ARCH"));

    expect(result.state.doc.toString()).toBe("see [the design doc](note:01ARCH)");
  });
});
