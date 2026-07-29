import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMAND_LIST_TREE, type RootConfig, type TreeNode } from "../ipc";
import "./NotesPanel.css";

interface NotesPanelProps {
  roots: RootConfig[];
}

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
  depth: number;
}

function TreeNodeView({ node, rootId, expandedPaths, selection, onToggleFolder, depth }: TreeNodeViewProps) {
  if (!node.is_directory) {
    return (
      <li>
        <button
          type="button"
          className="notes-panel__item notes-panel__item--note"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
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
  refreshToken: number;
}

function RootSection({ root, selection, onSelect, refreshToken }: RootSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

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
        return next;
      });
      onSelect({ rootId: root.id, path });
    },
    [onSelect, root.id],
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

export function NotesPanel({ roots }: NotesPanelProps) {
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
          refreshToken={refreshToken}
        />
      ))}
    </div>
  );
}
