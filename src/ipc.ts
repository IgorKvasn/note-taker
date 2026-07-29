/**
 * Names shared with the Rust side. These must stay in step with the constants in
 * `src-tauri/src/lib.rs`; there is no generated binding to enforce it.
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
