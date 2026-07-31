use std::fs;
use std::path::PathBuf;

use directories::BaseDirs;
use serde::{Deserialize, Serialize};

/// Mirrors `DEFAULT_PANE_RATIO` in `src/components/splitRatio.ts`.
const DEFAULT_SPLIT_RATIO: f64 = 0.28;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LastOpenNote {
    pub root_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    #[default]
    Edit,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiState {
    #[serde(default = "default_split_ratio")]
    pub split_ratio: f64,
    #[serde(default)]
    pub last_open_note: Option<LastOpenNote>,
    /// Expanded folder paths per root, keyed by root ID rather than path so entries
    /// survive a root being moved on disk (config.toml only ever changes `path`).
    #[serde(default)]
    pub expanded_paths: std::collections::HashMap<String, Vec<String>>,
    /// Whether the one-time "sync is local-only" notice (spec §7) has been
    /// dismissed. Global rather than per-root: the notice explains the app's
    /// local-only mode in general, not any one root's remote configuration.
    #[serde(default)]
    pub has_dismissed_local_only_notice: bool,
    /// Global edit/preview mode (issue #37): a single app-wide setting rather than
    /// per-note state, so it carries over when switching notes and across restarts.
    #[serde(default)]
    pub editor_mode: EditorMode,
}

fn default_split_ratio() -> f64 {
    DEFAULT_SPLIT_RATIO
}

impl Default for UiState {
    fn default() -> Self {
        UiState {
            split_ratio: DEFAULT_SPLIT_RATIO,
            last_open_note: None,
            expanded_paths: std::collections::HashMap::new(),
            has_dismissed_local_only_notice: false,
            editor_mode: EditorMode::default(),
        }
    }
}

pub fn state_path() -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    Some(base_dirs.config_dir().join("note-taker").join("state.toml"))
}

/// Unlike `config::get_config`, this never surfaces an error to the caller: UI
/// state is a convenience, not something worth blocking the app over, so a missing
/// or corrupt file just falls back to defaults.
pub fn get_state() -> UiState {
    let Some(state_path) = state_path() else {
        return UiState::default();
    };

    let Ok(raw) = fs::read_to_string(&state_path) else {
        return UiState::default();
    };

    toml::from_str(&raw).unwrap_or_default()
}

pub fn save_state(state: &UiState) -> Result<(), String> {
    let path = state_path()
        .ok_or_else(|| "could not resolve a home directory for the state file".to_string())?;
    let parent = path.parent().expect("state path always has a parent");
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let serialized = toml::to_string_pretty(state).map_err(|error| error.to_string())?;

    // Write to a temp file and rename so a crash mid-write can't leave a
    // truncated/corrupt state.toml behind, same as config.rs's `write_config`.
    let temp_path = path.with_extension("toml.tmp");
    fs::write(&temp_path, serialized).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, &path).map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::ENV_LOCK;
    use tempfile::TempDir;

    fn with_xdg_config_home<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        // Shared with config.rs's tests: `state_path` reads $XDG_CONFIG_HOME through
        // `directories::BaseDirs`, which is process-wide state.
        let _guard = ENV_LOCK.lock().unwrap();
        let temp_dir = TempDir::new().unwrap();
        let previous = std::env::var("XDG_CONFIG_HOME").ok();
        std::env::set_var("XDG_CONFIG_HOME", temp_dir.path());

        let result = f(temp_dir.path());

        match previous {
            Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }

        result
    }

    #[test]
    fn get_state_returns_defaults_when_no_file_exists() {
        with_xdg_config_home(|_| {
            let state = get_state();
            assert_eq!(state, UiState::default());
        });
    }

    #[test]
    fn get_state_returns_defaults_on_corrupt_toml() {
        with_xdg_config_home(|_| {
            let path = state_path().unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "this is not valid toml [[[").unwrap();

            let state = get_state();
            assert_eq!(state, UiState::default());
        });
    }

    #[test]
    fn get_state_defaults_editor_mode_to_edit_when_field_is_absent_from_toml() {
        with_xdg_config_home(|_| {
            let path = state_path().unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "split_ratio = 0.42\n").unwrap();

            let state = get_state();
            assert_eq!(state.editor_mode, EditorMode::Edit);
        });
    }

    #[test]
    fn state_round_trips_through_save_and_get() {
        with_xdg_config_home(|_| {
            let state = UiState {
                split_ratio: 0.42,
                last_open_note: Some(LastOpenNote {
                    root_id: "01AAA".to_string(),
                    path: "folder/note.md".to_string(),
                }),
                expanded_paths: std::collections::HashMap::from([(
                    "01AAA".to_string(),
                    vec!["folder".to_string(), "folder/sub".to_string()],
                )]),
                has_dismissed_local_only_notice: true,
                editor_mode: EditorMode::View,
            };

            save_state(&state).unwrap();

            assert_eq!(get_state(), state);
        });
    }

    #[test]
    fn save_state_creates_a_state_file_distinct_from_config_toml() {
        with_xdg_config_home(|_| {
            save_state(&UiState::default()).unwrap();

            let path = state_path().unwrap();
            assert!(path.exists());
            assert_eq!(path.file_name().unwrap(), "state.toml");
            assert!(!path.join("config.toml").exists());
        });
    }
}
