mod config;
mod notes;
mod state;
mod sync;
mod tree;

use std::path::Path;
use std::sync::Arc;

use tauri::menu::MenuBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use config::{Config, ConfigOutcome, RootDraft, RootValidation};
use notes::OpenNoteResult;
use state::UiState;
use sync::{RootStatus, SyncManager};
use tree::TreeNode;

pub const MENU_SETTINGS: &str = "settings";
pub const MENU_ABOUT: &str = "about";
pub const MENU_QUIT: &str = "quit";

/// The frontend opens its About modal in response.
pub const EVENT_MENU_ABOUT: &str = "menu://about";
/// Emitted when the user picks Settings. No Settings UI exists yet, so the
/// frontend currently ignores it.
pub const EVENT_MENU_SETTINGS: &str = "menu://settings";

/// The version comes from `Cargo.toml` `package.version` via `CARGO_PKG_VERSION`,
/// which is the app's single source of truth -- `tauri.conf.json` omits `version`
/// so the two cannot drift.
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_config() -> ConfigOutcome {
    config::get_config()
}

#[tauri::command]
fn validate_root_path(path: String) -> RootValidation {
    config::validate_root_path(&path)
}

/// Native folder picker. `blocking_pick_folder` must not run on the main thread; an
/// `async fn` Tauri command already runs on the async runtime's thread pool, so this
/// is safe as written.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|file_path| file_path.to_string())
}

#[tauri::command]
fn save_config(drafts: Vec<RootDraft>) -> Result<Config, String> {
    config::save_config(drafts)
}

#[tauri::command]
fn list_tree(root_id: String) -> Result<Vec<TreeNode>, String> {
    let root_path = config::find_root_path(&root_id)?;
    tree::list_tree(&root_path)
}

#[tauri::command]
fn open_note(root_id: String, path: String) -> Result<OpenNoteResult, String> {
    let root_path = config::find_root_path(&root_id)?;
    let note_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::open_note(&root_path, &note_path)
}

#[tauri::command]
fn save_note(app: AppHandle, root_id: String, path: String, content: String) -> Result<(), String> {
    let note_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::save_note(&note_path, &content)?;
    trigger_sync_for_root(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn create_note(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let note_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_note(&note_path)?;
    trigger_sync_for_root(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn create_folder(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let folder_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_folder(&folder_path)?;
    trigger_sync_for_root(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn sync_root(app: AppHandle, root_id: String) -> Result<(), String> {
    trigger_sync_for_root(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn get_root_status(app: AppHandle, root_id: String) -> Result<RootStatus, String> {
    let root = config::find_root_config(&root_id)?;
    let manager = app.state::<Arc<SyncManager>>();
    let last_known_state = manager.last_known_state(&root_id);
    Ok(sync::root_status(Path::new(&root.path), last_known_state))
}

/// The one call every save/create command makes to kick the sync chain off as
/// a background task (spec §7). A root that fails to resolve (e.g. a stale ID
/// from a since-removed root) just skips sync silently -- the mutation itself
/// already succeeded, and there is nothing sensible to sync.
fn trigger_sync_for_root(app: &AppHandle, root_id: &str) {
    let Ok(root) = config::find_root_config(root_id) else {
        return;
    };
    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    sync::trigger_sync(app.clone(), manager, root);
}

#[tauri::command]
fn get_state() -> UiState {
    state::get_state()
}

#[tauri::command]
fn save_state(state: UiState) -> Result<(), String> {
    state::save_state(&state)
}

/// Shown once when `get_config` reports an unparseable config.toml. The frontend
/// still renders a persistent in-webview error panel afterward -- this native dialog
/// is a transient attention-getter, not the durable "main UI does not load" state.
#[tauri::command]
async fn show_config_error(app: AppHandle, error: String) {
    app.dialog()
        .message(error)
        .title("note-taker configuration error")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
}

/// A failed emit means the menu item silently does nothing, which is invisible
/// without a log line -- so the error is reported rather than discarded.
fn emit_menu_event(app: &AppHandle, event: &str) {
    if let Err(error) = app.emit(event, ()) {
        eprintln!("failed to emit {event}: {error}");
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_ABOUT => emit_menu_event(app, EVENT_MENU_ABOUT),
        MENU_SETTINGS => emit_menu_event(app, EVENT_MENU_SETTINGS),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_config,
            validate_root_path,
            pick_folder,
            save_config,
            show_config_error,
            list_tree,
            open_note,
            save_note,
            create_note,
            create_folder,
            sync_root,
            get_root_status,
            get_state,
            save_state,
        ])
        .setup(|app| {
            app.manage(Arc::new(SyncManager::new()));

            // Flat menu bar: Settings, About and Quit are top-level actions with
            // no submenus, so `.text(..)` items go straight onto the menu root.
            let menu = MenuBuilder::new(app)
                .text(MENU_SETTINGS, "Settings")
                .text(MENU_ABOUT, "About")
                .text(MENU_QUIT, "Quit")
                .build()?;

            app.set_menu(menu)?;
            app.on_menu_event(|app, event| handle_menu_event(app, event.id().0.as_str()));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo_manifest() {
        let manifest = include_str!("../Cargo.toml");
        let declared = manifest
            .lines()
            .find_map(|line| line.strip_prefix("version = "))
            .map(|value| value.trim().trim_matches('"'))
            .expect("Cargo.toml declares a package version");

        assert_eq!(get_app_version(), declared);
    }

    #[test]
    fn tauri_config_declares_no_version_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri.conf.json");

        assert!(
            config.get("version").is_none(),
            "tauri.conf.json must omit `version` so Cargo.toml stays the single source of truth"
        );
    }

    #[test]
    fn deb_bundle_declares_its_runtime_dependencies() {
        // The bundler does not auto-populate `Depends:` -- leaving this unset omits
        // the field entirely, producing a .deb that installs and then fails to launch.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri.conf.json");
        let depends = config["bundle"]["linux"]["deb"]["depends"]
            .as_array()
            .expect("deb bundle declares a depends array");

        assert!(
            depends.iter().any(|entry| entry == "git"),
            "deb depends must include git"
        );

        // tauri-cli's Linux bundling unconditionally appends libwebkit2gtk-4.1-0 and
        // libgtk-3-0 to this list with no dedup (verified against tauri-cli 2.11.4/2.11.5),
        // so listing them here too would double them up in the built control file's
        // Depends: line. Leave them out of our config; the CLI supplies them.
        for auto_injected in ["libwebkit2gtk-4.1-0", "libgtk-3-0"] {
            assert!(
                !depends.iter().any(|entry| entry == auto_injected),
                "{auto_injected} is auto-injected by tauri-cli on Linux -- listing it here would duplicate it"
            );
        }
    }

    #[test]
    fn release_version_has_no_prerelease_suffix() {
        // A hyphenated pre-release sorts NEWER than the plain release under
        // Debian's rules, inverted from semver, so releases stay MAJOR.MINOR.PATCH.
        let version = get_app_version();
        assert!(
            !version.contains('-'),
            "version {version} must be plain MAJOR.MINOR.PATCH"
        );
        assert_eq!(
            version.split('.').count(),
            3,
            "version {version} must have exactly three components"
        );
    }
}
