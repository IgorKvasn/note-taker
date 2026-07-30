import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import type { RootConfig, SearchResult, TreeNode } from "../ipc";

/** Minimal `DataTransfer` stand-in -- jsdom doesn't implement the native one,
 * so drag-and-drop tests round-trip payloads through this instead. */
class FakeDataTransfer {
  private store = new Map<string, string>();
  dropEffect = "none";
  effectAllowed = "none";
  setData(format: string, data: string) {
    this.store.set(format, data);
  }
  getData(format: string) {
    return this.store.get(format) ?? "";
  }
}

function dragAndDrop(source: Element, target: Element) {
  const dataTransfer = new FakeDataTransfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const ROOT_A: RootConfig = { id: "01ROOT-A", path: "/home/user/notes", auto_sync: false, remote_url: "" };
const ROOT_B: RootConfig = { id: "01ROOT-B", path: "/home/user/work-notes", auto_sync: false, remote_url: "" };

function folder(name: string, path: string, children: TreeNode[] = []): TreeNode {
  return { name, path, is_directory: true, children };
}

function note(name: string, path: string): TreeNode {
  return { name, path, is_directory: false, children: [] };
}

function mockTrees(trees: Record<string, TreeNode[] | Error>, searchResults: SearchResult[] = []) {
  invoke.mockImplementation((command: string, args?: { rootId: string }) => {
    if (command === "get_root_status") {
      return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
    }
    if (command === "search_notes") return Promise.resolve(searchResults);
    if (command !== "list_tree") return Promise.resolve(undefined);
    const result = trees[args!.rootId];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result ?? []);
  });
}

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    root_id: ROOT_A.id,
    path: "match.md",
    directory_path: "",
    title: "match",
    match_count: 1,
    snippet: "has a match here",
    snippet_matches: [{ start: 6, end: 11 }],
    first_match_offset: 6,
    seq: 0,
    ...overrides,
  };
}

const noop = () => {};

describe("NotesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
  });

  it("renders one section per root, in config order, labeled by folder name", async () => {
    mockTrees({ [ROOT_A.id]: [], [ROOT_B.id]: [] });
    render(<NotesPanel roots={[ROOT_A, ROOT_B]} onOpenNote={noop} />);

    const headers = await screen.findAllByRole("button", { expanded: true });
    // Each header's text also carries its RootSyncIndicator label (e.g. "Local
    // only"), so this checks the folder-name prefix rather than an exact match.
    const labels = headers.map((header) => header.textContent);
    const notesIndex = labels.findIndex((label) => label?.startsWith("notes"));
    const workNotesIndex = labels.findIndex((label) => label?.startsWith("work-notes"));

    expect(notesIndex).toBeGreaterThanOrEqual(0);
    expect(workNotesIndex).toBeGreaterThanOrEqual(0);
    expect(notesIndex).toBeLessThan(workNotesIndex);
  });

  it("never displays the root id anywhere", async () => {
    mockTrees({ [ROOT_A.id]: [] });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    await screen.findByText("notes");

    expect(screen.queryByText(ROOT_A.id)).toBeNull();
  });

  it("renders the tree in the order the backend returns (folders before notes, alphabetical)", async () => {
    // list_tree already returns nodes pre-sorted (verified in src-tauri/src/tree.rs);
    // the frontend renders that order as-is rather than re-sorting.
    mockTrees({
      [ROOT_A.id]: [
        folder("apple-folder", "apple-folder"),
        folder("cherry-folder", "cherry-folder"),
        note("banana.md", "banana.md"),
        note("zebra.md", "zebra.md"),
      ],
    });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    await screen.findByText("notes");
    const items = await screen.findAllByRole("button", { name: /folder|\.md/ });
    const names = items.map((item) => item.textContent);

    expect(names).toEqual(["apple-folder", "cherry-folder", "banana.md", "zebra.md"]);
  });

  it("does not show non-.md files", async () => {
    mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    await screen.findByText("note.md");
    expect(screen.queryByText("image.png")).toBeNull();
  });

  it("toggles a folder's expand/collapse state and selects it on click", async () => {
    mockTrees({
      [ROOT_A.id]: [folder("my-folder", "my-folder", [note("child.md", "my-folder/child.md")])],
    });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    const folderButton = await screen.findByRole("button", { name: "my-folder" });
    expect(folderButton).toHaveProperty("ariaExpanded", "false");
    expect(screen.queryByText("child.md")).toBeNull();

    await userEvent.click(folderButton);

    expect(await screen.findByText("child.md")).toBeDefined();
    expect(folderButton.getAttribute("aria-expanded")).toBe("true");
    expect(folderButton.getAttribute("data-selected")).toBe("true");

    await userEvent.click(folderButton);

    expect(screen.queryByText("child.md")).toBeNull();
  });

  it("restores expanded folders per root from expandedPathsByRoot on mount", async () => {
    mockTrees({
      [ROOT_A.id]: [folder("my-folder", "my-folder", [note("child.md", "my-folder/child.md")])],
    });
    render(
      <NotesPanel
        roots={[ROOT_A]}
        onOpenNote={noop}
        expandedPathsByRoot={{ [ROOT_A.id]: ["my-folder"] }}
      />,
    );

    const folderButton = await screen.findByRole("button", { name: "my-folder" });
    expect(folderButton.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("child.md")).toBeDefined();
  });

  it("reports expanded-path changes per root via onExpandedPathsChange", async () => {
    mockTrees({
      [ROOT_A.id]: [folder("my-folder", "my-folder")],
    });
    const onExpandedPathsChange = vi.fn();
    render(
      <NotesPanel roots={[ROOT_A]} onOpenNote={noop} onExpandedPathsChange={onExpandedPathsChange} />,
    );

    const folderButton = await screen.findByRole("button", { name: "my-folder" });
    await userEvent.click(folderButton);

    expect(onExpandedPathsChange).toHaveBeenCalledWith(ROOT_A.id, ["my-folder"]);

    await userEvent.click(folderButton);

    expect(onExpandedPathsChange).toHaveBeenCalledWith(ROOT_A.id, []);
  });

  it("does not crash when a root is missing or unreadable", async () => {
    mockTrees({ [ROOT_A.id]: new Error("No such file or directory (os error 2)") });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText(/No such file or directory/)).toBeDefined();
  });

  it("re-calls list_tree on manual refresh, replacing the tree", async () => {
    let call = 0;
    invoke.mockImplementation((command: string) => {
      if (command !== "list_tree") return Promise.resolve(undefined);
      call += 1;
      return Promise.resolve(call === 1 ? [note("first.md", "first.md")] : [note("second.md", "second.md")]);
    });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    await screen.findByText("first.md");

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("second.md")).toBeDefined();
    expect(screen.queryByText("first.md")).toBeNull();
  });

  it("re-calls list_tree when the window regains focus", async () => {
    mockTrees({ [ROOT_A.id]: [] });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_tree", { rootId: ROOT_A.id }));
    invoke.mockClear();

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_tree", { rootId: ROOT_A.id }));
  });

  it("calls onOpenNote with the root and path when a note is clicked", async () => {
    mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
    const onOpenNote = vi.fn();
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={onOpenNote} />);

    await userEvent.click(await screen.findByRole("button", { name: "note.md" }));

    expect(onOpenNote).toHaveBeenCalledWith(ROOT_A.id, "note.md");
  });

  it("highlights the clicked note as selected", async () => {
    mockTrees({ [ROOT_A.id]: [note("first.md", "first.md"), note("second.md", "second.md")] });
    render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

    const first = await screen.findByRole("button", { name: "first.md" });
    const second = await screen.findByRole("button", { name: "second.md" });

    await userEvent.click(first);
    expect(first.getAttribute("data-selected")).toBe("true");
    expect(second.getAttribute("data-selected")).toBeNull();

    await userEvent.click(second);
    expect(first.getAttribute("data-selected")).toBeNull();
    expect(second.getAttribute("data-selected")).toBe("true");
  });

  describe("create via context menu", () => {
    it("shows New note / New folder on right-clicking empty space in a root's section", async () => {
      mockTrees({ [ROOT_A.id]: [] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });

      expect(await screen.findByRole("menuitem", { name: "New note" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "New folder" })).toBeDefined();
    });

    it("creates a top-level pending item when right-clicking empty space", async () => {
      mockTrees({ [ROOT_A.id]: [] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New note" }));

      expect(await screen.findByRole("textbox", { name: "New note title" })).toBeDefined();
    });

    it("right-clicking a folder creates the pending item inside it and auto-expands", async () => {
      mockTrees({
        [ROOT_A.id]: [folder("my-folder", "my-folder")],
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const folderButton = await screen.findByRole("button", { name: "my-folder" });
      expect(folderButton.getAttribute("aria-expanded")).toBe("false");

      await userEvent.pointer({ keys: "[MouseRight]", target: folderButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));

      expect(await screen.findByRole("textbox", { name: "New folder title" })).toBeDefined();
      expect(folderButton.getAttribute("aria-expanded")).toBe("true");
    });

    it("right-clicking a note creates the pending item as a sibling in its parent directory", async () => {
      mockTrees({
        [ROOT_A.id]: [folder("my-folder", "my-folder", [note("child.md", "my-folder/child.md")])],
      });
      render(
        <NotesPanel roots={[ROOT_A]} onOpenNote={noop} expandedPathsByRoot={{ [ROOT_A.id]: ["my-folder"] }} />,
      );

      const noteButton = await screen.findByRole("button", { name: "child.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New note" }));

      const field = await screen.findByRole("textbox", { name: "New note title" });
      // The pending field renders inside my-folder's list, alongside child.md.
      expect(field.closest("ul")?.contains(await screen.findByText("child.md"))).toBe(true);
    });

    it("Enter confirms creation, calls create_note, and refreshes the tree", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(listCall === 1 ? [] : [note("new-note.md", "new-note.md")]);
        }
        if (command === "create_note") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New note" }));

      const field = await screen.findByRole("textbox", { name: "New note title" });
      await userEvent.type(field, "new-note{Enter}");

      expect(await screen.findByText("new-note.md")).toBeDefined();
      expect(invoke).toHaveBeenCalledWith("create_note", { rootId: ROOT_A.id, path: "new-note.md" });
      expect(screen.queryByRole("textbox", { name: "New note title" })).toBeNull();
    });

    it("shows an inline error on a duplicate title and keeps the field open", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([note("existing.md", "existing.md")]);
        if (command === "create_note") return Promise.reject(new Error("\"existing.md\" already exists in this folder"));
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New note" }));

      const field = await screen.findByRole("textbox", { name: "New note title" });
      await userEvent.type(field, "existing{Enter}");

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/already exists/);
      expect(await screen.findByRole("textbox", { name: "New note title" })).toBeDefined();
    });

    it("Escape discards the pending item without calling the backend", async () => {
      mockTrees({ [ROOT_A.id]: [] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });
      await userEvent.click(await screen.findByRole("menuitem", { name: "New note" }));

      const field = await screen.findByRole("textbox", { name: "New note title" });
      await userEvent.type(field, "abandoned{Escape}");

      expect(screen.queryByRole("textbox", { name: "New note title" })).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("create_note", expect.anything());
    });
  });

  describe("delete via context menu", () => {
    it("does not show Delete on right-clicking empty space", async () => {
      mockTrees({ [ROOT_A.id]: [] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });

      await screen.findByRole("menuitem", { name: "New note" });
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    });

    it("shows a confirmation dialog before deleting a note, and does nothing on cancel", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const noteButton = await screen.findByRole("button", { name: "note.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toMatch(/note\.md/);

      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("delete_item", expect.anything());
      expect(await screen.findByText("note.md")).toBeDefined();
    });

    it("confirming deletes a note, calls delete_item, and refreshes the tree", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(listCall === 1 ? [note("note.md", "note.md")] : []);
        }
        if (command === "delete_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const noteButton = await screen.findByRole("button", { name: "note.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(invoke).toHaveBeenCalledWith("delete_item", { rootId: ROOT_A.id, path: "note.md" });
      await waitFor(() => expect(screen.queryByText("note.md")).toBeNull());
    });

    it("states recursive note and subfolder counts in a folder's confirmation dialog", async () => {
      mockTrees({
        [ROOT_A.id]: [
          folder("my-folder", "my-folder", [
            note("a.md", "my-folder/a.md"),
            folder("nested", "my-folder/nested", [note("b.md", "my-folder/nested/b.md")]),
          ]),
        ],
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const folderButton = await screen.findByRole("button", { name: "my-folder" });
      await userEvent.pointer({ keys: "[MouseRight]", target: folderButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toMatch(/2 notes/);
      expect(dialog.textContent).toMatch(/1 subfolder/);
    });

    it("confirming deletes a folder and its whole subtree via one delete_item call", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(listCall === 1 ? [folder("my-folder", "my-folder", [note("a.md", "my-folder/a.md")])] : []);
        }
        if (command === "delete_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const folderButton = await screen.findByRole("button", { name: "my-folder" });
      await userEvent.pointer({ keys: "[MouseRight]", target: folderButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(invoke).toHaveBeenCalledWith("delete_item", { rootId: ROOT_A.id, path: "my-folder" });
      await waitFor(() => expect(screen.queryByText("my-folder")).toBeNull());
    });

    it("clears the open note when the currently open note is deleted", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(listCall === 1 ? [note("open.md", "open.md")] : []);
        }
        if (command === "delete_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      const onNoteDeleted = vi.fn();
      render(
        <NotesPanel
          roots={[ROOT_A]}
          onOpenNote={noop}
          openNote={{ rootId: ROOT_A.id, path: "open.md" }}
          onNoteDeleted={onNoteDeleted}
        />,
      );

      const noteButton = await screen.findByRole("button", { name: "open.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(onNoteDeleted).toHaveBeenCalled());
    });

    it("clears the open note when its ancestor folder is deleted", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(
            listCall === 1 ? [folder("my-folder", "my-folder", [note("child.md", "my-folder/child.md")])] : [],
          );
        }
        if (command === "delete_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      const onNoteDeleted = vi.fn();
      render(
        <NotesPanel
          roots={[ROOT_A]}
          onOpenNote={noop}
          openNote={{ rootId: ROOT_A.id, path: "my-folder/child.md" }}
          onNoteDeleted={onNoteDeleted}
        />,
      );

      const folderButton = await screen.findByRole("button", { name: "my-folder" });
      await userEvent.pointer({ keys: "[MouseRight]", target: folderButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(onNoteDeleted).toHaveBeenCalled());
    });

    it("does not clear the open note when an unrelated note is deleted", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(
            listCall === 1 ? [note("open.md", "open.md"), note("other.md", "other.md")] : [note("open.md", "open.md")],
          );
        }
        if (command === "delete_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      const onNoteDeleted = vi.fn();
      render(
        <NotesPanel
          roots={[ROOT_A]}
          onOpenNote={noop}
          openNote={{ rootId: ROOT_A.id, path: "open.md" }}
          onNoteDeleted={onNoteDeleted}
        />,
      );

      const noteButton = await screen.findByRole("button", { name: "other.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByText("other.md")).toBeNull());
      expect(onNoteDeleted).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("does not search or swap the panel below 2 characters", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);
      await screen.findByText("note.md");

      await userEvent.type(screen.getByPlaceholderText("Search notes"), "a");

      expect(invoke).not.toHaveBeenCalledWith("search_notes", expect.anything());
      expect(screen.getByText("note.md")).toBeDefined();
    });

    it("swaps the tree for results after the debounce once 2+ characters are typed", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] }, [searchResult()]);
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);
      await screen.findByText("note.md");

      await userEvent.type(screen.getByPlaceholderText("Search notes"), "ab");

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_notes", { query: "ab", seq: expect.any(Number) }));
      expect(await screen.findByTestId("search-results")).toBeDefined();
      const treeItem = screen.getByText("note.md");
      expect(treeItem.closest("[hidden]")).not.toBeNull();
    });

    it("shows the no-matches empty state when search returns nothing", async () => {
      mockTrees({ [ROOT_A.id]: [] }, []);
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);
      await screen.findByText("notes");

      await userEvent.type(screen.getByPlaceholderText("Search notes"), "xyz");

      expect(await screen.findByTestId("search-results-empty")).toBeDefined();
    });

    it("Escape clears the query and restores the tree", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] }, [searchResult()]);
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);
      await screen.findByText("note.md");

      const input = screen.getByPlaceholderText("Search notes");
      await userEvent.type(input, "ab");
      await screen.findByTestId("search-results");

      await userEvent.type(input, "{Escape}");

      expect(screen.queryByTestId("search-results")).toBeNull();
      expect(await screen.findByText("note.md")).toBeDefined();
      expect(input).toHaveProperty("value", "");
    });

    it("clearing the query restores the tree with expand state intact", async () => {
      mockTrees(
        { [ROOT_A.id]: [folder("my-folder", "my-folder", [note("child.md", "my-folder/child.md")])] },
        [searchResult()],
      );
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const folderButton = await screen.findByRole("button", { name: "my-folder" });
      await userEvent.click(folderButton);
      expect(await screen.findByText("child.md")).toBeDefined();

      const input = screen.getByPlaceholderText("Search notes");
      await userEvent.type(input, "ab");
      await screen.findByTestId("search-results");

      await userEvent.clear(input);

      expect(screen.queryByTestId("search-results")).toBeNull();
      const restoredFolderButton = await screen.findByRole("button", { name: "my-folder" });
      expect(restoredFolderButton.getAttribute("aria-expanded")).toBe("true");
      expect(await screen.findByText("child.md")).toBeDefined();
    });

    it("clicking a result opens the note and leaves the search panel intact", async () => {
      const result = searchResult();
      mockTrees({ [ROOT_A.id]: [] }, [result]);
      const onOpenNote = vi.fn();
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={onOpenNote} />);
      await screen.findByText("notes");

      await userEvent.type(screen.getByPlaceholderText("Search notes"), "ab");
      await screen.findByTestId("search-results");

      await userEvent.click(screen.getByRole("button", { name: new RegExp(result.title) }));

      expect(onOpenNote).toHaveBeenCalledWith(result.root_id, result.path, result.first_match_offset);
      expect(await screen.findByTestId("search-results")).toBeDefined();
      expect(screen.getByPlaceholderText("Search notes")).toHaveProperty("value", "ab");
    });
  });

  describe("rename", () => {
    it("F2 opens the rename field on the selected note", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "note.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      expect(await screen.findByRole("textbox", { name: "Rename note" })).toHaveProperty("value", "note.md");
    });

    it("F2 opens the rename field on the selected folder", async () => {
      mockTrees({ [ROOT_A.id]: [folder("my-folder", "my-folder")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "my-folder" }));
      fireEvent.keyDown(document, { key: "F2" });

      expect(await screen.findByRole("textbox", { name: "Rename folder" })).toHaveProperty("value", "my-folder");
    });

    it("is reachable from the context menu and has no Move to... item", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const noteButton = await screen.findByRole("button", { name: "note.md" });
      await userEvent.pointer({ keys: "[MouseRight]", target: noteButton });

      expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: /move to/i })).toBeNull();

      await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

      expect(await screen.findByRole("textbox", { name: "Rename note" })).toHaveProperty("value", "note.md");
    });

    it("right-clicking empty space offers no Rename item", async () => {
      mockTrees({ [ROOT_A.id]: [] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const section = (await screen.findByText("notes")).closest("section")!;
      const body = section.querySelector(".notes-panel__section-body")!;
      await userEvent.pointer({ keys: "[MouseRight]", target: body });

      expect(await screen.findByRole("menuitem", { name: "New note" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });

    it("Enter confirms a rename, calls move_item, and refreshes the tree", async () => {
      let listCall = 0;
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          listCall += 1;
          return Promise.resolve(listCall === 1 ? [note("old.md", "old.md")] : [note("new.md", "new.md")]);
        }
        if (command === "move_item") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "old.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      const field = await screen.findByRole("textbox", { name: "Rename note" });
      await userEvent.clear(field);
      await userEvent.type(field, "new{Enter}");

      expect(await screen.findByText("new.md")).toBeDefined();
      expect(invoke).toHaveBeenCalledWith("move_item", {
        rootId: ROOT_A.id,
        fromPath: "old.md",
        toPath: "new.md",
      });
    });

    it("shows an inline error when the rename target already exists in the destination", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([note("existing.md", "existing.md"), note("old.md", "old.md")]);
        if (command === "move_item") return Promise.reject(new Error("\"existing.md\" already exists in this folder"));
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "old.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      const field = await screen.findByRole("textbox", { name: "Rename note" });
      await userEvent.clear(field);
      await userEvent.type(field, "existing{Enter}");

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/already exists/);
      expect(await screen.findByRole("textbox", { name: "Rename note" })).toBeDefined();
    });

    it("rejects an invalid character in a rename with an inline error", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([note("old.md", "old.md")]);
        if (command === "move_item") return Promise.reject(new Error("title contains an invalid character: ':'"));
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "old.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      const field = await screen.findByRole("textbox", { name: "Rename note" });
      await userEvent.clear(field);
      await userEvent.type(field, "bad:name{Enter}");

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/invalid character/);
    });

    it("Escape discards the rename without calling the backend", async () => {
      mockTrees({ [ROOT_A.id]: [note("note.md", "note.md")] });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await userEvent.click(await screen.findByRole("button", { name: "note.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      const field = await screen.findByRole("textbox", { name: "Rename note" });
      await userEvent.type(field, "abandoned{Escape}");

      expect(screen.queryByRole("textbox", { name: "Rename note" })).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("move_item", expect.anything());
    });

    it("calls onNotePathChanged when the renamed item is the open note", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([note("old.md", "old.md")]);
        if (command === "move_item") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      const onNotePathChanged = vi.fn();
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} onNotePathChanged={onNotePathChanged} />);

      await userEvent.click(await screen.findByRole("button", { name: "old.md" }));
      fireEvent.keyDown(document, { key: "F2" });

      const field = await screen.findByRole("textbox", { name: "Rename note" });
      await userEvent.clear(field);
      await userEvent.type(field, "new{Enter}");

      await waitFor(() =>
        expect(onNotePathChanged).toHaveBeenCalledWith(ROOT_A.id, "old.md", "new.md"),
      );
    });
  });

  describe("drag and drop move", () => {
    it("moves a note into a different folder via drag-and-drop", async () => {
      mockTrees({
        [ROOT_A.id]: [folder("target", "target"), note("note.md", "note.md")],
      });
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([folder("target", "target"), note("note.md", "note.md")]);
        if (command === "move_item") return Promise.resolve(undefined);
        if (command === "get_root_status") {
          return Promise.resolve({ conflicted_paths: [], sync_state: { state: "local_only" } });
        }
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const noteButton = await screen.findByRole("button", { name: "note.md" });
      const targetFolder = await screen.findByRole("button", { name: "target" });

      dragAndDrop(noteButton, targetFolder);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("move_item", {
          rootId: ROOT_A.id,
          fromPath: "note.md",
          toPath: "target/note.md",
        }),
      );
    });

    it("moves a folder with its subtree via drag-and-drop", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") {
          return Promise.resolve([
            folder("source", "source", [note("child.md", "source/child.md")]),
            folder("target", "target"),
          ]);
        }
        if (command === "move_item") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      const sourceFolder = await screen.findByRole("button", { name: "source" });
      const targetFolder = await screen.findByRole("button", { name: "target" });

      dragAndDrop(sourceFolder, targetFolder);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("move_item", {
          rootId: ROOT_A.id,
          fromPath: "source",
          toPath: "target/source",
        }),
      );
    });

    it("rejects dragging a folder into its own descendant without calling move_item", async () => {
      mockTrees({
        [ROOT_A.id]: [folder("parent", "parent", [folder("child", "parent/child")])],
      });
      render(
        <NotesPanel roots={[ROOT_A]} onOpenNote={noop} expandedPathsByRoot={{ [ROOT_A.id]: ["parent"] }} />,
      );

      const parentFolder = await screen.findByRole("button", { name: "parent" });
      const childFolder = await screen.findByRole("button", { name: "child" });

      dragAndDrop(parentFolder, childFolder);

      expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/own subfolders|itself/));
      expect(invoke).not.toHaveBeenCalledWith("move_item", expect.anything());
    });

    it("calls onNotePathChanged when the open note is moved via drag-and-drop", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "list_tree") return Promise.resolve([folder("target", "target"), note("note.md", "note.md")]);
        if (command === "move_item") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      const onNotePathChanged = vi.fn();
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} onNotePathChanged={onNotePathChanged} />);

      const noteButton = await screen.findByRole("button", { name: "note.md" });
      const targetFolder = await screen.findByRole("button", { name: "target" });

      dragAndDrop(noteButton, targetFolder);

      await waitFor(() =>
        expect(onNotePathChanged).toHaveBeenCalledWith(ROOT_A.id, "note.md", "target/note.md"),
      );
    });
  });

  describe("conflict toast", () => {
    function mockRootStatuses(statusesByRoot: Record<string, { conflicted_paths: string[] }>) {
      invoke.mockImplementation((command: string, args?: { rootId: string }) => {
        if (command === "get_root_status") {
          const status = statusesByRoot[args!.rootId] ?? { conflicted_paths: [] };
          return Promise.resolve({ conflicted_paths: status.conflicted_paths, sync_state: { state: "local_only" } });
        }
        if (command === "list_tree") return Promise.resolve([]);
        return Promise.resolve(undefined);
      });
    }

    it("shows a one-time toast naming the affected root when it has conflicts", async () => {
      mockRootStatuses({ [ROOT_A.id]: { conflicted_paths: ["a.md"] } });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      expect(await screen.findByText(/need conflict resolution/)).not.toBeNull();
    });

    it("shows no toast for a root with no conflicts", async () => {
      mockRootStatuses({ [ROOT_A.id]: { conflicted_paths: [] } });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await screen.findByTestId("notes-panel");
      expect(screen.queryByText(/need conflict resolution/)).toBeNull();
    });

    it("dismissing the toast hides it", async () => {
      mockRootStatuses({ [ROOT_A.id]: { conflicted_paths: ["a.md"] } });
      render(<NotesPanel roots={[ROOT_A]} onOpenNote={noop} />);

      await screen.findByText(/need conflict resolution/);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Got it" }));

      expect(screen.queryByText(/need conflict resolution/)).toBeNull();
    });

    it("shows one toast per affected root when multiple roots have conflicts", async () => {
      mockRootStatuses({
        [ROOT_A.id]: { conflicted_paths: ["a.md"] },
        [ROOT_B.id]: { conflicted_paths: ["b.md"] },
      });
      render(<NotesPanel roots={[ROOT_A, ROOT_B]} onOpenNote={noop} />);

      await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(2));
    });
  });
});
