import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_LIST_TREE, type RootConfig, type TreeNode } from "../ipc";
import "./NotesPanel.css";

interface NotesPanelProps {
  roots: RootConfig[];
  onOpenNote: (rootId: string, path: string) => void;
  /** Persisted expanded folder paths, keyed by root ID. */
  expandedPathsByRoot?: Record<string, string[]>;
  onExpandedPathsChange?: (rootId: string, expandedPaths: string[]) => void;
}

const NO_EXPANDED_PATHS: Record<string, string[]> = {};
const noopExpandedPathsChange = () => {};

interface Selection {
  rootId: string;
  path: string;
}

function rootLabel(root: RootConfig): string {
  const normalized = root.path.replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : root.path;
}

function isSameSelection(a: Selection | null, b: Selection): boolean {
  return a !== null && a.rootId === b.rootId && a.path === b.path;
}

interface TreeNodeViewProps {
  node: TreeNode;
  rootId: string;
  expandedPaths: Set<string>;
  selection: Selection | null;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  depth: number;
}

function TreeNodeView({ node, rootId, expandedPaths, selection, onToggleFolder, onOpenNote, depth }: TreeNodeViewProps) {
  if (!node.is_directory) {
    return (
      <li>
        <button
          type="button"
          className="notes-panel__item notes-panel__item--note"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
          onClick={() => onOpenNote(node.path)}
        >
          {node.name}
        </button>
      </li>
    );
  }

  const isExpanded = expandedPaths.has(node.path);

  return (
    <li>
      <button
        type="button"
        className="notes-panel__item notes-panel__item--folder"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
        aria-expanded={isExpanded}
        onClick={() => onToggleFolder(node.path)}
      >
        <span className="notes-panel__disclosure" data-expanded={isExpanded || undefined} aria-hidden="true" />
        {node.name}
      </button>
      {isExpanded && node.children.length > 0 && (
        <ul className="notes-panel__list">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              rootId={rootId}
              expandedPaths={expandedPaths}
              selection={selection}
              onToggleFolder={onToggleFolder}
              onOpenNote={onOpenNote}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface RootSectionProps {
  root: RootConfig;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onOpenNote: (rootId: string, path: string) => void;
  refreshToken: number;
  initialExpandedPaths: string[];
  onExpandedPathsChange: (rootId: string, expandedPaths: string[]) => void;
}

function RootSection({
  root,
  selection,
  onSelect,
  onOpenNote,
  refreshToken,
  initialExpandedPaths,
  onExpandedPathsChange,
}: RootSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Seeded once from persisted state; the effect below re-derives `initialExpandedPaths`
  // from props on every change instead, so this lazy initializer never re-reads it.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(initialExpandedPaths));

  const loadTree = useCallback(() => {
    invoke<TreeNode[]>(COMMAND_LIST_TREE, { rootId: root.id })
      .then((loadedTree) => {
        setTree(loadedTree);
        setError(null);
      })
      .catch((loadError) => {
        setTree(null);
        setError(String(loadError));
      });
  }, [root.id]);

  useEffect(() => {
    loadTree();
  }, [loadTree, refreshToken]);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        onExpandedPathsChange(root.id, Array.from(next));
        return next;
      });
      onSelect({ rootId: root.id, path });
    },
    [onExpandedPathsChange, onSelect, root.id],
  );

  const openNote = useCallback(
    (path: string) => {
      onSelect({ rootId: root.id, path });
      onOpenNote(root.id, path);
    },
    [onOpenNote, onSelect, root.id],
  );

  return (
    <section className="notes-panel__section">
      <button
        type="button"
        className="notes-panel__section-header"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className="notes-panel__disclosure" data-expanded={isExpanded || undefined} aria-hidden="true" />
        {rootLabel(root)}
      </button>

      {isExpanded && (
        <>
          {error !== null && (
            <p className="notes-panel__error" role="alert">
              Couldn't read this folder: {error}
            </p>
          )}
          {error === null && tree !== null && (
            <ul className="notes-panel__list">
              {tree.map((node) => (
                <TreeNodeView
                  key={node.path}
                  node={node}
                  rootId={root.id}
                  expandedPaths={expandedPaths}
                  selection={selection}
                  onToggleFolder={toggleFolder}
                  onOpenNote={openNote}
                  depth={0}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function NotesPanel({
  roots,
  onOpenNote,
  expandedPathsByRoot = NO_EXPANDED_PATHS,
  onExpandedPathsChange = noopExpandedPathsChange,
}: NotesPanelProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  return (
    <div className="notes-panel" data-testid="notes-panel">
      <div className="notes-panel__toolbar">
        <button type="button" className="notes-panel__refresh" onClick={refresh}>
          Refresh
        </button>
      </div>
      {roots.map((root) => (
        <RootSection
          key={root.id}
          root={root}
          selection={selection}
          onSelect={setSelection}
          onOpenNote={onOpenNote}
          refreshToken={refreshToken}
          initialExpandedPaths={expandedPathsByRoot[root.id] ?? []}
          onExpandedPathsChange={onExpandedPathsChange}
        />
      ))}
    </div>
  );
}
