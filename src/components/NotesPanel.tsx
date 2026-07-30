import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMMAND_CREATE_FOLDER,
  COMMAND_CREATE_NOTE,
  COMMAND_LIST_TREE,
  type RootConfig,
  type TreeNode,
} from "../ipc";
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

/** What kind of new item a context-menu selection is about to create. */
type CreateKind = "note" | "folder";

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

/** Right-click target: a directory to create into, resolved from whatever was clicked. */
interface ContextMenuState {
  x: number;
  y: number;
  rootId: string;
  dirPath: string;
}

interface InlineCreateFieldProps {
  kind: CreateKind;
  onConfirm: (title: string) => Promise<void>;
  onCancel: () => void;
  depth: number;
}

function InlineCreateField({ kind, onConfirm, onCancel, depth }: InlineCreateFieldProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (isSubmitting) return;

      setIsSubmitting(true);
      try {
        await onConfirm(value);
        // On success the caller replaces this field with the real tree node;
        // on failure it stays mounted, so only clear the error path here.
        setError(null);
      } catch (submitError) {
        setError(String(submitError));
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <li>
      <div className="notes-panel__inline-create" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
        <input
          ref={inputRef}
          type="text"
          className="notes-panel__inline-input"
          aria-label={kind === "note" ? "New note title" : "New folder title"}
          value={value}
          disabled={isSubmitting}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {error !== null && (
        <p className="notes-panel__inline-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  rootId: string;
  expandedPaths: Set<string>;
  selection: Selection | null;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, dirPath: string) => void;
  pendingCreate: PendingCreate | null;
  onConfirmCreate: (title: string) => Promise<void>;
  onCancelCreate: () => void;
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
  depth,
}: TreeNodeViewProps) {
  if (!node.is_directory) {
    return (
      <li>
        <button
          type="button"
          className="notes-panel__item notes-panel__item--note"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
          onClick={() => onOpenNote(node.path)}
          onContextMenu={(event) => onContextMenu(event, parentDirPath(node.path))}
        >
          {node.name}
        </button>
      </li>
    );
  }

  const isExpanded = expandedPaths.has(node.path);
  const pendingHere = pendingCreate !== null && pendingCreate.rootId === rootId && pendingCreate.dirPath === node.path;

  return (
    <li>
      <button
        type="button"
        className="notes-panel__item notes-panel__item--folder"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-selected={isSameSelection(selection, { rootId, path: node.path }) || undefined}
        aria-expanded={isExpanded}
        onClick={() => onToggleFolder(node.path)}
        onContextMenu={(event) => onContextMenu(event, node.path)}
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
  onContextMenu: (event: React.MouseEvent, rootId: string, dirPath: string) => void;
  pendingCreate: PendingCreate | null;
  onConfirmCreate: (rootId: string, title: string) => Promise<void>;
  onCancelCreate: () => void;
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

  const pendingAtTopLevel = pendingCreate !== null && pendingCreate.rootId === root.id && pendingCreate.dirPath === "";

  return (
    <section
      className="notes-panel__section"
      onContextMenu={(event) => {
        // Only empty space within the section (not a descendant item/button)
        // targets the root's top level -- item-level handlers already stopped
        // propagation for their own targets.
        if (event.target === event.currentTarget) {
          onContextMenu(event, root.id, "");
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
      </button>

      {isExpanded && (
        <div
          className="notes-panel__section-body"
          onContextMenu={(event) => {
            if (event.target === event.currentTarget) {
              onContextMenu(event, root.id, "");
            }
          }}
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
                  onContextMenu={(event, dirPath) => onContextMenu(event, root.id, dirPath)}
                  pendingCreate={pendingCreate}
                  onConfirmCreate={(title) => onConfirmCreate(root.id, title)}
                  onCancelCreate={onCancelCreate}
                  depth={0}
                />
              ))}
              {pendingAtTopLevel && (
                <InlineCreateField
                  kind={pendingCreate.kind}
                  onConfirm={(title) => onConfirmCreate(root.id, title)}
                  onCancel={onCancelCreate}
                  depth={0}
                />
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onCreateNote: () => void;
  onCreateFolder: () => void;
}

function ContextMenu({ state, onClose, onCreateNote, onCreateFolder }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="notes-panel__context-menu"
      role="menu"
      style={{ top: state.y, left: state.x }}
    >
      <button type="button" role="menuitem" onClick={onCreateNote}>
        New note
      </button>
      <button type="button" role="menuitem" onClick={onCreateFolder}>
        New folder
      </button>
    </div>
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
}: NotesPanelProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  const handleContextMenu = useCallback((event: React.MouseEvent, rootId: string, dirPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, rootId, dirPath });
  }, []);

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
          onContextMenu={handleContextMenu}
          pendingCreate={pendingCreate}
          onConfirmCreate={confirmCreate}
          onCancelCreate={cancelCreate}
        />
      ))}
      {contextMenu !== null && (
        <ContextMenu
          state={contextMenu}
          onClose={closeContextMenu}
          onCreateNote={() => startCreate("note")}
          onCreateFolder={() => startCreate("folder")}
        />
      )}
    </div>
  );
}
