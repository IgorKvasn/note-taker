import { describe, expect, it } from "vitest";
import type { TreeNode } from "../ipc";
import { countContents } from "./countContents";

function folder(name: string, path: string, children: TreeNode[] = []): TreeNode {
  return { name, path, is_directory: true, children };
}

function note(name: string, path: string): TreeNode {
  return { name, path, is_directory: false, children: [] };
}

describe("countContents", () => {
  it("counts zero notes and folders for an empty folder", () => {
    const empty = folder("empty", "empty");

    expect(countContents(empty)).toEqual({ noteCount: 0, folderCount: 0 });
  });

  it("counts direct note children", () => {
    const node = folder("parent", "parent", [note("a.md", "parent/a.md"), note("b.md", "parent/b.md")]);

    expect(countContents(node)).toEqual({ noteCount: 2, folderCount: 0 });
  });

  it("counts direct subfolders", () => {
    const node = folder("parent", "parent", [folder("child-a", "parent/child-a"), folder("child-b", "parent/child-b")]);

    expect(countContents(node)).toEqual({ noteCount: 0, folderCount: 2 });
  });

  it("counts notes and folders recursively across nested levels", () => {
    const node = folder("parent", "parent", [
      note("top.md", "parent/top.md"),
      folder("child", "parent/child", [
        note("nested.md", "parent/child/nested.md"),
        folder("grandchild", "parent/child/grandchild", [note("deep.md", "parent/child/grandchild/deep.md")]),
      ]),
    ]);

    expect(countContents(node)).toEqual({ noteCount: 3, folderCount: 2 });
  });
});
