import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAttachmentPaste } from "./attachmentPaste";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** A real `EditorView` (not just `EditorState`) is needed here since
 * `handleAttachmentPaste` calls `view.dispatch`/`view.focus` -- jsdom
 * supports the minimal layout CodeMirror needs for that. */
function makeView(doc: string, cursor: number): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor } }),
  });
}

/** jsdom implements neither `ClipboardEvent` nor `DataTransfer` fully enough
 * for `.files`/`.getData` -- this fakes just the surface
 * `handleAttachmentPaste` reads, plus a spyable `preventDefault`. */
function makeClipboardEvent(options: { files?: File[]; uriList?: string } = {}): ClipboardEvent {
  const files = options.files ?? [];
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as unknown as FileList;

  return {
    preventDefault: vi.fn(),
    clipboardData: {
      files: fileList,
      getData: (format: string) => (format === "text/uri-list" ? options.uriList ?? "" : ""),
    },
  } as unknown as ClipboardEvent;
}

function pngFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

describe("handleAttachmentPaste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims a paste with image bytes, writes it, and inserts the resulting reference at the cursor", async () => {
    invoke.mockResolvedValue("attachment:01ABC");
    const view = makeView("Loaded", 6);
    const event = makeClipboardEvent({ files: [pngFile("photo.png")] });

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_attachment", {
        rootId: "01ROOT",
        bytes: [0x89, 0x50, 0x4e, 0x47],
        originalName: "photo.png",
      }),
    );
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Loaded![photo.png](attachment:01ABC)"));
    expect(view.state.selection.main.head).toBe("Loaded![photo.png](attachment:01ABC)".length);
  });

  it("names a pasted image with no filename using an empty originalName, matching the paste fallback contract", async () => {
    invoke.mockResolvedValue("attachment:01XYZ");
    const view = makeView("", 0);
    const unnamed = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "", { type: "image/png" });
    const event = makeClipboardEvent({ files: [unnamed] });

    handleAttachmentPaste(event, view, "01ROOT");

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "write_attachment",
        expect.objectContaining({ rootId: "01ROOT", originalName: null }),
      ),
    );
  });

  it("claims a paste with a file:// URI and calls import_attachment with the decoded absolute path", async () => {
    invoke.mockResolvedValue("attachment:01DEF");
    const view = makeView("Loaded", 6);
    const event = makeClipboardEvent({ uriList: "file:///home/user/My%20Photo.png" });

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("import_attachment", {
        rootId: "01ROOT",
        absolutePath: "/home/user/My Photo.png",
      }),
    );
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Loaded![My Photo.png](attachment:01DEF)"));
  });

  it("picks the file:// line out of a multi-line text/uri-list, ignoring comment lines", async () => {
    invoke.mockResolvedValue("attachment:01GHI");
    const view = makeView("", 0);
    const event = makeClipboardEvent({ uriList: "# a comment\nfile:///home/user/shot.png\n" });

    handleAttachmentPaste(event, view, "01ROOT");

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("import_attachment", {
        rootId: "01ROOT",
        absolutePath: "/home/user/shot.png",
      }),
    );
  });

  it("leaves the event unclaimed and calls no backend command for plain text or other non-image content", () => {
    const view = makeView("Loaded", 6);
    const event = makeClipboardEvent({ uriList: "just some plain text" });

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves the event unclaimed when clipboardData is entirely absent", () => {
    const view = makeView("Loaded", 6);
    const event = { preventDefault: vi.fn(), clipboardData: null } as unknown as ClipboardEvent;

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("prefers image bytes over a file:// URI when both are somehow present", async () => {
    invoke.mockResolvedValue("attachment:01WON");
    const view = makeView("", 0);
    const event = makeClipboardEvent({
      files: [pngFile("bytes.png")],
      uriList: "file:///home/user/other.png",
    });

    handleAttachmentPaste(event, view, "01ROOT");

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("write_attachment", expect.objectContaining({ originalName: "bytes.png" }));
  });

  it("surfaces the error via onImportError and inserts nothing when the backend call rejects", async () => {
    invoke.mockRejectedValue(new Error("not a recognized image format"));
    const view = makeView("Loaded", 6);
    const event = makeClipboardEvent({ files: [pngFile("photo.png")] });
    const onImportError = vi.fn();

    handleAttachmentPaste(event, view, "01ROOT", { onImportError });

    await vi.waitFor(() => expect(onImportError).toHaveBeenCalledWith("not a recognized image format"));
    expect(view.state.doc.toString()).toBe("Loaded");
  });
});
