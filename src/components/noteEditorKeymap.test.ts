import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { noteEditorKeymap } from "./noteEditorKeymap";

function bindingFor(key: string) {
  const binding = noteEditorKeymap.find((entry) => entry.key === key);
  if (binding?.run === undefined) {
    throw new Error(`no binding found for ${key}`);
  }
  return binding.run;
}

function viewWithSelection(doc: string, from: number, to: number = from): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }) });
}

describe("noteEditorKeymap", () => {
  it("Mod-b toggles bold", () => {
    const view = viewWithSelection("hello", 0, 5);

    bindingFor("Mod-b")(view);

    expect(view.state.doc.toString()).toBe("**hello**");
    view.destroy();
  });

  it("Mod-i toggles italic", () => {
    const view = viewWithSelection("hello", 0, 5);

    bindingFor("Mod-i")(view);

    expect(view.state.doc.toString()).toBe("_hello_");
    view.destroy();
  });

  it("Mod-Shift-x toggles strikethrough", () => {
    const view = viewWithSelection("hello", 0, 5);

    bindingFor("Mod-Shift-x")(view);

    expect(view.state.doc.toString()).toBe("~~hello~~");
    view.destroy();
  });

  it("Mod-e toggles inline code", () => {
    const view = viewWithSelection("hello", 0, 5);

    bindingFor("Mod-e")(view);

    expect(view.state.doc.toString()).toBe("`hello`");
    view.destroy();
  });

  it("Mod-k inserts a link", () => {
    const view = viewWithSelection("hello", 0, 5);

    bindingFor("Mod-k")(view);

    expect(view.state.doc.toString()).toBe("[hello](url)");
    view.destroy();
  });

  it("Mod-Alt-1/2/3 toggle heading levels", () => {
    const view = viewWithSelection("hello", 0);

    bindingFor("Mod-Alt-2")(view);

    expect(view.state.doc.toString()).toBe("## hello");
    view.destroy();
  });

  it("Mod-Shift-8 toggles a bullet list", () => {
    const view = viewWithSelection("hello", 0);

    bindingFor("Mod-Shift-8")(view);

    expect(view.state.doc.toString()).toBe("- hello");
    view.destroy();
  });

  it("Mod-Shift-7 toggles an ordered list", () => {
    const view = viewWithSelection("hello", 0);

    bindingFor("Mod-Shift-7")(view);

    expect(view.state.doc.toString()).toBe("1. hello");
    view.destroy();
  });

  it("Mod-Shift-. toggles a blockquote", () => {
    const view = viewWithSelection("hello", 0);

    bindingFor("Mod-Shift-.")(view);

    expect(view.state.doc.toString()).toBe("> hello");
    view.destroy();
  });

  it("every binding's run function returns true, claiming the keypress", () => {
    const view = viewWithSelection("hello", 0, 5);

    for (const binding of noteEditorKeymap) {
      expect(binding.run?.(view)).toBe(true);
    }
    view.destroy();
  });
});
