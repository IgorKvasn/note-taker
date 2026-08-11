mod attachments;
mod cleanup;
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

use cleanup::{CleanupPreview, ReferenceCache};
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

/// Saving Settings can change a root's `sync_debounce_secs` out from under a
/// countdown that's already counting down for that root (issue #87): without
/// this, a save made just before Settings was saved would still fire at the
/// old delay, ignoring the value the user just set. Reads the roots as they
/// were *before* the write to know which ones actually changed -- comparing
/// against the drafts themselves would not catch e.g. a rename of an existing
/// root's `id`-less counterpart, and diffing the returned `Config` against a
/// snapshot taken first avoids any race with a concurrent save.
#[tauri::command]
fn save_config(app: AppHandle, drafts: Vec<RootDraft>) -> Result<Config, String> {
    let previous_roots = config::all_root_configs();
    let config = config::save_config(drafts)?;

    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    for root in &config.roots {
        let previous_debounce = previous_roots
            .iter()
            .find(|previous| previous.id == root.id)
            .map(|previous| previous.sync_debounce_secs);
        if previous_debounce == Some(root.sync_debounce_secs) {
            // Unchanged (or a brand new root, which can have no countdown in
            // progress for an id that didn't exist a moment ago) -- leave
            // this root's slot alone.
            continue;
        }
        sync::SyncManager::rearm_delay(app.clone(), manager.clone(), root.clone());
    }

    Ok(config)
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
    app.state::<Arc<ReferenceCache>>()
        .update_note(&root_id, &path, &content);
    trigger_sync_for_root(&app, &root_id, Some(path));
    Ok(())
}

#[tauri::command]
fn create_note(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let note_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_note(&note_path)?;
    trigger_sync_for_root_immediate(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn create_folder(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let folder_path = config::resolve_path_in_root(&root_id, &path)?;
    notes::create_folder(&folder_path)?;
    trigger_sync_for_root_immediate(&app, &root_id);
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
    trigger_sync_for_root_immediate(&app, &root_id);
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
    trigger_sync_for_root_immediate(&app, &root_id);
    Ok(())
}

#[tauri::command]
fn sync_root(app: AppHandle, root_id: String) -> Result<(), String> {
    trigger_sync_for_root_immediate(&app, &root_id);
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

/// The one call [`save_note`] makes to kick the sync chain off as a
/// background task (spec §7), routed through the root's configured quiet
/// period (issue #84) so a burst of keystroke-driven saves settles into a
/// single trailing run. A root that fails to resolve (e.g. a stale ID from a
/// since-removed root) just skips sync silently -- the mutation itself
/// already succeeded, and there is nothing sensible to sync. `origin_path` is
/// forwarded to [`sync::trigger_sync_delayed`] (issue #64). Note-content
/// saves are the only trigger with keystrokes behind them and a successor
/// edit worth waiting for; every other mutation uses
/// [`trigger_sync_for_root_immediate`] instead (issue #86).
fn trigger_sync_for_root(app: &AppHandle, root_id: &str, origin_path: Option<String>) {
    let Ok(root) = config::find_root_config(root_id) else {
        return;
    };
    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    sync::trigger_sync_delayed(app.clone(), manager, root, origin_path);
}

/// Every non-save mutation's call to kick the sync chain off immediately
/// (issue #86): tree structure changes (create/rename/move/delete),
/// attachment writes/imports, attachment cleanup, and manual per-root sync
/// are each a discrete, deliberate action with no keystrokes behind them and
/// no successor edit to wait for, so there is nothing to gain by coalescing
/// them behind [`trigger_sync_for_root`]'s delay -- "network's back, try
/// again" must mean try now. Skips silently on an unresolvable root, same as
/// [`trigger_sync_for_root`]. None of these callers have a save's content to
/// attribute, so there is no `origin_path` parameter here.
fn trigger_sync_for_root_immediate(app: &AppHandle, root_id: &str) {
    let Ok(root) = config::find_root_config(root_id) else {
        return;
    };
    let manager = app.state::<Arc<SyncManager>>().inner().clone();
    sync::trigger_sync(app.clone(), manager, root, None);
}

/// Background attachment cleanup for every configured root, run once at
/// startup (spec §11.5's "app start" trigger) -- no note is open yet this
/// early, so there is no live-buffer extra reference source to pass. Spawned
/// as a background task so a large `.attachments/` listing never blocks the
/// window from appearing; each root's cleanup failing silently (a missing
/// root, an unreadable directory) matches `sync::run_startup_catchup`'s own
/// per-root independence.
fn run_startup_attachment_cleanup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for root in config::all_root_configs() {
            let _ = cleanup_attachments(app.clone(), root.id, None);
        }
    });
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
    trigger_sync_for_root_immediate(&app, &root_id);
    Ok(reference)
}

/// Reads a file server-side from an absolute path and otherwise behaves
/// exactly like [`write_attachment`] (spec §11.3): same magic-byte
/// validation, same ULID generation, same `.attachments/` write, same sync
/// trigger. A deliberate, narrow exception to the general rule that absolute
/// paths never cross the IPC boundary -- justified because it's plumbing
/// shared between the clipboard's `file:///`-path paste case (issue #77) and
/// drag-and-drop (issue #78), not a widening of general filesystem access.
#[tauri::command]
fn import_attachment(
    app: AppHandle,
    root_id: String,
    absolute_path: String,
) -> Result<String, String> {
    let root_path = config::find_root_path(&root_id)?;
    let reference = attachments::import_attachment(&root_path, Path::new(&absolute_path))?;
    trigger_sync_for_root_immediate(&app, &root_id);
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

/// Deletes every attachment `cleanup::find_orphaned_attachments` reports,
/// through `notes::delete_item` so the removal rides the same sync/commit
/// chain as any other mutation, with no special-cased commit message. Shared
/// by the silent background path and the manual execute step -- there is no
/// separate "more aggressive" manual mode. Resolves each attachment's root
/// path from its own `root_id` (rather than taking one shared root) so a
/// preview spanning multiple roots (issue #89) deletes from each root's own
/// `.attachments/` directory, not just the first.
fn delete_orphaned_attachments(preview: &CleanupPreview) -> Result<(), String> {
    for attachment in &preview.attachments {
        let root_path = config::find_root_path(&attachment.root_id)?;
        notes::delete_item(&root_path.join(&attachment.path))?;
    }
    Ok(())
}

/// Background cleanup (spec §11.5): called on app start and on the first
/// switch of any note to preview mode this session. Deletes every orphaned
/// attachment found straight away -- silent by design, no toast, no dialog.
/// `open_note_content` is the currently-open note's live buffer, `None` when
/// no note is open.
#[tauri::command]
fn cleanup_attachments(
    app: AppHandle,
    root_id: String,
    open_note_content: Option<String>,
) -> Result<(), String> {
    let root_path = config::find_root_path(&root_id)?;
    let cache = app.state::<Arc<ReferenceCache>>();
    let preview = cleanup::find_orphaned_attachments(
        &root_id,
        &root_path,
        &cache,
        open_note_content.as_deref(),
    );

    delete_orphaned_attachments(&preview)?;
    trigger_sync_for_root_immediate(&app, &root_id);
    Ok(())
}

/// The Settings dialog's manual trigger (spec §11.5): reports what would be
/// deleted -- count and total size -- without deleting anything, sharing the
/// exact same reference-scan and grace-period guards as background cleanup.
/// The frontend calls [`execute_attachment_cleanup`] separately after the
/// user confirms.
#[tauri::command]
fn preview_attachment_cleanup(
    app: AppHandle,
    root_id: String,
    open_note_content: Option<String>,
) -> Result<CleanupPreview, String> {
    let root_path = config::find_root_path(&root_id)?;
    let cache = app.state::<Arc<ReferenceCache>>();
    Ok(cleanup::find_orphaned_attachments(
        &root_id,
        &root_path,
        &cache,
        open_note_content.as_deref(),
    ))
}

/// Deletes exactly what a fresh scan (same guards, same cache) currently
/// reports as orphaned -- re-running the scan rather than trusting a list the
/// frontend held onto across the confirmation dialog, since an intervening
/// save could have changed what's actually orphaned in the meantime. Returns
/// what it deleted so the frontend's completion toast reports accurate
/// numbers even if they drifted from the preview.
#[tauri::command]
fn execute_attachment_cleanup(
    app: AppHandle,
    root_id: String,
    open_note_content: Option<String>,
) -> Result<CleanupPreview, String> {
    let root_path = config::find_root_path(&root_id)?;
    let cache = app.state::<Arc<ReferenceCache>>();
    let preview = cleanup::find_orphaned_attachments(
        &root_id,
        &root_path,
        &cache,
        open_note_content.as_deref(),
    );

    delete_orphaned_attachments(&preview)?;
    trigger_sync_for_root_immediate(&app, &root_id);
    Ok(preview)
}

/// The Settings dialog's manual trigger, extended to every configured root at
/// once (issue #89) rather than just whichever root happens to have a note
/// open -- cleanup is root-agnostic housekeeping, and the button is enabled
/// even with no note open. `open_root_id`/`open_note_content` scope buffer
/// protection to the open note's own root, same as the single-root command.
#[tauri::command]
fn preview_attachment_cleanup_all_roots(
    app: AppHandle,
    open_root_id: Option<String>,
    open_note_content: Option<String>,
) -> Result<CleanupPreview, String> {
    let cache = app.state::<Arc<ReferenceCache>>();
    Ok(cleanup::find_orphaned_attachments_across_roots(
        &config::all_root_configs(),
        &cache,
        open_root_id.as_deref(),
        open_note_content.as_deref(),
    ))
}

/// Deletes exactly what a fresh all-roots scan currently reports as orphaned,
/// mirroring [`execute_attachment_cleanup`]'s re-scan-rather-than-trust-the-
/// preview approach but across every configured root (issue #89). Each root's
/// sync is triggered independently, matching how every other multi-root
/// action (e.g. [`sync::run_startup_catchup`]) treats roots as independent.
#[tauri::command]
fn execute_attachment_cleanup_all_roots(
    app: AppHandle,
    open_root_id: Option<String>,
    open_note_content: Option<String>,
) -> Result<CleanupPreview, String> {
    let cache = app.state::<Arc<ReferenceCache>>();
    let roots = config::all_root_configs();
    let preview = cleanup::find_orphaned_attachments_across_roots(
        &roots,
        &cache,
        open_root_id.as_deref(),
        open_note_content.as_deref(),
    );

    delete_orphaned_attachments(&preview)?;
    for root in roots {
        trigger_sync_for_root_immediate(&app, &root.id);
    }
    Ok(preview)
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
            import_attachment,
            read_attachment,
            cleanup_attachments,
            preview_attachment_cleanup,
            execute_attachment_cleanup,
            preview_attachment_cleanup_all_roots,
            execute_attachment_cleanup_all_roots,
            get_state,
            save_state,
            check_for_update,
        ])
        .setup(|app| {
            app.manage(Arc::new(SyncManager::new()));
            app.manage(Arc::new(ReferenceCache::new()));

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

            let manager = app.state::<Arc<SyncManager>>().inner().clone();
            sync::run_startup_catchup(app.handle(), &manager, config::all_root_configs());
            run_startup_attachment_cleanup(app.handle());

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

    fn with_xdg_config_home<T>(f: impl FnOnce(&Path) -> T) -> T {
        // Shared with config.rs's tests: `config_path` reads $XDG_CONFIG_HOME
        // through `directories::BaseDirs`, which is process-wide state.
        let _guard = config::tests::ENV_LOCK.lock().unwrap();
        let temp_dir = tempfile::TempDir::new().unwrap();
        let previous = std::env::var("XDG_CONFIG_HOME").ok();
        std::env::set_var("XDG_CONFIG_HOME", temp_dir.path());

        let result = f(temp_dir.path());

        match previous {
            Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }

        result
    }

    fn write_test_config(roots: &[config::RootConfig]) {
        let config = config::Config {
            version: 1,
            roots: roots.to_vec(),
        };
        let path = config::config_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();
    }

    #[test]
    fn delete_orphaned_attachments_deletes_from_every_root_named_in_the_preview() {
        with_xdg_config_home(|_| {
            let root_a = tempfile::TempDir::new().unwrap();
            let root_b = tempfile::TempDir::new().unwrap();
            let attachments_a = root_a.path().join(".attachments");
            let attachments_b = root_b.path().join(".attachments");
            std::fs::create_dir_all(&attachments_a).unwrap();
            std::fs::create_dir_all(&attachments_b).unwrap();
            std::fs::write(attachments_a.join("01AAA-a.png"), b"a").unwrap();
            std::fs::write(attachments_b.join("01BBB-b.png"), b"b").unwrap();

            write_test_config(&[
                config::RootConfig {
                    id: "root-a".to_string(),
                    path: root_a.path().to_string_lossy().into_owned(),
                    auto_sync: false,
                    remote_url: String::new(),
                    sync_debounce_secs: 5,
                },
                config::RootConfig {
                    id: "root-b".to_string(),
                    path: root_b.path().to_string_lossy().into_owned(),
                    auto_sync: false,
                    remote_url: String::new(),
                    sync_debounce_secs: 5,
                },
            ]);

            let preview = CleanupPreview {
                attachments: vec![
                    cleanup::OrphanedAttachment {
                        root_id: "root-a".to_string(),
                        path: ".attachments/01AAA-a.png".to_string(),
                        size: 1,
                    },
                    cleanup::OrphanedAttachment {
                        root_id: "root-b".to_string(),
                        path: ".attachments/01BBB-b.png".to_string(),
                        size: 1,
                    },
                ],
                total_size: 2,
            };

            delete_orphaned_attachments(&preview).expect("delete should succeed");

            assert!(
                !attachments_a.join("01AAA-a.png").exists(),
                "root-a's attachment must be deleted, not just the first root's"
            );
            assert!(
                !attachments_b.join("01BBB-b.png").exists(),
                "root-b's attachment must also be deleted"
            );
        });
    }
}
