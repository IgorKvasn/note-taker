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
 * `handleAttachmentPaste` reads, plus a spyable `preventDefault`.
 *
 * `text` models the plain-text payload a real paste carries independently of
 * `uriList`. Passing neither yields the entirely empty `DataTransfer` that
 * WebKitGTK delivers for an image paste under Wayland (issue #91) -- the shape
 * the earlier version of this fake could not express, which is why the bug
 * survived a green suite. */
function makeClipboardEvent(
  options: { files?: File[]; uriList?: string; text?: string; html?: string } = {},
): ClipboardEvent {
  const files = options.files ?? [];
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as unknown as FileList;

  const byFormat: Record<string, string> = {
    "text/uri-list": options.uriList ?? "",
    "text/plain": options.text ?? "",
    "text/html": options.html ?? "",
  };

  return {
    preventDefault: vi.fn(),
    clipboardData: {
      files: fileList,
      getData: (format: string) => byFormat[format] ?? "",
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
    const event = makeClipboardEvent({ text: "just some plain text" });

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves a non-file:// URI paste to CodeMirror as ordinary text", () => {
    const view = makeView("Loaded", 6);
    const event = makeClipboardEvent({ uriList: "https://example.com/page" });

    const claimed = handleAttachmentPaste(event, view, "01ROOT");

    expect(claimed).toBe(false);
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

  describe("empty DataTransfer -- the shape WebKitGTK delivers for an image paste on Wayland", () => {
    it("claims the paste, reads the image via the backend, and inserts the reference at the cursor", async () => {
      invoke.mockResolvedValue("attachment:01WAY");
      const view = makeView("Loaded", 6);
      const event = makeClipboardEvent();

      const claimed = handleAttachmentPaste(event, view, "01ROOT");

      expect(claimed).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();

      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("paste_clipboard_image", { rootId: "01ROOT" }));
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Loaded![pasted](attachment:01WAY)"));
      expect(view.state.selection.main.head).toBe("Loaded![pasted](attachment:01WAY)".length);
    });

    it("inserts the reference at the cursor position captured when the paste happened, not the current one", async () => {
      let resolveInvoke: (reference: string) => void = () => {};
      invoke.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveInvoke = resolve;
        }),
      );
      const view = makeView("Loaded", 3);
      const event = makeClipboardEvent();

      handleAttachmentPaste(event, view, "01ROOT");
      // The user moves the cursor while the backend read is still in flight.
      view.dispatch({ selection: { anchor: 6 } });
      resolveInvoke("attachment:01POS");

      await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Loa![pasted](attachment:01POS)ded"));
    });

    it("inserts nothing and reports no error when the clipboard holds no image", async () => {
      invoke.mockResolvedValue(null);
      const view = makeView("Loaded", 6);
      const event = makeClipboardEvent();
      const onImportError = vi.fn();

      const claimed = handleAttachmentPaste(event, view, "01ROOT", { onImportError });

      expect(claimed).toBe(true);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      expect(view.state.doc.toString()).toBe("Loaded");
      expect(onImportError).not.toHaveBeenCalled();
    });

    it("surfaces a clipboard-read failure via onImportError and inserts nothing", async () => {
      invoke.mockRejectedValue(new Error("could not PNG-encode the clipboard image"));
      const view = makeView("Loaded", 6);
      const event = makeClipboardEvent();
      const onImportError = vi.fn();

      handleAttachmentPaste(event, view, "01ROOT", { onImportError });

      await vi.waitFor(() => expect(onImportError).toHaveBeenCalledWith("could not PNG-encode the clipboard image"));
      expect(view.state.doc.toString()).toBe("Loaded");
    });

    it("leaves an HTML-only paste to CodeMirror rather than treating it as an empty clipboard", () => {
      const view = makeView("Loaded", 6);
      const event = makeClipboardEvent({ html: "<p>rich text</p>" });

      const claimed = handleAttachmentPaste(event, view, "01ROOT");

      expect(claimed).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("does not reach the backend fallback when the webview did populate image bytes", async () => {
      invoke.mockResolvedValue("attachment:01BYT");
      const view = makeView("", 0);
      const event = makeClipboardEvent({ files: [pngFile("photo.png")] });

      handleAttachmentPaste(event, view, "01ROOT");

      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      expect(invoke).not.toHaveBeenCalledWith("paste_clipboard_image", expect.anything());
    });
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
