import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMMAND_CREATE_FOLDER,
  COMMAND_CREATE_NOTE,
  COMMAND_DELETE_ITEM,
  COMMAND_LIST_TREE,
  COMMAND_MOVE_ITEM,
  type RootConfig,
  type SearchResult,
  type TreeNode,
} from "../ipc";
import { useSearch } from "../hooks/useSearch";
import { isDescendantPath } from "../paths";
import { countContents } from "./countContents";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { InlineCreateField, type CreateKind } from "./InlineCreateField";
import { RootSyncIndicator } from "./RootSyncIndicator";
import { SearchResultsList } from "./SearchResultsList";
import { TreeContextMenu, type ContextMenuState } from "./TreeContextMenu";
import "./NotesPanel.css";

interface NotesPanelProps {
  roots: RootConfig[];
  /**
   * `scrollToOffset` is set only when opening from a search result click, to
   * scroll the editor to the first match (spec §8); a tree click omits it.
   */
  onOpenNote: (rootId: string, path: string, scrollToOffset?: number) => void;
  /** Persisted expanded folder paths, keyed by root ID. */
  expandedPathsByRoot?: Record<string, string[]>;
  onExpandedPathsChange?: (rootId: string, expandedPaths: string[]) => void;
  /** The note currently shown in the right pane, so a delete that removes it (or an ancestor folder) can clear it. */
  openNote?: { rootId: string; path: string } | null;
  onNoteDeleted?: () => void;
  /**
   * Called after a successful rename/move whose `fromPath` is the currently
   * open note or one of its ancestor folders, with the note's new path -- so
   * the caller can keep it open and correctly addressed for the next save.
   */
  onNotePathChanged?: (rootId: string, fromPath: string, toPath: string) => void;
}

const NO_EXPANDED_PATHS: Record<string, string[]> = {};
const noopExpandedPathsChange = () => {};
const noopNoteDeleted = () => {};
const noopNotePathChanged = () => {};

interface Selection {
  rootId: string;
  path: string;
  isDirectory: boolean;
}

function rootLabel(root: RootConfig): string {
  const normalized = root.path.replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : root.path;
}

function isSameSelection(a: Selection | null, b: Pick<Selection, "rootId" | "path">): boolean {
  return a !== null && a.rootId === b.rootId && a.path === b.path;
}

/**
 * Where a pending (not-yet-created) item goes: `dirPath` is the directory it
 * will be created in (`""` for a root's top level), scoped to one root so two
 * roots never show the same pending row.
 */
interface PendingCreate {
  rootId: string;
  dirPath: string;
  kind: CreateKind;
}

/** The item awaiting delete confirmation, carrying the `TreeNode` so a folder's recursive counts can be computed. */
interface PendingDelete {
  rootId: string;
  node: TreeNode;
}

/** The single node currently being renamed in place, scoped to one root. */
interface PendingRename {
  rootId: string;
  path: string;
  isDirectory: boolean;
}

interface TreeNodeViewProps {
  node: TreeNode;
  rootId: string;
  expandedPaths: Set<string>;
  selection: Selection | null;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, dirPath: string, clickedItem: TreeNode) => void;
  pendingCreate: PendingCreate | null;
  onConfirmCreate: (title: string) => Promise<void>;
  onCancelCreate: () => void;
  pendingRename: PendingRename | null;
  onConfirmRename: (title: string) => Promise<void>;
  onCancelRename: () => void;
  onDropItem: (fromPath: string, fromIsDirectory: boolean, toDirPath: string) => void;
  depth: number;
}

function TreeNodeView({
  node,
  rootId,
  expandedPaths,
  selection,
  onToggleFolder,
  onOpenNote,
  onContextMenu,
  pendingCreate,
  onConfirmCreate,
  onCancelCreate,
  pendingRename,
  onConfirmRename,
  onCancelRename,
  onDropItem,
  depth,
}: TreeNodeViewProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isRenamingThis = pendingRename !== null && pendingRename.rootId === rootId && pendingRename.path === node.path;

  const handleDragStart = (event: React.DragEvent) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-note-taker-item",
      JSON.stringify({ rootId, path: node.path, isDirectory: node.is_directory }),
    );
  };

  const handleDragOver = (event: React.DragEvent) => {
    if (!node.is_directory) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (event: React.DragEvent) => {
    if (!node.is_directory) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const raw = event.dataTransfer.getData("application/x-note-taker-item");
    if (raw === "") return;
    const dragged = JSON.parse(raw) as { rootId: string; path: string; isDirectory: boolean };
    if (dragged.rootId !== rootId) return;
    onDropItem(dragged.path, dragged.isDirectory, node.path);
  };

  if (!node.is_directory) {
    if (isRenamingThis) {
      return (
        <InlineCreateField
          kind="note"
          initialValue={node.name}
          onConfirm={onConfirmRename}
          onCancel={onCancelRename}
          depth={depth}
        />
      );
    }

    return (
      <li>
        <button
          type="button"
          className="notes-panel__item notes-panel__item--note"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
          draggable
          onDragStart={handleDragStart}
          onClick={() => onOpenNote(node.path)}
          onContextMenu={(event) => onContextMenu(event, parentDirPath(node.path), node)}
        >
          {node.name}
        </button>
      </li>
    );
  }

  const isExpanded = expandedPaths.has(node.path);
  const pendingHere = pendingCreate !== null && pendingCreate.rootId === rootId && pendingCreate.dirPath === node.path;

  if (isRenamingThis) {
    return (
      <InlineCreateField
        kind="folder"
        initialValue={node.name}
        onConfirm={onConfirmRename}
        onCancel={onCancelRename}
        depth={depth}
      />
    );
  }

  return (
    <li>
      <button
        type="button"
        className="notes-panel__item notes-panel__item--folder"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
        data-drag-over={isDragOver || undefined}
        aria-expanded={isExpanded}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => onToggleFolder(node.path)}
        onContextMenu={(event) => onContextMenu(event, node.path, node)}
      >
        <span className="notes-panel__disclosure" data-expanded={isExpanded || undefined} aria-hidden="true" />
        {node.name}
      </button>
      {isExpanded && (node.children.length > 0 || pendingHere) && (
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
              onContextMenu={onContextMenu}
              pendingCreate={pendingCreate}
              onConfirmCreate={onConfirmCreate}
              onCancelCreate={onCancelCreate}
              pendingRename={pendingRename}
              onConfirmRename={onConfirmRename}
              onCancelRename={onCancelRename}
              onDropItem={onDropItem}
              depth={depth + 1}
            />
          ))}
          {pendingHere && (
            <InlineCreateField
              kind={pendingCreate.kind}
              onConfirm={onConfirmCreate}
              onCancel={onCancelCreate}
              depth={depth + 1}
            />
          )}
        </ul>
      )}
    </li>
  );
}

function parentDirPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

interface RootSectionProps {
  root: RootConfig;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onOpenNote: (rootId: string, path: string) => void;
  refreshToken: number;
  initialExpandedPaths: string[];
  onExpandedPathsChange: (rootId: string, expandedPaths: string[]) => void;
  onContextMenu: (event: React.MouseEvent, rootId: string, dirPath: string, clickedItem: TreeNode | null) => void;
  pendingCreate: PendingCreate | null;
  onConfirmCreate: (rootId: string, title: string) => Promise<void>;
  onCancelCreate: () => void;
  pendingRename: PendingRename | null;
  onConfirmRename: (rootId: string, title: string) => Promise<void>;
  onCancelRename: () => void;
  onDropItem: (rootId: string, fromPath: string, fromIsDirectory: boolean, toDirPath: string) => void;
  onConflictedPathsChange: (rootId: string, paths: string[]) => void;
}

function RootSection({
  root,
  selection,
  onSelect,
  onOpenNote,
  refreshToken,
  initialExpandedPaths,
  onExpandedPathsChange,
  onContextMenu,
  pendingCreate,
  onConfirmCreate,
  onCancelCreate,
  pendingRename,
  onConfirmRename,
  onCancelRename,
  onDropItem,
  onConflictedPathsChange,
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

  useEffect(() => {
    if (pendingCreate !== null && pendingCreate.rootId === root.id && pendingCreate.dirPath !== "") {
      setExpandedPaths((current) => {
        if (current.has(pendingCreate.dirPath)) return current;
        const next = new Set(current);
        next.add(pendingCreate.dirPath);
        onExpandedPathsChange(root.id, Array.from(next));
        return next;
      });
    }
    // Only re-run when a new pending create targets this root's directories --
    // expandedPaths/onExpandedPathsChange intentionally excluded to avoid
    // re-collapsing state on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreate, root.id]);

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
      onSelect({ rootId: root.id, path, isDirectory: true });
    },
    [onExpandedPathsChange, onSelect, root.id],
  );

  const openNote = useCallback(
    (path: string) => {
      onSelect({ rootId: root.id, path, isDirectory: false });
      onOpenNote(root.id, path);
    },
    [onOpenNote, onSelect, root.id],
  );

  const pendingAtTopLevel = pendingCreate !== null && pendingCreate.rootId === root.id && pendingCreate.dirPath === "";
  const pendingRenameHere = pendingRename !== null && pendingRename.rootId === root.id ? pendingRename : null;

  const handleTopLevelDrop = (event: React.DragEvent) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/x-note-taker-item");
    if (raw === "") return;
    const dragged = JSON.parse(raw) as { rootId: string; path: string; isDirectory: boolean };
    if (dragged.rootId !== root.id) return;
    onDropItem(root.id, dragged.path, dragged.isDirectory, "");
  };

  return (
    <section
      className="notes-panel__section"
      onContextMenu={(event) => {
        // Only empty space within the section (not a descendant item/button)
        // targets the root's top level -- item-level handlers already stopped
        // propagation for their own targets.
        if (event.target === event.currentTarget) {
          onContextMenu(event, root.id, "", null);
        }
      }}
    >
      <button
        type="button"
        className="notes-panel__section-header"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className="notes-panel__disclosure" data-expanded={isExpanded || undefined} aria-hidden="true" />
        {rootLabel(root)}
        <RootSyncIndicator
          rootId={root.id}
          onSyncSettled={loadTree}
          onConflictedPathsChange={(paths) => onConflictedPathsChange(root.id, paths)}
        />
      </button>

      {isExpanded && (
        <div
          className="notes-panel__section-body"
          onContextMenu={(event) => {
            if (event.target === event.currentTarget) {
              onContextMenu(event, root.id, "", null);
            }
          }}
          onDragOver={(event) => {
            if (event.target === event.currentTarget) event.preventDefault();
          }}
          onDrop={handleTopLevelDrop}
        >
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
                  onContextMenu={(event, dirPath, clickedItem) => onContextMenu(event, root.id, dirPath, clickedItem)}
                  pendingCreate={pendingCreate}
                  onConfirmCreate={(title) => onConfirmCreate(root.id, title)}
                  onCancelCreate={onCancelCreate}
                  pendingRename={pendingRenameHere}
                  onConfirmRename={(title) => onConfirmRename(root.id, title)}
                  onCancelRename={onCancelRename}
                  onDropItem={(fromPath, fromIsDirectory, toDirPath) =>
                    onDropItem(root.id, fromPath, fromIsDirectory, toDirPath)
                  }
                  depth={1}
                />
              ))}
              {pendingAtTopLevel && (
                <InlineCreateField
                  kind={pendingCreate.kind}
                  onConfirm={(title) => onConfirmCreate(root.id, title)}
                  onCancel={onCancelCreate}
                  depth={1}
                />
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function withMdExtension(title: string): string {
  return title.endsWith(".md") ? title : `${title}.md`;
}

function joinPath(dirPath: string, name: string): string {
  return dirPath === "" ? name : `${dirPath}/${name}`;
}

export function NotesPanel({
  roots,
  onOpenNote,
  expandedPathsByRoot = NO_EXPANDED_PATHS,
  onExpandedPathsChange = noopExpandedPathsChange,
  openNote = null,
  onNoteDeleted = noopNoteDeleted,
  onNotePathChanged = noopNotePathChanged,
}: NotesPanelProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const { query, results, setQuery, clear: clearSearch } = useSearch();
  const isSearchMode = results !== null;
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Root IDs a conflict toast has already fired for (issue #26: "a one-time
  // toast per affected root"). A ref, not state -- recording it must never
  // itself trigger a re-render. Cleared for a root once its conflicts clear,
  // so a later, separate conflict on the same root toasts again.
  const toastedRootIds = useRef<Set<string>>(new Set());
  const [toastRootIds, setToastRootIds] = useState<string[]>([]);

  const handleConflictedPathsChange = useCallback((rootId: string, paths: string[]) => {
    if (paths.length === 0) {
      toastedRootIds.current.delete(rootId);
      setToastRootIds((current) => current.filter((id) => id !== rootId));
      return;
    }
    if (toastedRootIds.current.has(rootId)) {
      return;
    }
    toastedRootIds.current.add(rootId);
    setToastRootIds((current) => [...current, rootId]);
  }, []);

  const dismissToast = useCallback((rootId: string) => {
    setToastRootIds((current) => current.filter((id) => id !== rootId));
  }, []);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  const handleEscapeKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        clearSearch();
      }
    },
    [clearSearch],
  );

  const handleClearSearch = useCallback(() => {
    clearSearch();
    searchInputRef.current?.focus();
  }, [clearSearch]);

  const selectSearchResult = useCallback(
    (result: SearchResult) => {
      onOpenNote(result.root_id, result.path, result.first_match_offset ?? undefined);
    },
    [onOpenNote],
  );

  // The full TreeNode behind the current context menu's clickedItem, kept
  // alongside `contextMenu` (rather than folded into ContextMenuState) since
  // delete confirmation needs a folder's children to compute recursive counts,
  // and ContextMenuState's shape stays the plain (path, isDirectory) pair other
  // consumers (TreeContextMenu) actually need.
  const [clickedNode, setClickedNode] = useState<{ rootId: string; node: TreeNode } | null>(null);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, rootId: string, dirPath: string, clickedItem: TreeNode | null) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        rootId,
        dirPath,
        clickedItem: clickedItem === null ? null : { path: clickedItem.path, isDirectory: clickedItem.is_directory },
      });
      setClickedNode(clickedItem === null ? null : { rootId, node: clickedItem });
    },
    [],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const startCreate = useCallback(
    (kind: CreateKind) => {
      if (contextMenu === null) return;
      setPendingCreate({ rootId: contextMenu.rootId, dirPath: contextMenu.dirPath, kind });
      setContextMenu(null);
    },
    [contextMenu],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const confirmCreate = useCallback(
    async (rootId: string, title: string) => {
      if (pendingCreate === null) return;

      const trimmedTitle = title.trim();
      if (trimmedTitle === "") {
        throw new Error("title cannot be empty");
      }

      const command = pendingCreate.kind === "note" ? COMMAND_CREATE_NOTE : COMMAND_CREATE_FOLDER;
      const name = pendingCreate.kind === "note" ? withMdExtension(trimmedTitle) : trimmedTitle;
      const path = joinPath(pendingCreate.dirPath, name);

      await invoke(command, { rootId, path });

      setPendingCreate(null);
      refresh();
    },
    [pendingCreate, refresh],
  );

  const startDelete = useCallback(() => {
    if (clickedNode === null) return;
    setPendingDelete({ rootId: clickedNode.rootId, node: clickedNode.node });
    setContextMenu(null);
  }, [clickedNode]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const deletionClearsOpenNote = useCallback(
    (rootId: string, deletedPath: string) => {
      if (openNote === null || openNote.rootId !== rootId) return false;
      return isDescendantPath(openNote.path, deletedPath);
    },
    [openNote],
  );

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;

    const { rootId, node } = pendingDelete;
    try {
      await invoke(COMMAND_DELETE_ITEM, { rootId, path: node.path });
    } catch (error) {
      setMoveError(String(error));
      return;
    }

    setPendingDelete(null);
    if (deletionClearsOpenNote(rootId, node.path)) {
      onNoteDeleted();
    }
    refresh();
  }, [pendingDelete, deletionClearsOpenNote, onNoteDeleted, refresh]);

  const startRenameFromTarget = useCallback((rootId: string, path: string, isDirectory: boolean) => {
    setPendingRename({ rootId, path, isDirectory });
  }, []);

  const startRenameFromContextMenu = useCallback(() => {
    if (contextMenu === null || contextMenu.clickedItem === null) return;
    startRenameFromTarget(contextMenu.rootId, contextMenu.clickedItem.path, contextMenu.clickedItem.isDirectory);
    setContextMenu(null);
  }, [contextMenu, startRenameFromTarget]);

  const startRenameFromSelection = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "F2" || selection === null) return;
      event.preventDefault();
      startRenameFromTarget(selection.rootId, selection.path, selection.isDirectory);
    },
    [selection, startRenameFromTarget],
  );

  useEffect(() => {
    document.addEventListener("keydown", startRenameFromSelection);
    return () => document.removeEventListener("keydown", startRenameFromSelection);
  }, [startRenameFromSelection]);

  const cancelRename = useCallback(() => setPendingRename(null), []);

  const confirmRename = useCallback(
    async (rootId: string, title: string) => {
      if (pendingRename === null) return;

      const trimmedTitle = title.trim();
      if (trimmedTitle === "") {
        throw new Error("title cannot be empty");
      }

      const name = pendingRename.isDirectory ? trimmedTitle : withMdExtension(trimmedTitle);
      const fromPath = pendingRename.path;
      const toPath = joinPath(parentDirPath(fromPath), name);

      await invoke(COMMAND_MOVE_ITEM, { rootId, fromPath, toPath });

      setPendingRename(null);
      onNotePathChanged(rootId, fromPath, toPath);
      refresh();
    },
    [pendingRename, refresh, onNotePathChanged],
  );

  // `fromIsDirectory` isn't needed by the move itself -- `git mv` treats files
  // and directories identically -- but is kept in the callback shape since the
  // drag payload naturally carries it.
  const dropItem = useCallback(
    async (rootId: string, fromPath: string, _fromIsDirectory: boolean, toDirPath: string) => {
      if (isDescendantPath(toDirPath, fromPath)) {
        setMoveError("cannot move a folder into itself or one of its own subfolders");
        return;
      }

      const name = fromPath.slice(fromPath.lastIndexOf("/") + 1);
      const toPath = joinPath(toDirPath, name);
      if (toPath === fromPath) return;

      try {
        await invoke(COMMAND_MOVE_ITEM, { rootId, fromPath, toPath });
        onNotePathChanged(rootId, fromPath, toPath);
        refresh();
      } catch (error) {
        setMoveError(String(error));
      }
    },
    [refresh, onNotePathChanged],
  );

  const handlePanelContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // Only true empty space -- a RootSection's own onContextMenu already
      // handles its own empty space and, via handleContextMenu, stops
      // propagation before it reaches here -- targets the first root's top
      // level, per issue #30's resolution of "which root should out-of-section
      // space target" when multiple roots exist.
      if (event.target !== event.currentTarget) return;
      if (roots.length === 0) return;
      handleContextMenu(event, roots[0].id, "", null);
    },
    [roots, handleContextMenu],
  );

  return (
    <div className="notes-panel" data-testid="notes-panel" onContextMenu={handlePanelContextMenu}>
      <div className="notes-panel__toolbar">
        <div className="notes-panel__search-wrapper">
          <input
            ref={searchInputRef}
            type="text"
            className="notes-panel__search-input"
            placeholder="Search notes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleEscapeKey}
          />
          {query !== "" && (
            <button
              type="button"
              className="notes-panel__search-clear"
              aria-label="Clear search"
              onClick={handleClearSearch}
            >
              ×
            </button>
          )}
        </div>
        <button type="button" className="notes-panel__refresh" onClick={refresh}>
          Refresh
        </button>
      </div>
      {isSearchMode && <SearchResultsList results={results} roots={roots} onSelect={selectSearchResult} />}
      {/* Kept mounted (just hidden) rather than swapped out entirely while searching,
          so each RootSection's expand/collapse state survives clearing the query. */}
      <div hidden={isSearchMode}>
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
            onContextMenu={handleContextMenu}
            pendingCreate={pendingCreate}
            onConfirmCreate={confirmCreate}
            onCancelCreate={cancelCreate}
            pendingRename={pendingRename}
            onConfirmRename={confirmRename}
            onCancelRename={cancelRename}
            onDropItem={dropItem}
            onConflictedPathsChange={handleConflictedPathsChange}
          />
        ))}
      </div>
      {toastRootIds.length > 0 && (
        <div className="notes-panel__conflict-toasts">
          {toastRootIds.map((rootId) => {
            const root = roots.find((candidate) => candidate.id === rootId);
            return (
              <div key={rootId} className="notes-panel__conflict-toast" role="status">
                <p>
                  {root === undefined ? "A root" : `"${rootLabel(root)}"`} has notes that need conflict resolution.
                </p>
                <button type="button" onClick={() => dismissToast(rootId)}>
                  Got it
                </button>
              </div>
            );
          })}
        </div>
      )}
      {moveError !== null && (
        <p className="notes-panel__error" role="alert">
          {moveError}
        </p>
      )}
      {contextMenu !== null && (
        <TreeContextMenu
          state={contextMenu}
          onClose={closeContextMenu}
          onCreateNote={() => startCreate("note")}
          onCreateFolder={() => startCreate("folder")}
          onRename={startRenameFromContextMenu}
          onDelete={startDelete}
        />
      )}
      {pendingDelete !== null && (
        <DeleteConfirmDialog
          itemName={pendingDelete.node.name}
          isDirectory={pendingDelete.node.is_directory}
          contents={pendingDelete.node.is_directory ? countContents(pendingDelete.node) : null}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}
