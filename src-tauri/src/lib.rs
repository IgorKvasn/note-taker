mod attachments;
mod config;
mod gitutil;
mod links;
mod notes;
mod search;
mod state;
mod sync;
mod tree;
mod update;

use std::path::Path;
use std::sync::Arc;

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

use config::{Config, ConfigOutcome, RootDraft, RootValidation};
use links::ScanLinksResult;
use notes::OpenNoteResult;
use search::SearchResult;
use state::UiState;
use sync::{RootStatus, SyncManager};
use tree::TreeNode;
use update::check_for_update;

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

/// One file picked and read for [`write_attachment`]'s `bytes` argument.
#[derive(Debug, Clone, serde::Serialize)]
struct PickedFile {
    name: String,
    bytes: Vec<u8>,
}

/// Native image-file picker for the toolbar's "Attach image file" action
/// (spec §11.1). Reads the chosen file's bytes server-side and hands them
/// back to the frontend, which then calls [`write_attachment`] with them --
/// `write_attachment` never trusts a client-supplied extension anyway, so
/// this read-then-write split costs nothing and needs no filesystem
/// capability beyond `dialog:default`, which already covers `pick_folder`.
/// `None` when the user cancels the dialog.
#[tauri::command]
async fn pick_image_file(app: AppHandle) -> Result<Option<PickedFile>, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = file_path
        .into_path()
        .map_err(|error| format!("could not resolve the picked file's path: {error}"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;

    Ok(Some(PickedFile { name, bytes }))
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
    trigger_sync_for_root(&app, &root_id, Some(path));
    Ok(())
}

#[tauri::command]
fn create_note(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let note_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_note(&note_path)?;
    trigger_sync_for_root(&app, &root_id, None);
    Ok(())
}

#[tauri::command]
fn create_folder(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let folder_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_folder(&folder_path)?;
    trigger_sync_for_root(&app, &root_id, None);
    Ok(())
}

/// Permanent deletion (issue #23) -- the frontend has already shown its
/// confirmation dialog by the time this is called. The removal is staged for
/// the sync chain the same way any other mutation is: `run_sync_chain`'s
/// `git add -A` picks up a deleted path just as it does an edited one.
#[tauri::command]
fn delete_item(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let item_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::delete_item(&item_path)?;
    trigger_sync_for_root(&app, &root_id, None);
    Ok(())
}

#[tauri::command]
fn move_item(
    app: AppHandle,
    root_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let root_path = config::find_root_path(&root_id)?;
    let from = config::resolve_path_in_root(&root_id, &from_path)?;
    let to = config::resolve_path_in_root(&root_id, &to_path)?;
    notes::move_item(&root_path, &from, &to)?;
    trigger_sync_for_root(&app, &root_id, None);
    Ok(())
}

#[tauri::command]
fn sync_root(app: AppHandle, root_id: String) -> Result<(), String> {
    trigger_sync_for_root(&app, &root_id, None);
    Ok(())
}

#[tauri::command]
fn get_root_status(app: AppHandle, root_id: String) -> Result<RootStatus, String> {
    let root = config::find_root_config(&root_id)?;
    let manager = app.state::<Arc<SyncManager>>();
    let last_known_state = manager.last_known_state(&root_id);
    Ok(sync::root_status(Path::new(&root.path), last_known_state))
}

/// Marks one conflicted note as resolved (issue #26). Runs synchronously
/// (unlike the save/create commands) so the editor can show an inline error
/// immediately if markers remain, rather than round-tripping through the
/// async sync-status event. On success, records and broadcasts the resulting
/// sync state exactly like the background chain does, so the tree section's
/// indicator and any other open note in this root stay in step.
#[tauri::command]
fn mark_resolved(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let root = config::find_root_config(&root_id)?;
    let absolute_path = config::resolve_path_in_root(&root_id, &path)?;
    let repo_path = Path::new(&root.path);

    let outcome = sync::mark_resolved(
        repo_path,
        &path,
        &absolute_path,
        root.auto_sync,
        &root.remote_url,
    )?;

    let manager = app.state::<Arc<SyncManager>>();
    manager.record_state(&root_id, outcome.sync_state.clone());
    // No save fed into this outcome -- it's the merge-commit-and-push that
    // finishing the last conflicted file runs inline, so `origin_paths` stays
    // empty and any editor open on a note this changed will still refresh.
    sync::emit_status(&app, &root_id, outcome.sync_state, Vec::new());
    Ok(())
}

/// The one call every save/create command makes to kick the sync chain off as
/// a background task (spec §7). A root that fails to resolve (e.g. a stale ID
/// from a since-removed root) just skips sync silently -- the mutation itself
/// already succeeded, and there is nothing sensible to sync. `origin_path` is
/// forwarded to [`sync::trigger_sync`] (issue #64) -- `Some` only for `save_note`.
fn trigger_sync_for_root(app: &AppHandle, root_id: &str, origin_path: Option<String>) {
    let Ok(root) = config::find_root_config(root_id) else {
        return;
    };
    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    sync::trigger_sync(app.clone(), manager, root, origin_path);
}

/// Startup catchup (issue #25): reactive-only sync leaves an interrupted push
/// with nothing to ever retry it, so every configured root gets the same
/// `trigger_sync` chain kicked off as `setup` returns. Each root's git work
/// runs on `trigger_sync`'s background task, so this call itself never blocks
/// the window from appearing or the last-open note from restoring, and one
/// root's failure can't stop another's from running -- they're entirely
/// independent background tasks. `git push` is idempotent, so calling this
/// again on a later launch (or if it somehow ran twice) is harmless.
fn run_startup_catchup(app: &AppHandle) {
    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    for root in config::all_root_configs() {
        sync::trigger_sync(app.clone(), manager.clone(), root, None);
    }
}

/// Stateless: `seq` is not tracked here, only echoed back on every result so
/// the frontend can discard a response overtaken by a newer request (spec §8).
/// Infallible by design -- a missing/unreadable root is skipped silently
/// rather than surfaced here (spec §8) -- but `Result` all the same, matching
/// every other command's IPC error shape.
#[tauri::command]
fn search_notes(query: String, seq: u64) -> Result<Vec<SearchResult>, String> {
    let roots = config::all_root_paths();
    Ok(search::search_notes(&query, seq, &roots))
}

/// Scans one root for `note:` link data (spec §9.2 addressing: same-root only).
/// Intentionally uncached on this side -- the frontend re-requests it on the
/// events that already refresh the tree, so a `git pull` changing files behind
/// the app's back cannot leave a stale backend map.
#[tauri::command]
fn scan_links(root_id: String) -> Result<ScanLinksResult, String> {
    let root_path = config::find_root_path(&root_id)?;
    Ok(links::scan_links(&root_path))
}

/// Writes attachment bytes into `.attachments/` (spec §11.3), triggering the
/// sync chain exactly like any other mutation. `original_name` is `None` for
/// a paste with no filename to draw from; validation and ULID generation both
/// happen inside [`attachments::write_attachment`].
#[tauri::command]
fn write_attachment(
    app: AppHandle,
    root_id: String,
    bytes: Vec<u8>,
    original_name: Option<String>,
) -> Result<String, String> {
    let root_path = config::find_root_path(&root_id)?;
    let reference = attachments::write_attachment(&root_path, &bytes, original_name.as_deref())?;
    trigger_sync_for_root(&app, &root_id, None);
    Ok(reference)
}

/// Returns an attachment's raw bytes as a binary IPC response rather than a
/// serialized byte array -- `tauri::ipc::Response` delivers an `ArrayBuffer`
/// to JS via `InvokeResponseBody::Raw`, avoiding the ~4.4x inflation a JSON
/// number array would cost on a real image (spec §11.3). Resolves `id` via a
/// prefix-match listing of `.attachments/`.
#[tauri::command]
fn read_attachment(root_id: String, id: String) -> Result<tauri::ipc::Response, String> {
    let root_path = config::find_root_path(&root_id)?;
    let bytes = attachments::read_attachment(&root_path, &id)?;
    Ok(tauri::ipc::Response::new(bytes))
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
        .plugin(tauri_plugin_opener::init())
        // FULLSCREEN is deliberately excluded: quitting while fullscreen would reopen
        // fullscreen with no way to reach the GTK menubar. SIZE skips recording while
        // maximized, so MAXIMIZED restores maximized while keeping the restored-down size.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_config,
            validate_root_path,
            pick_folder,
            pick_image_file,
            save_config,
            show_config_error,
            list_tree,
            open_note,
            save_note,
            create_note,
            create_folder,
            delete_item,
            move_item,
            sync_root,
            get_root_status,
            mark_resolved,
            search_notes,
            scan_links,
            write_attachment,
            read_attachment,
            get_state,
            save_state,
            check_for_update,
        ])
        .setup(|app| {
            app.manage(Arc::new(SyncManager::new()));

            // The actions live in a submenu rather than directly on the menu root:
            // a root-level item doubles as the menubar button that opens it, so on
            // GTK the first click only focuses the menubar and the action needs a
            // second click to fire.
            let app_menu = SubmenuBuilder::new(app, "Menu")
                .text(MENU_SETTINGS, "Settings")
                .text(MENU_ABOUT, "About")
                .separator()
                .text(MENU_QUIT, "Quit")
                .build()?;

            let menu = MenuBuilder::new(app).item(&app_menu).build()?;

            app.set_menu(menu)?;
            app.on_menu_event(|app, event| handle_menu_event(app, event.id().0.as_str()));

            run_startup_catchup(app.handle());

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
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid tauri.conf.json");

        assert!(
            config.get("version").is_none(),
            "tauri.conf.json must omit `version` so Cargo.toml stays the single source of truth"
        );
    }

    #[test]
    fn deb_bundle_declares_its_runtime_dependencies() {
        // The bundler injects only the webkit/gtk pair below; everything else we need
        // must be declared here or it is missing from `Depends:` entirely, producing a
        // .deb that installs and then fails at launch.
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid tauri.conf.json");
        let depends = config["bundle"]["linux"]["deb"]["depends"]
            .as_array()
            .expect("deb bundle declares a depends array");

        assert!(
            depends.iter().any(|entry| entry == "git"),
            "deb depends must include git"
        );

        // tauri-cli's Linux bundling unconditionally appends libwebkit2gtk-4.1-0 and
        // libgtk-3-0 to this list with no dedup (re-verified against tauri-cli 2.11.4 on
        // Ubuntu 26.04: a config of just ["git"] produced
        // `Depends: git, libwebkit2gtk-4.1-0, libgtk-3-0`), so listing them here too would
        // double them up in the built control file's Depends: line. Leave them out of our
        // config; the CLI supplies them.
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
