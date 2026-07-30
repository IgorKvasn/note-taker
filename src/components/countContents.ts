import type { TreeNode } from "../ipc";

export interface ContentCounts {
  noteCount: number;
  folderCount: number;
}

/**
 * Recursively counts the notes and subfolders inside `node`, not counting
 * `node` itself -- what the folder-delete confirmation dialog needs (issue
 * #23) so a folder with 200 notes can't be mistaken for an empty one. Walks
 * the tree already loaded client-side rather than round-tripping to the
 * backend, since the tree is already in memory and a fresh backend call could
 * race with the delete that follows.
 */
export function countContents(node: TreeNode): ContentCounts {
  let noteCount = 0;
  let folderCount = 0;

  for (const child of node.children) {
    if (child.is_directory) {
      folderCount++;
      const childCounts = countContents(child);
      noteCount += childCounts.noteCount;
      folderCount += childCounts.folderCount;
    } else {
      noteCount++;
    }
  }

  return { noteCount, folderCount };
}
