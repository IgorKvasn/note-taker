import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { markdownLivePreview } from "./markdownLivePreview";

function createView(doc: string): EditorView {
  const host = document.createElement("div");
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), markdownLivePreview] }),
    parent: host,
  });
}

/** Collects the `class` of every `cm-live-preview-*` span rendered for `doc`, in document order. */
function livePreviewSpanClasses(doc: string): string[] {
  const view = createView(doc);
  try {
    return Array.from(view.dom.querySelectorAll("[class*='cm-live-preview-']")).map(
      (element) => element.className,
    );
  } finally {
    view.destroy();
  }
}

describe("markdownLivePreview", () => {
  it("styles bold content while keeping the ** markers visible and dimmed", () => {
    const view = createView("**hello**");
    try {
      const strong = view.dom.querySelector(".cm-live-preview-strong");
      expect(strong?.textContent).toBe("**hello**");
      const markers = strong?.querySelectorAll(".cm-live-preview-marker");
      expect(markers?.length).toBe(2);
      expect(Array.from(markers ?? []).map((m) => m.textContent)).toEqual(["**", "**"]);
    } finally {
      view.destroy();
    }
  });

  it("styles italic content wrapped in underscores", () => {
    const classes = livePreviewSpanClasses("_hello_");
    expect(classes.some((c) => c.includes("cm-live-preview-emphasis"))).toBe(true);
  });

  it("styles strikethrough content wrapped in tildes", () => {
    const classes = livePreviewSpanClasses("~~hello~~");
    expect(classes.some((c) => c.includes("cm-live-preview-strikethrough"))).toBe(true);
  });

  it("styles inline code spans", () => {
    const classes = livePreviewSpanClasses("`hello`");
    expect(classes.some((c) => c.includes("cm-live-preview-code"))).toBe(true);
  });

  it("styles ATX headings by level and dims the leading marker", () => {
    const view = createView("## Title");
    try {
      const heading = view.dom.querySelector(".cm-live-preview-heading-2");
      expect(heading?.textContent).toBe("## Title");
      expect(heading?.querySelector(".cm-live-preview-marker")?.textContent).toBe("##");
    } finally {
      view.destroy();
    }
  });

  it("styles blockquotes and dims the > marker", () => {
    const view = createView("> quoted");
    try {
      const quote = view.dom.querySelector(".cm-live-preview-blockquote");
      expect(quote?.textContent).toBe("> quoted");
      expect(quote?.querySelector(".cm-live-preview-marker")?.textContent).toBe(">");
    } finally {
      view.destroy();
    }
  });

  it("leaves plain text undecorated", () => {
    const classes = livePreviewSpanClasses("just plain text");
    expect(classes).toEqual([]);
  });

  it("re-decorates after an edit changes the document", () => {
    const view = createView("plain text");
    try {
      expect(view.dom.querySelector(".cm-live-preview-strong")).toBeNull();

      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "**bold now**" } });

      expect(view.dom.querySelector(".cm-live-preview-strong")?.textContent).toBe("**bold now**");
    } finally {
      view.destroy();
    }
  });
});
