/**
 * Names shared with the Rust side. These must stay in step with the constants
 * defined across `src-tauri/src/` (`lib.rs`, `sync.rs`, `search.rs`); there is
 * no generated binding to enforce it.
 */
export const EVENT_MENU_ABOUT = "menu://about";
export const EVENT_MENU_SETTINGS = "menu://settings";
export const COMMAND_GET_APP_VERSION = "get_app_version";
export const COMMAND_GET_CONFIG = "get_config";
export const COMMAND_VALIDATE_ROOT_PATH = "validate_root_path";
export const COMMAND_PICK_FOLDER = "pick_folder";
export const COMMAND_SAVE_CONFIG = "save_config";
export const COMMAND_SHOW_CONFIG_ERROR = "show_config_error";
export const COMMAND_LIST_TREE = "list_tree";
export const COMMAND_OPEN_NOTE = "open_note";
export const COMMAND_SAVE_NOTE = "save_note";
export const COMMAND_CREATE_NOTE = "create_note";
export const COMMAND_CREATE_FOLDER = "create_folder";
export const COMMAND_DELETE_ITEM = "delete_item";
export const COMMAND_MOVE_ITEM = "move_item";
export const COMMAND_SEARCH_NOTES = "search_notes";
export const COMMAND_SCAN_LINKS = "scan_links";
export const COMMAND_GET_STATE = "get_state";
export const COMMAND_SAVE_STATE = "save_state";
export const COMMAND_SYNC_ROOT = "sync_root";
export const COMMAND_GET_ROOT_STATUS = "get_root_status";
export const COMMAND_MARK_RESOLVED = "mark_resolved";
export const COMMAND_CHECK_FOR_UPDATE = "check_for_update";

/** Emitted by the backend git sync chain (spec §7); one-way, never invoked. */
export const EVENT_SYNC_STATUS = "sync-status";

/** Mirrors `RootConfig` in `src-tauri/src/config.rs`. */
export interface RootConfig {
  id: string;
  path: string;
  auto_sync: boolean;
  remote_url: string;
}

/** Mirrors `Config` in `src-tauri/src/config.rs`. */
export interface Config {
  version: number;
  roots: RootConfig[];
}

/**
 * Mirrors `ConfigOutcome` in `src-tauri/src/config.rs`, serialized as an
 * externally-tagged enum via `#[serde(tag = "type", rename_all = "lowercase")]`.
 */
export type ConfigOutcome =
  | { type: "missing" }
  | { type: "invalid"; error: string }
  | { type: "ok"; config: Config };

/** Mirrors `RootValidation` in `src-tauri/src/config.rs`. */
export interface RootValidation {
  exists: boolean;
  is_writable: boolean;
  is_git_repo: boolean;
  has_remote: boolean;
  remote_url: string | null;
}

/** Mirrors `RootDraft` in `src-tauri/src/config.rs`. */
export interface RootDraft {
  id: string | null;
  path: string;
  auto_sync: boolean;
  remote_url: string;
  create_if_missing: boolean;
}

/** Mirrors `TreeNode` in `src-tauri/src/tree.rs`. */
export interface TreeNode {
  name: string;
  path: string;
  is_directory: boolean;
  children: TreeNode[];
}

/** Mirrors `OpenNoteResult` in `src-tauri/src/notes.rs`. */
export interface OpenNoteResult {
  content: string;
  id: string;
  is_conflicted: boolean;
}

/** Mirrors `MatchRange` in `src-tauri/src/search.rs`. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Mirrors `SearchResult` in `src-tauri/src/search.rs`. */
export interface SearchResult {
  root_id: string;
  path: string;
  directory_path: string;
  title: string;
  match_count: number;
  snippet: string;
  snippet_matches: MatchRange[];
  first_match_offset: number | null;
  seq: number;
}

/** Mirrors `LinkedNote` in `src-tauri/src/links.rs`. */
export interface LinkedNote {
  id: string;
  path: string;
  directory_path: string;
  title: string;
}

/**
 * Mirrors `ScanLinksResult` in `src-tauri/src/links.rs`. `backlinks` maps a
 * target note's ULID to the paths linking to it; consumed by `useNoteLinks`'
 * `getBacklinks` for the "Linked from" section (issue #50).
 */
export interface ScanLinksResult {
  notes: LinkedNote[];
  backlinks: Record<string, string[]>;
}

/** Mirrors `LastOpenNote` in `src-tauri/src/state.rs`. */
export interface LastOpenNote {
  root_id: string;
  path: string;
}

/** Mirrors `EditorMode` in `src-tauri/src/state.rs`. */
export type EditorMode = "edit" | "view";

/** Mirrors `UiState` in `src-tauri/src/state.rs`. */
export interface UiState {
  split_ratio: number;
  last_open_note: LastOpenNote | null;
  expanded_paths: Record<string, string[]>;
  has_dismissed_local_only_notice: boolean;
  editor_mode: EditorMode;
}

/**
 * Mirrors `SyncState` in `src-tauri/src/sync.rs`, serialized as an
 * externally-tagged enum via `#[serde(tag = "state", rename_all = "snake_case")]`.
 */
export type SyncState =
  | { state: "syncing" }
  | { state: "synced" }
  | { state: "local_only" }
  | { state: "conflict" }
  | { state: "error"; stderr: string };

/** Mirrors `SyncStatusEvent` in `src-tauri/src/sync.rs`, the payload of `sync-status`. */
export interface SyncStatusEvent {
  root_id: string;
  state: SyncState;
}

/** Mirrors `RootStatus` in `src-tauri/src/sync.rs`, returned by `get_root_status`. */
export interface RootStatus {
  conflicted_paths: string[];
  sync_state: SyncState;
}

/** Mirrors `ReleaseInfo` in `src-tauri/src/update.rs`, returned by `check_for_update`. */
export interface ReleaseInfo {
  version: string;
  notes: string;
  url: string;
}
