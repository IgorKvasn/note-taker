mod config;

use tauri::menu::MenuBuilder;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use config::{Config, ConfigOutcome, RootDraft, RootValidation};

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
        ])
        .setup(|app| {
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

        for required in ["libwebkit2gtk-4.1-0", "libgtk-3-0", "git"] {
            assert!(
                depends.iter().any(|entry| entry == required),
                "deb depends must include {required}"
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
