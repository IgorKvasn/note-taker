import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMMAND_PICK_FOLDER,
  COMMAND_SAVE_CONFIG,
  COMMAND_VALIDATE_ROOT_PATH,
  type Config,
  type RootConfig,
  type RootDraft,
  type RootValidation,
} from "../ipc";
import "./RootsEditor.css";

interface RootRow {
  /** Client-local identity for React keys and edits; never sent to the backend. */
  key: string;
  /** The persisted root ID, absent for a root added in this session. */
  id: string | null;
  path: string;
  autoSync: boolean;
  remoteUrl: string;
  exists: boolean;
  createIfMissing: boolean;
}

interface RootsEditorProps {
  initialRoots: RootConfig[];
  canCancel: boolean;
  onSaved: (config: Config) => void;
  onCancel?: () => void;
}

function makeRowKey(): string {
  return crypto.randomUUID();
}

function toRow(root: RootConfig, exists: boolean): RootRow {
  return {
    key: makeRowKey(),
    id: root.id,
    path: root.path,
    autoSync: root.auto_sync,
    remoteUrl: root.remote_url,
    exists,
    createIfMissing: false,
  };
}

function findDuplicatePaths(rows: RootRow[]): Set<string> {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.path === "") {
      continue;
    }
    seen.set(row.path, (seen.get(row.path) ?? 0) + 1);
  }

  const duplicates = new Set<string>();
  for (const [path, count] of seen) {
    if (count > 1) {
      duplicates.add(path);
    }
  }
  return duplicates;
}

export function RootsEditor({ initialRoots, canCancel, onSaved, onCancel }: RootsEditorProps) {
  const [rows, setRows] = useState<RootRow[]>(() => initialRoots.map((root) => toRow(root, true)));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const duplicatePaths = findDuplicatePaths(rows);
  const canSave = rows.length > 0 && !isSaving && duplicatePaths.size === 0;

  async function handleAdd() {
    const path = await invoke<string | null>(COMMAND_PICK_FOLDER);
    if (path === null) {
      return;
    }

    const validation = await invoke<RootValidation>(COMMAND_VALIDATE_ROOT_PATH, { path });

    setRows((current) => [
      ...current,
      {
        key: makeRowKey(),
        id: null,
        path,
        autoSync: false,
        remoteUrl: validation.remote_url ?? "",
        exists: validation.exists,
        createIfMissing: false,
      },
    ]);
  }

  async function handleChangePath(key: string) {
    const path = await invoke<string | null>(COMMAND_PICK_FOLDER);
    if (path === null) {
      return;
    }

    const validation = await invoke<RootValidation>(COMMAND_VALIDATE_ROOT_PATH, { path });

    updateRow(key, {
      path,
      remoteUrl: validation.remote_url ?? "",
      exists: validation.exists,
      createIfMissing: false,
    });
  }

  function handleRemove(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  function updateRow(key: string, changes: Partial<RootRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  }

  async function handleSave() {
    setIsSaving(true);
    setSaveError(null);

    const drafts: RootDraft[] = rows.map((row) => ({
      id: row.id,
      path: row.path,
      auto_sync: row.autoSync,
      remote_url: row.remoteUrl,
      create_if_missing: row.createIfMissing,
    }));

    try {
      const config = await invoke<Config>(COMMAND_SAVE_CONFIG, { drafts });
      onSaved(config);
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="roots-editor" data-testid="roots-editor">
      <ul className="roots-editor__list">
        {rows.map((row) => (
          <li className="roots-editor__row" key={row.key}>
            <div className="roots-editor__row-main">
              <span className="roots-editor__path" title={row.path}>
                {row.path}
              </span>
              <button
                className="roots-editor__change-path"
                type="button"
                onClick={() => handleChangePath(row.key)}
                aria-label={`Change ${row.path}`}
              >
                Change…
              </button>
              {!row.exists && (
                <label className="roots-editor__create-missing">
                  <input
                    type="checkbox"
                    checked={row.createIfMissing}
                    onChange={(event) =>
                      updateRow(row.key, { createIfMissing: event.target.checked })
                    }
                  />
                  Create this folder
                </label>
              )}
              <button
                className="roots-editor__remove"
                type="button"
                onClick={() => handleRemove(row.key)}
                aria-label={`Remove ${row.path}`}
              >
                Remove
              </button>
            </div>

            <div className="roots-editor__row-fields">
              <label className="roots-editor__field">
                Remote URL
                <input
                  type="text"
                  value={row.remoteUrl}
                  placeholder="git@example.com:user/notes.git"
                  onChange={(event) => updateRow(row.key, { remoteUrl: event.target.value })}
                />
              </label>
              <label className="roots-editor__field roots-editor__field--checkbox">
                <input
                  type="checkbox"
                  checked={row.autoSync}
                  onChange={(event) => updateRow(row.key, { autoSync: event.target.checked })}
                />
                Auto sync
              </label>
            </div>

            {duplicatePaths.has(row.path) && (
              <p className="roots-editor__error" role="alert">
                This path is already in the list.
              </p>
            )}
          </li>
        ))}
      </ul>

      <button className="roots-editor__add" type="button" onClick={handleAdd}>
        Add root…
      </button>

      {saveError !== null && (
        <p className="roots-editor__error" role="alert">
          {saveError}
        </p>
      )}

      <div className="roots-editor__actions">
        {canCancel && (
          <button type="button" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
        )}
        <button
          className="roots-editor__save"
          type="button"
          onClick={handleSave}
          disabled={!canSave}
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
