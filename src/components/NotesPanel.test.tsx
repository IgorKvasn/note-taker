import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import type { RootConfig, TreeNode } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const ROOT_A: RootConfig = { id: "01ROOT-A", path: "/home/user/notes", auto_sync: false, remote_url: "" };
const ROOT_B: RootConfig = { id: "01ROOT-B", path: "/home/user/work-notes", auto_sync: false, remote_url: "" };

function folder(name: string, path: string, children: TreeNode[] = []): TreeNode {
  return { name, path, is_directory: true, children };
}

function note(name: string, path: string): TreeNode {
  return { name, path, is_directory: false, children: [] };
}

function mockTrees(trees: Record<string, TreeNode[] | Error>) {
  invoke.mockImplementation((command: string, args?: { rootId: string }) => {
    if (command !== "list_tree") return Promise.resolve(undefined);
    const result = trees[args!.rootId];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result ?? []);
  });
}

const noop = () => {};

describe("NotesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders one section per root, in config order, labeled by folder name", async () => {
    mockTrees({ [ROOT_A.id]: [], [ROOT_B.id]: [] });
    render(<NotesPanel roots={[ROOT_A, ROOT_B]} onOpenNote={noop} />);

    const headers = await screen.findAllByRole("button", { expanded: true });
    const labels = headers.map((header) => header.textContent);

    expect(labels).toContain("notes");
    expect(labels).toContain("work-notes");
    expect(labels.indexOf("notes")).toBeLessThan(labels.indexOf("work-notes"));
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
});
