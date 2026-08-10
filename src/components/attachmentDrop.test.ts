import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAttachmentDrop, isWithinRect } from "./attachmentDrop";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function makeView(doc: string, cursor: number): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor } }),
  });
}

function makeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("isWithinRect", () => {
  it("is true for a point inside the rect", () => {
    expect(isWithinRect({ x: 10, y: 10 }, makeRect())).toBe(true);
  });

  it("is false for a point outside the rect", () => {
    expect(isWithinRect({ x: 900, y: 10 }, makeRect())).toBe(false);
  });

  it("treats the rect's edges as inside", () => {
    expect(isWithinRect({ x: 0, y: 0 }, makeRect())).toBe(true);
    expect(isWithinRect({ x: 800, y: 600 }, makeRect())).toBe(true);
  });
});

describe("handleAttachmentDrop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op for a position outside the editor pane's bounds (e.g. over the tree)", () => {
    const view = makeView("", 0);
    const treeRect = makeRect({ left: 0, right: 200, top: 0, bottom: 600 });
    // The editor pane sits to the right of the tree; a position inside the
    // tree's own bounds must not trigger any import.
    const editorRect = makeRect({ left: 200, right: 800, top: 0, bottom: 600 });

    const handled = handleAttachmentDrop(
      ["/home/user/photo.png"],
      { x: 50, y: 50 },
      view,
      editorRect,
      "01ROOT",
    );

    expect(handled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    void treeRect;
  });

  it("imports and inserts a single dropped file at the drop position, not the text cursor", async () => {
    invoke.mockResolvedValue("attachment:01ABC");
    const view = makeView("Hello world", 0);
    view.dispatch({ selection: { anchor: 11 } }); // cursor at the end
    const editorRect = makeRect();
    vi.spyOn(view, "posAtCoords").mockReturnValue(5); // drop lands mid-document

    const handled = handleAttachmentDrop(["/home/user/photo.png"], { x: 42, y: 7 }, view, editorRect, "01ROOT");

    expect(handled).toBe(true);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("import_attachment", {
        rootId: "01ROOT",
        absolutePath: "/home/user/photo.png",
      }),
    );
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("Hello![photo.png](attachment:01ABC) world"),
    );
  });

  it("imports and inserts multiple dropped files in sequence, each after the previous one's insert", async () => {
    invoke.mockResolvedValueOnce("attachment:01AAA").mockResolvedValueOnce("attachment:01BBB");
    const view = makeView("", 0);
    const editorRect = makeRect();
    vi.spyOn(view, "posAtCoords").mockReturnValue(0);

    const handled = handleAttachmentDrop(
      ["/home/user/first.png", "/home/user/second.png"],
      { x: 10, y: 10 },
      view,
      editorRect,
      "01ROOT",
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenNthCalledWith(1, "import_attachment", {
      rootId: "01ROOT",
      absolutePath: "/home/user/first.png",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "import_attachment", {
      rootId: "01ROOT",
      absolutePath: "/home/user/second.png",
    });
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe(
        "![first.png](attachment:01AAA)![second.png](attachment:01BBB)",
      ),
    );
  });

  it("rejects a non-image path per-file, naming it, without blocking the other valid files in the same drop", async () => {
    invoke
      .mockResolvedValueOnce("attachment:01GOOD1")
      .mockRejectedValueOnce("file content is not a recognized image format")
      .mockResolvedValueOnce("attachment:01GOOD2");
    const view = makeView("", 0);
    const editorRect = makeRect();
    vi.spyOn(view, "posAtCoords").mockReturnValue(0);
    const onImportError = vi.fn();

    const handled = handleAttachmentDrop(
      ["/home/user/good1.png", "/home/user/notes.md", "/home/user/good2.png"],
      { x: 10, y: 10 },
      view,
      editorRect,
      "01ROOT",
      { onImportError },
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe(
        "![good1.png](attachment:01GOOD1)![good2.png](attachment:01GOOD2)",
      ),
    );
    await vi.waitFor(() =>
      expect(onImportError).toHaveBeenCalledWith(
        expect.stringContaining("notes.md"),
      ),
    );
  });
});
