//! The background git sync chain (spec §7): `git add` -> `git commit` -> (if
//! `auto_sync` and a remote are configured) `git push` -> on rejection, a plain
//! `git merge` -> re-push if clean, or report `conflict` if markers remain.
//!
//! Save and tree-mutation commands return as soon as their filesystem work is
//! done, kicking the chain off as a background task rather than awaiting it.
//! Only a note-content save routes through [`trigger_sync_delayed`] (issue
//! #84), which arms or rearms a trailing-only per-root quiet period and only
//! calls the immediate [`trigger_sync`] once it elapses -- coalescing a burst
//! of keystrokes into one run. Every other trigger -- creating or renaming or
//! moving or deleting an item, writing or importing an attachment, manual
//! per-root sync, and startup catchup -- is a discrete, deliberate action
//! with no keystrokes behind it, so it calls `trigger_sync` directly and
//! commits immediately (issue #86), subject only to `trigger_sync`'s own
//! busy/pending coalescing for concurrent triggers on the same root.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::RootConfig;
use crate::gitutil::{run_git, run_git_expecting_success, stderr_of};

pub const EVENT_SYNC_STATUS: &str = "sync-status";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncState {
    Syncing,
    Synced,
    LocalOnly,
    Conflict,
    Error { stderr: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncStatusEvent {
    pub root_id: String,
    pub state: SyncState,
    /// Root-relative paths of notes whose `save_note` call fed into this sync
    /// run (issue #64). Empty for a sync with no save behind it at all --
    /// `create_note`/`create_folder`/`delete_item`/`move_item`/`sync_root`,
    /// startup catchup, and `mark_resolved`'s own direct emission. Lets a
    /// client tell a sync it caused (its own path is in here) apart from one
    /// it needs to react to, e.g. another note's save or a merge pulling in
    /// remote changes -- both leave this note's path out of the set.
    pub origin_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RootStatus {
    pub conflicted_paths: Vec<String>,
    pub sync_state: SyncState,
}

/// Per-root sync scheduling: serializes syncs on the same root (never two git
/// processes touching one index concurrently) while leaving different roots
/// fully independent, and coalesces rapid successive triggers into a single
/// trailing run instead of stacking one run per save.
#[derive(Default)]
pub struct SyncManager {
    roots: Mutex<HashMap<String, Arc<RootSyncSlot>>>,
    /// The most recent terminal state emitted for each root, so `get_root_status`
    /// can answer before any sync has run in this process (falling back to
    /// `local_only`) and otherwise report the last outcome without re-running git.
    last_known_state: Mutex<HashMap<String, SyncState>>,
}

#[derive(Default)]
struct RootSyncSlot {
    /// `true` while a sync for this root is running or queued. A trigger that
    /// finds this already set just flips `pending` and returns -- the run
    /// already in flight will pick up the trailing request when it finishes.
    busy: Mutex<bool>,
    /// Set by a trigger that arrived while `busy` was true; checked by the
    /// running sync right before it clears `busy`, so at most one extra run
    /// happens no matter how many triggers arrived in between.
    pending: Mutex<bool>,
    /// Accumulates the save origin paths (see [`SyncStatusEvent::origin_paths`])
    /// for whichever run hasn't started yet -- the queued initial run, or the
    /// coalesced trailing run once one is already in flight. Drained into that
    /// run's own snapshot right before it starts, so a trigger arriving mid-run
    /// contributes to the *next* pass's origin set, never the one already executing.
    next_origin_paths: Mutex<Vec<String>>,
    /// Bumped by every call to [`trigger_sync_delayed`] for this root. A
    /// delayed task captures the value at arm time and, once its sleep
    /// finishes, only proceeds to the immediate [`trigger_sync`] if the
    /// generation still matches -- otherwise a later call has rearmed the
    /// countdown and this stale task simply exits, giving trailing-only
    /// debounce without ever cancelling the sleeping task itself.
    delay_generation: AtomicU64,
}

impl SyncManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot_for(&self, root_id: &str) -> Arc<RootSyncSlot> {
        let mut roots = self.roots.lock().unwrap();
        roots
            .entry(root_id.to_string())
            .or_insert_with(|| Arc::new(RootSyncSlot::default()))
            .clone()
    }

    pub fn last_known_state(&self, root_id: &str) -> Option<SyncState> {
        self.last_known_state.lock().unwrap().get(root_id).cloned()
    }

    pub fn record_state(&self, root_id: &str, state: SyncState) {
        self.last_known_state
            .lock()
            .unwrap()
            .insert(root_id.to_string(), state);
    }
}

/// Kicks off the sync chain for `root` as a background task and returns
/// immediately. [`trigger_sync_delayed`] calls this once its own quiet-period
/// timer elapses; every structural mutation, attachment write/import, manual
/// per-root sync, and startup catchup calls this directly instead, since none
/// of them have keystrokes behind them worth coalescing (issue #86).
/// `origin_path` is the root-relative path of the note whose save triggered
/// this call, if any (issue #64); a trigger with no save behind it (a create,
/// a delete, a manual sync) passes `None`.
pub fn trigger_sync(
    app: AppHandle,
    manager: Arc<SyncManager>,
    root: RootConfig,
    origin_path: Option<String>,
) {
    let slot = manager.slot_for(&root.id);

    {
        let mut busy = slot.busy.lock().unwrap();
        if let Some(path) = origin_path {
            slot.next_origin_paths.lock().unwrap().push(path);
        }
        if *busy {
            *slot.pending.lock().unwrap() = true;
            return;
        }
        *busy = true;
    }

    let manager_for_task = manager.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let origin_paths = std::mem::take(&mut *slot.next_origin_paths.lock().unwrap());
            run_sync_chain(&app, &manager_for_task, &root, origin_paths);

            let mut busy = slot.busy.lock().unwrap();
            let mut pending = slot.pending.lock().unwrap();
            if *pending {
                // A trailing request arrived mid-run -- coalesce it into one
                // more pass instead of stacking a second background task.
                *pending = false;
                continue;
            }
            *busy = false;
            break;
        }
    });
}

/// Arms (or rearms) `root`'s quiet-period timer and returns immediately
/// (issue #84): every current caller of [`trigger_sync`] routes through here
/// instead, so a burst of saves settles into a single trailing chain run
/// rather than one per save. A later call for the same root before the delay
/// elapses restarts the countdown -- trailing-only, no leading edge, no
/// maximum-wait ceiling -- by bumping `delay_generation` so the earlier
/// sleeping task finds itself stale when it wakes and exits without running
/// anything. `origin_path` is queued into `next_origin_paths` up front, same
/// as [`trigger_sync`] does today, so it's still attributed to whichever run
/// eventually fires even though that run is now delayed.
///
/// `root.sync_debounce_secs` of `0` (only reachable by constructing a
/// `RootConfig` directly, since saved config is validated to 1-300) is
/// treated as "fire almost immediately" rather than hanging -- needed for
/// `run_startup_catchup`'s own tests, which use `0` for fast, deterministic
/// timing and predate this delay.
pub fn trigger_sync_delayed(
    app: AppHandle,
    manager: Arc<SyncManager>,
    root: RootConfig,
    origin_path: Option<String>,
) {
    let slot = manager.slot_for(&root.id);

    if let Some(path) = origin_path {
        slot.next_origin_paths.lock().unwrap().push(path);
    }

    let generation = slot.delay_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let delay = Duration::from_secs(root.sync_debounce_secs as u64);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;

        if slot.delay_generation.load(Ordering::SeqCst) != generation {
            // A later call rearmed the countdown before this one elapsed --
            // that call's own task owns firing the chain now.
            return;
        }

        trigger_sync(app, manager, root, None);
    });
}

/// Startup catchup (issue #25): reactive-only sync leaves an interrupted push
/// with nothing to ever retry it, so every configured root gets the same
/// `trigger_sync` chain kicked off as `setup` returns. Runs `trigger_sync`
/// immediately rather than through [`trigger_sync_delayed`] (issue #86): work
/// stranded from a previous session should be dealt with promptly, not held
/// behind a countdown with no successor edit to wait for. Each root's git
/// work runs on `trigger_sync`'s background task, so this call itself never
/// blocks the window from appearing or the last-open note from restoring, and
/// one root's failure can't stop another's from running -- they're entirely
/// independent background tasks. `git push` is idempotent, so calling this
/// again on a later launch (or if it somehow ran twice) is harmless.
///
/// Takes `roots` explicitly (issue #81) rather than reading global config, so
/// a test can drive it against seeded repositories without going through the
/// Tauri setup hook.
pub fn run_startup_catchup(app: &AppHandle, manager: &Arc<SyncManager>, roots: Vec<RootConfig>) {
    for root in roots {
        trigger_sync(app.clone(), manager.clone(), root, None);
    }
}

pub fn emit_status(app: &AppHandle, root_id: &str, state: SyncState, origin_paths: Vec<String>) {
    let event = SyncStatusEvent {
        root_id: root_id.to_string(),
        state,
        origin_paths,
    };
    if let Err(error) = app.emit(EVENT_SYNC_STATUS, &event) {
        eprintln!("failed to emit {EVENT_SYNC_STATUS}: {error}");
    }
}

/// `git add` -> `git commit` -> (if configured) `git push` -> on rejection,
/// merge and re-push. Runs synchronously on whatever thread calls it; the
/// caller is expected to be the background task spawned by [`trigger_sync`].
fn run_sync_chain(
    app: &AppHandle,
    manager: &SyncManager,
    root: &RootConfig,
    origin_paths: Vec<String>,
) {
    emit_status(app, &root.id, SyncState::Syncing, origin_paths.clone());

    let repo_path = Path::new(&root.path);
    let (final_state, merged) = sync_once(repo_path, root.auto_sync, &root.remote_url);
    manager.record_state(&root.id, final_state.clone());
    // A merge (run only after a rejected push) can rewrite any tracked file
    // with remote-side content, including one of this run's own origin paths
    // -- so a merge invalidates the guarantee that those paths' disk content
    // came only from the save that reported them, and origin_paths must not
    // claim otherwise (issue #64).
    let reported_origin_paths = if merged { Vec::new() } else { origin_paths };
    emit_status(app, &root.id, final_state, reported_origin_paths);
}

/// The chain's actual logic, separated from event emission so it can be unit
/// tested against real throwaway git repos without a `tauri::AppHandle`. The
/// returned `bool` is `true` if a `git merge` ran (i.e. the initial push was
/// rejected) -- see `run_sync_chain`'s use of it to gate `origin_paths`.
fn sync_once(repo_path: &Path, auto_sync: bool, remote_url: &str) -> (SyncState, bool) {
    if let Err(stderr) = git_add_all(repo_path) {
        return (SyncState::Error { stderr }, false);
    }

    match git_commit(repo_path) {
        Ok(_) => {}
        Err(CommitError::NothingToCommit) => {}
        Err(CommitError::Failed(stderr)) => return (SyncState::Error { stderr }, false),
    }

    if !auto_sync || remote_url.is_empty() {
        return (SyncState::LocalOnly, false);
    }

    match git_push(repo_path) {
        Ok(()) => (SyncState::Synced, false),
        Err(stderr) => (resolve_after_push_rejection(repo_path, &stderr), true),
    }
}

/// A rejected push is not itself a conflict (spec §7): a plain merge resolves
/// most divergence silently. Only a merge leaving `<<<<<<<` markers behind is
/// reported as `conflict`; anything else that fails the merge itself is a raw
/// error, same as any other git failure.
fn resolve_after_push_rejection(repo_path: &Path, push_stderr: &str) -> SyncState {
    match git_merge(repo_path) {
        Ok(()) => match git_push(repo_path) {
            Ok(()) => SyncState::Synced,
            Err(stderr) => SyncState::Error { stderr },
        },
        Err(MergeError::Conflict) => SyncState::Conflict,
        Err(MergeError::Failed(stderr)) => SyncState::Error {
            stderr: format!("push rejected: {push_stderr}\nmerge failed: {stderr}"),
        },
    }
}

fn git_add_all(repo_path: &Path) -> Result<(), String> {
    run_git_expecting_success(repo_path, &["add", "-A"])
}

enum CommitError {
    /// `git commit` exits non-zero when the working tree matches HEAD -- this
    /// is not a failure, just nothing to sync this round.
    NothingToCommit,
    Failed(String),
}

fn git_commit(repo_path: &Path) -> Result<(), CommitError> {
    let output =
        run_git(repo_path, &["commit", "-m", "note-taker sync"]).map_err(CommitError::Failed)?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = stderr_of(&output);
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("nothing to commit") || stderr.contains("nothing to commit") {
        Err(CommitError::NothingToCommit)
    } else {
        Err(CommitError::Failed(stderr))
    }
}

fn git_push(repo_path: &Path) -> Result<(), String> {
    run_git_expecting_success(repo_path, &["push"])
}

enum MergeError {
    Conflict,
    Failed(String),
}

/// Plain merge, never rebase (spec §7's single more-forgiving failure mode).
/// `git merge` (unlike `git pull`) has no rebase mode to opt out of -- rebase
/// only enters the picture via `git pull --rebase` or `pull.rebase`, neither
/// of which this chain ever invokes. `git merge` first needs `git fetch` to
/// know what to merge against.
fn git_merge(repo_path: &Path) -> Result<(), MergeError> {
    let fetch = run_git(repo_path, &["fetch"]).map_err(MergeError::Failed)?;
    if !fetch.status.success() {
        return Err(MergeError::Failed(stderr_of(&fetch)));
    }

    let merge = run_git(repo_path, &["merge", "FETCH_HEAD"]).map_err(MergeError::Failed)?;
    if merge.status.success() {
        return Ok(());
    }

    if has_conflict_markers(repo_path) {
        Err(MergeError::Conflict)
    } else {
        Err(MergeError::Failed(stderr_of(&merge)))
    }
}

/// Walks tracked files under `repo_path` looking for leftover `<<<<<<<`
/// markers. Full per-file conflict scanning/UI is issue #26's job; this is
/// only used to classify a failed merge as `conflict` vs. a raw error.
fn has_conflict_markers(repo_path: &Path) -> bool {
    let output = match run_git(repo_path, &["diff", "--check"]) {
        Ok(output) => output,
        Err(_) => return false,
    };
    // `git diff --check` flags conflict markers as "leftover conflict marker";
    // a non-empty stdout is the simplest reliable signal without a full walk.
    !output.stdout.is_empty()
}

/// `mark_resolved`'s outcome once the file itself is clean of markers: whether
/// clearing it was the last conflicted file, which decides whether the merge
/// commit fires and a push is re-attempted.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MarkResolvedOutcome {
    pub sync_state: SyncState,
}

/// Marks one conflicted file as resolved (issue #26): blocks with an inline
/// error if `<<<<<<<`/`=======`/`>>>>>>>` markers remain in `absolute_path`,
/// so a note is never staged half-resolved. Otherwise stages it via
/// `relative_path` (git needs a repo-relative path for `add`). If that was the
/// last conflicted file in `repo_path`, finishes the merge with a commit and
/// immediately re-attempts the push -- the same push/merge-retry cycle
/// `sync_once` already runs, so a second rejection is handled identically.
pub fn mark_resolved(
    repo_path: &Path,
    relative_path: &str,
    absolute_path: &Path,
    auto_sync: bool,
    remote_url: &str,
) -> Result<MarkResolvedOutcome, String> {
    let content = std::fs::read_to_string(absolute_path).map_err(|error| error.to_string())?;
    if crate::notes::has_conflict_markers(&content) {
        return Err("this note still has unresolved conflict markers".to_string());
    }

    run_git_expecting_success(repo_path, &["add", "--", relative_path])?;

    if !conflicted_relative_paths(repo_path).is_empty() {
        // Other conflicted files remain -- nothing more to do until each of
        // them gets its own `mark_resolved`.
        return Ok(MarkResolvedOutcome {
            sync_state: SyncState::Conflict,
        });
    }

    // This was the last conflicted file: finish the merge with a commit (no
    // editor -- `--no-edit` accepts the message git already prepared in
    // MERGE_MSG) and re-attempt the push right away, same as any other sync.
    run_git_expecting_success(repo_path, &["commit", "--no-edit"])?;

    if !auto_sync || remote_url.is_empty() {
        return Ok(MarkResolvedOutcome {
            sync_state: SyncState::LocalOnly,
        });
    }

    let sync_state = match git_push(repo_path) {
        Ok(()) => SyncState::Synced,
        Err(stderr) => resolve_after_push_rejection(repo_path, &stderr),
    };
    Ok(MarkResolvedOutcome { sync_state })
}

/// `get_root_status`'s conflict signal: a `MERGE_HEAD` file is sufficient
/// evidence of a stuck merge for this ticket's scope.
pub fn is_merge_in_progress(repo_path: &Path) -> bool {
    repo_path.join(".git").join("MERGE_HEAD").exists()
}

/// The exact set of files git still considers unmerged, relative to
/// `repo_path` -- what the tree UI marks per-note and counts for "N notes
/// need resolution" (issue #26). Empty whenever there's no merge in progress,
/// since `git diff --diff-filter=U` naturally reports nothing outside a merge.
pub fn conflicted_relative_paths(repo_path: &Path) -> Vec<String> {
    if !is_merge_in_progress(repo_path) {
        return Vec::new();
    }

    // `-c core.quotepath=false` keeps non-ASCII paths (note titles are NFC-normalized
    // Unicode, see `notes.rs`) as literal UTF-8 instead of octal-escaped C-style quoting.
    let output = match run_git(
        repo_path,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-only",
            "--diff-filter=U",
        ],
    ) {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn root_status(repo_path: &Path, last_known_state: Option<SyncState>) -> RootStatus {
    let conflicted_paths = conflicted_relative_paths(repo_path);
    let sync_state = if !conflicted_paths.is_empty() {
        SyncState::Conflict
    } else {
        last_known_state.unwrap_or(SyncState::LocalOnly)
    };

    RootStatus {
        conflicted_paths,
        sync_state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    /// The frontend's `SyncState` union (`src/ipc.ts`) matches on these exact
    /// tag strings, so the serde renaming is part of the IPC contract rather
    /// than an internal detail: `rename_all = "lowercase"` would silently emit
    /// `localonly` for the multi-word variant and no frontend arm would match.
    #[test]
    fn sync_state_serializes_with_the_tags_the_frontend_matches_on() {
        let tag_of = |state: &SyncState| {
            serde_json::to_value(state).unwrap()["state"]
                .as_str()
                .unwrap()
                .to_string()
        };

        assert_eq!(tag_of(&SyncState::Syncing), "syncing");
        assert_eq!(tag_of(&SyncState::Synced), "synced");
        assert_eq!(tag_of(&SyncState::LocalOnly), "local_only");
        assert_eq!(tag_of(&SyncState::Conflict), "conflict");
        assert_eq!(
            tag_of(&SyncState::Error {
                stderr: "boom".into()
            }),
            "error"
        );
    }

    /// `origin_paths` (issue #64) sits alongside `state` rather than inside
    /// the tagged union, so it must serialize as a plain sibling field on
    /// every terminal state, not get swallowed by the enum's own tagging.
    #[test]
    fn sync_status_event_serializes_origin_paths_alongside_state() {
        let event = SyncStatusEvent {
            root_id: "root-1".to_string(),
            state: SyncState::Synced,
            origin_paths: vec!["note.md".to_string(), "folder/other.md".to_string()],
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["root_id"], "root-1");
        assert_eq!(value["state"]["state"], "synced");
        assert_eq!(
            value["origin_paths"],
            serde_json::json!(["note.md", "folder/other.md"])
        );
    }

    /// A bare repo's HEAD follows `init.defaultBranch`, so on a host defaulting
    /// to `master` it would point at a ref these tests never push, leaving
    /// clones with nothing checked out and no upstream branch to merge.
    fn init_bare_remote(dir: &Path) {
        run_git(dir, &["init", "--bare", "--initial-branch=main"]).unwrap();
    }

    /// Commits need an author, and the sandboxed git in CI has no global one.
    fn set_identity(dir: &Path) {
        run_git(dir, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(dir, &["config", "user.name", "Test"]).unwrap();
        // A machine with `commit.gpgsign = true` in its global gitconfig would
        // otherwise have every `git commit` here try to invoke `gpg`/`pinentry`,
        // which can hang indefinitely with no terminal to prompt on. This repo
        // config overrides the global setting for every throwaway repo these
        // tests create.
        run_git(dir, &["config", "commit.gpgsign", "false"]).unwrap();
    }

    /// The branch name is pinned rather than left to `init.defaultBranch`:
    /// these tests push to `refs/heads/main`, so a host defaulting to `master`
    /// would leave the local and upstream branch names mismatched.
    ///
    /// Only for creating a repo. On an existing clone use `set_identity`, since
    /// re-running `git init` there would rename the branch out from under the
    /// upstream tracking the clone already set up.
    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "--initial-branch=main"]).unwrap();
        set_identity(dir);
    }

    fn write_and_stage(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn sync_once_commits_locally_and_reports_local_only_without_remote() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let (state, merged) = sync_once(dir.path(), true, "");

        assert_eq!(state, SyncState::LocalOnly);
        assert!(
            !merged,
            "no remote configured -- there is nothing to merge from"
        );
        let log = run_git(dir.path(), &["log", "--oneline"]).unwrap();
        assert!(log.status.success());
        assert!(!log.stdout.is_empty(), "expected a commit to exist");
    }

    #[test]
    fn sync_once_reports_local_only_when_auto_sync_is_false_even_with_a_remote() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let (state, merged) = sync_once(dir.path(), false, "git@example.com:user/notes.git");

        assert_eq!(state, SyncState::LocalOnly);
        assert!(
            !merged,
            "auto_sync is off -- push (and so merge) never runs"
        );
    }

    #[test]
    fn sync_once_is_a_no_op_success_when_nothing_changed() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");
        sync_once(dir.path(), true, "");

        // Second run: nothing changed since the first commit. `git commit`
        // failing with "nothing to commit" must not surface as SyncState::Error.
        let (state, merged) = sync_once(dir.path(), true, "");

        assert_eq!(state, SyncState::LocalOnly);
        assert!(!merged);
    }

    #[test]
    fn sync_once_pushes_to_a_configured_remote_and_reports_synced() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(dir.path(), "note.md", "hello\n");

        // `git push` needs an upstream on the first push from a fresh repo.
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "seed"]).unwrap();
        let push = run_git(
            dir.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();
        assert!(
            push.status.success(),
            "seed push failed: {}",
            stderr_of(&push)
        );

        write_and_stage(dir.path(), "note2.md", "more\n");
        let (state, merged) = sync_once(dir.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
        assert!(
            !merged,
            "push succeeded on the first try -- no merge needed"
        );
    }

    #[test]
    fn sync_once_merges_and_repushes_after_a_rejected_push() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        // Clone A seeds the remote's initial history.
        let clone_a = TempDir::new().unwrap();
        init_repo(clone_a.path());
        run_git(
            clone_a.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(
            clone_a.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();

        // Clone B clones the same history, then diverges with its own file.
        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                clone_b.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(clone.status.success());
        set_identity(clone_b.path());

        // Clone A pushes a second, unrelated commit that clone B doesn't have.
        write_and_stage(clone_a.path(), "a-only.md", "from a\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "a-only"]).unwrap();
        let push_a = run_git(clone_a.path(), &["push"]).unwrap();
        assert!(push_a.status.success());

        // Clone B now commits its own unrelated file and syncs -- its push
        // should be rejected (remote has diverged), triggering an automatic
        // merge that resolves cleanly since the two commits touch different files.
        write_and_stage(clone_b.path(), "b-only.md", "from b\n");
        let (state, merged) = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
        assert!(
            merged,
            "the first push was rejected, so a merge must have run"
        );
        assert!(
            clone_b.path().join("a-only.md").exists(),
            "merge should have pulled in a's file"
        );
    }

    #[test]
    fn sync_once_reports_conflict_when_the_merge_leaves_markers() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let clone_a = TempDir::new().unwrap();
        init_repo(clone_a.path());
        run_git(
            clone_a.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(
            clone_a.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();

        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                clone_b.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(clone.status.success());
        set_identity(clone_b.path());

        // Clone A edits the same line of the shared file and pushes.
        write_and_stage(clone_a.path(), "shared.md", "base, edited by a\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "a edits shared"]).unwrap();
        let push_a = run_git(clone_a.path(), &["push"]).unwrap();
        assert!(push_a.status.success());

        // Clone B edits the same line differently and syncs -- push is
        // rejected, the automatic merge collides on shared.md, and the chain
        // must report `conflict` rather than force a resolution.
        write_and_stage(clone_b.path(), "shared.md", "base, edited by b\n");
        let (state, merged) = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Conflict);
        assert!(
            merged,
            "the first push was rejected, so a merge must have run"
        );
        assert!(is_merge_in_progress(clone_b.path()));
    }

    /// Puts `dir` into a real mid-merge state with exactly one unmerged file,
    /// `shared.md`, by diverging two clones on the same line and merging.
    fn seed_a_real_merge_conflict(dir: &Path) {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let clone_a = TempDir::new().unwrap();
        init_repo(clone_a.path());
        run_git(
            clone_a.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(
            clone_a.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();

        let clone = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                dir.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(clone.status.success());
        set_identity(dir);

        write_and_stage(clone_a.path(), "shared.md", "base, edited by a\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "a edits shared"]).unwrap();
        assert!(run_git(clone_a.path(), &["push"]).unwrap().status.success());

        write_and_stage(dir, "shared.md", "base, edited by b\n");
        let (state, _merged) = sync_once(dir, true, remote_dir.path().to_str().unwrap());
        assert_eq!(state, SyncState::Conflict);
    }

    #[test]
    fn root_status_reports_conflict_and_the_conflicted_paths_when_merge_head_exists() {
        let dir = TempDir::new().unwrap();
        seed_a_real_merge_conflict(dir.path());

        let status = root_status(dir.path(), Some(SyncState::Synced));

        assert_eq!(status.conflicted_paths, vec!["shared.md".to_string()]);
        assert_eq!(status.sync_state, SyncState::Conflict);
    }

    #[test]
    fn root_status_falls_back_to_local_only_before_any_sync_has_run() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());

        let status = root_status(dir.path(), None);

        assert!(status.conflicted_paths.is_empty());
        assert_eq!(status.sync_state, SyncState::LocalOnly);
    }

    #[test]
    fn root_status_reports_the_last_known_state_when_not_mid_merge() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());

        let status = root_status(dir.path(), Some(SyncState::Synced));

        assert!(status.conflicted_paths.is_empty());
        assert_eq!(status.sync_state, SyncState::Synced);
    }

    #[test]
    fn conflicted_relative_paths_is_empty_when_no_merge_is_in_progress() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        assert!(conflicted_relative_paths(dir.path()).is_empty());
    }

    #[test]
    fn mark_resolved_rejects_a_file_that_still_has_conflict_markers() {
        let dir = TempDir::new().unwrap();
        seed_a_real_merge_conflict(dir.path());
        let absolute_path = dir.path().join("shared.md");
        assert!(fs::read_to_string(&absolute_path)
            .unwrap()
            .contains("<<<<<<<"));

        let result = mark_resolved(dir.path(), "shared.md", &absolute_path, false, "");

        assert!(result.is_err());
        assert!(
            is_merge_in_progress(dir.path()),
            "a rejected mark_resolved must not touch the merge state"
        );
        assert_eq!(
            conflicted_relative_paths(dir.path()),
            vec!["shared.md".to_string()],
            "the file must not be staged when markers remain"
        );
    }

    #[test]
    fn mark_resolved_stages_a_cleaned_file_and_finishes_the_merge_when_it_was_the_last_one() {
        let dir = TempDir::new().unwrap();
        seed_a_real_merge_conflict(dir.path());
        let absolute_path = dir.path().join("shared.md");
        fs::write(&absolute_path, "base, resolved by hand\n").unwrap();

        let outcome = mark_resolved(dir.path(), "shared.md", &absolute_path, false, "").unwrap();

        assert_eq!(outcome.sync_state, SyncState::LocalOnly);
        assert!(
            !is_merge_in_progress(dir.path()),
            "clearing the last conflicted file must finish the merge"
        );
        let log = run_git(dir.path(), &["log", "--oneline", "-1"]).unwrap();
        assert!(!String::from_utf8_lossy(&log.stdout).is_empty());
    }

    #[test]
    fn mark_resolved_leaves_the_merge_open_while_other_conflicted_files_remain() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let clone_a = TempDir::new().unwrap();
        init_repo(clone_a.path());
        run_git(
            clone_a.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(clone_a.path(), "first.md", "base\n");
        write_and_stage(clone_a.path(), "second.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(
            clone_a.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();

        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                clone_b.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(clone.status.success());
        set_identity(clone_b.path());

        // Clone A edits both shared files and pushes.
        write_and_stage(clone_a.path(), "first.md", "base, edited by a\n");
        write_and_stage(clone_a.path(), "second.md", "base, edited by a\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "a edits both"]).unwrap();
        assert!(run_git(clone_a.path(), &["push"]).unwrap().status.success());

        // Clone B edits both the same lines differently -- the merge collides
        // on both files, giving a genuine two-file conflicted merge.
        write_and_stage(clone_b.path(), "first.md", "base, edited by b\n");
        write_and_stage(clone_b.path(), "second.md", "base, edited by b\n");
        let (state, _merged) = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());
        assert_eq!(state, SyncState::Conflict);
        assert_eq!(conflicted_relative_paths(clone_b.path()).len(), 2);

        let first_absolute = clone_b.path().join("first.md");
        fs::write(&first_absolute, "base, resolved by hand\n").unwrap();

        let outcome =
            mark_resolved(clone_b.path(), "first.md", &first_absolute, false, "").unwrap();

        assert_eq!(outcome.sync_state, SyncState::Conflict);
        assert!(
            is_merge_in_progress(clone_b.path()),
            "second.md is still conflicted -- merge must stay open"
        );
        assert_eq!(
            conflicted_relative_paths(clone_b.path()),
            vec!["second.md".to_string()]
        );
    }

    #[test]
    fn mark_resolved_pushes_after_finishing_the_merge_when_a_remote_is_configured() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let clone_a = TempDir::new().unwrap();
        init_repo(clone_a.path());
        run_git(
            clone_a.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(
            clone_a.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();

        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                clone_b.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(clone.status.success());
        set_identity(clone_b.path());

        write_and_stage(clone_a.path(), "shared.md", "base, edited by a\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "a edits shared"]).unwrap();
        assert!(run_git(clone_a.path(), &["push"]).unwrap().status.success());

        write_and_stage(clone_b.path(), "shared.md", "base, edited by b\n");
        let (state, _merged) = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());
        assert_eq!(state, SyncState::Conflict);

        let absolute_path = clone_b.path().join("shared.md");
        fs::write(&absolute_path, "base, resolved by hand\n").unwrap();

        let outcome = mark_resolved(
            clone_b.path(),
            "shared.md",
            &absolute_path,
            true,
            remote_dir.path().to_str().unwrap(),
        )
        .unwrap();

        assert_eq!(outcome.sync_state, SyncState::Synced);
        assert!(!is_merge_in_progress(clone_b.path()));
    }

    #[test]
    fn sync_manager_coalesces_a_trigger_that_arrives_while_busy() {
        // Exercises the coalescing logic directly against the slot rather than
        // through trigger_sync (which needs an AppHandle): a second "trigger"
        // that arrives while busy=true must not create a second queued run --
        // it just flips `pending`, and the run loop consumes it as one extra pass.
        let manager = SyncManager::new();
        let slot = manager.slot_for("root-1");

        *slot.busy.lock().unwrap() = true;

        // Simulate what trigger_sync does when it finds busy already set.
        let mut busy = slot.busy.lock().unwrap();
        assert!(*busy);
        *slot.pending.lock().unwrap() = true;
        drop(busy);

        // A run loop finishing now must see the pending flag and do one more
        // pass instead of clearing busy immediately.
        let pending = {
            let mut pending = slot.pending.lock().unwrap();
            let was_pending = *pending;
            *pending = false;
            was_pending
        };
        assert!(
            pending,
            "expected the trailing trigger to be coalesced as one pending pass"
        );

        busy = slot.busy.lock().unwrap();
        assert!(
            *busy,
            "busy should still be true until the coalesced pass also completes"
        );
    }

    /// Mirrors `sync_manager_coalesces_a_trigger_that_arrives_while_busy`, but
    /// for the origin-path bookkeeping added by issue #64: two triggers
    /// (a save and a plain trigger with no save behind it) that land on the
    /// same queued/coalesced run must both land in the run's origin set, and
    /// draining it for that run must leave the slot empty for the next one.
    #[test]
    fn sync_manager_accumulates_origin_paths_for_the_next_run_and_drains_them_once() {
        let manager = SyncManager::new();
        let slot = manager.slot_for("root-1");

        // Simulates what trigger_sync does on each call: push the origin path
        // (if any) before checking busy.
        slot.next_origin_paths
            .lock()
            .unwrap()
            .push("note.md".to_string());
        slot.next_origin_paths
            .lock()
            .unwrap()
            .push("other.md".to_string());

        // Simulates run_sync_chain's setup: snapshot-and-clear right before a
        // pass starts running.
        let drained = std::mem::take(&mut *slot.next_origin_paths.lock().unwrap());

        assert_eq!(drained, vec!["note.md".to_string(), "other.md".to_string()]);
        assert!(
            slot.next_origin_paths.lock().unwrap().is_empty(),
            "draining for the run that's about to start must not leave stale paths for the next one"
        );
    }

    #[test]
    fn sync_manager_gives_independent_slots_to_different_roots() {
        let manager = SyncManager::new();
        let slot_a = manager.slot_for("root-a");
        let slot_b = manager.slot_for("root-b");

        *slot_a.busy.lock().unwrap() = true;

        assert!(
            !*slot_b.busy.lock().unwrap(),
            "a different root's slot must be unaffected"
        );
    }

    #[test]
    fn sync_manager_returns_the_same_slot_for_the_same_root_id() {
        let manager = Arc::new(SyncManager::new());
        let counter = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let manager = manager.clone();
                let counter = counter.clone();
                thread::spawn(move || {
                    let slot = manager.slot_for("same-root");
                    counter.fetch_add(1, Ordering::SeqCst);
                    slot
                })
            })
            .collect();

        let slots: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        thread::sleep(Duration::from_millis(1));
        assert_eq!(counter.load(Ordering::SeqCst), 8);
        for slot in &slots[1..] {
            assert!(
                Arc::ptr_eq(&slots[0], slot),
                "all callers must get the same slot for one root id"
            );
        }
    }

    /// A real `AppHandle` for `run_startup_catchup`/`trigger_sync` to call
    /// `app.emit(...)` on. The real `Wry` runtime (not `tauri::test`'s
    /// `MockRuntime`) is required here: this crate's `tauri` dependency pulls
    /// in the `wry` feature by default, so every `AppHandle` in `sync.rs` is
    /// concretely `AppHandle<Wry>` -- a `MockRuntime` handle is a different,
    /// incompatible type and would not type-check against `run_startup_catchup`'s
    /// signature. `.any_thread()` is required because `cargo test` runs each
    /// test on its own worker thread, never the process's actual main thread,
    /// and `Wry` otherwise refuses to initialize its event loop off it. Building
    /// the `App` this way needs no display connection since no window is ever
    /// created.
    ///
    /// GTK (which `Wry` initializes under the hood on Linux) can only ever be
    /// initialized once per process, on one thread -- a second `App` built on
    /// a different test's thread panics. So the `App` is built exactly once
    /// and leaked (it's never meant to be torn down in these tests anyway);
    /// every test then clones the same cheap, `Send + Sync` `AppHandle` out of
    /// a `OnceLock` rather than building its own `App`.
    fn mock_app_handle() -> AppHandle {
        static HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
        HANDLE
            .get_or_init(|| {
                let app: tauri::App<tauri::Wry> = tauri::Builder::<tauri::Wry>::new()
                    .any_thread()
                    .build(tauri::test::mock_context(tauri::test::noop_assets()))
                    .unwrap();
                let handle = app.handle().clone();
                Box::leak(Box::new(app));
                handle
            })
            .clone()
    }

    /// Polls `condition` until it's true or `timeout` elapses, for waiting on
    /// `trigger_sync`'s background task (spawned by `run_startup_catchup`)
    /// without a fixed sleep -- fast when the task finishes quickly, bounded
    /// when it doesn't.
    fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if condition() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn remote_log_oneline(remote_dir: &Path) -> String {
        let log = run_git(remote_dir, &["log", "--oneline", "--all"]).unwrap();
        String::from_utf8_lossy(&log.stdout).to_string()
    }

    #[test]
    fn run_startup_catchup_pushes_committed_but_unpushed_commits_to_the_remote() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        // Seed an initial commit pushed with upstream tracking set up, as any
        // root startup catchup runs against would already have from an
        // earlier successful sync -- otherwise a plain `git push` has no
        // upstream to push to regardless of what startup catchup does.
        write_and_stage(dir.path(), "seed.md", "base\n");
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "seed"]).unwrap();
        let seed_push = run_git(
            dir.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();
        assert!(seed_push.status.success());

        write_and_stage(dir.path(), "note.md", "hello\n");
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "unpushed"]).unwrap();
        // Working tree is clean -- the commit above exists locally only, and
        // this is the only thing startup catchup needs to resolve.
        assert!(!remote_log_oneline(remote_dir.path()).contains("unpushed"));

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = RootConfig {
            id: "root-1".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            auto_sync: true,
            remote_url: remote_dir.path().to_str().unwrap().to_string(),
            sync_debounce_secs: 0,
        };

        run_startup_catchup(&app, &manager, vec![root]);

        let pushed = wait_until(Duration::from_secs(5), || {
            remote_log_oneline(remote_dir.path()).contains("unpushed")
        });
        assert!(
            pushed,
            "expected startup catchup to push the unpushed commit to the remote"
        );
    }

    #[test]
    fn run_startup_catchup_commits_a_dirty_working_tree_and_pushes_it() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        // Seed an initial pushed commit so this root has an upstream to push
        // against, then leave the working tree dirty -- the scenario left
        // behind by a quit mid-save or mid-sync-delay (issue #84/#86).
        write_and_stage(dir.path(), "note.md", "hello\n");
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "seed"]).unwrap();
        let seed_push = run_git(
            dir.path(),
            &["push", "-u", "origin", "HEAD:refs/heads/main"],
        )
        .unwrap();
        assert!(seed_push.status.success());

        write_and_stage(dir.path(), "note.md", "hello, edited\n");
        let status = run_git(dir.path(), &["status", "--porcelain"]).unwrap();
        assert!(
            !status.stdout.is_empty(),
            "expected a dirty working tree before startup catchup runs"
        );

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = RootConfig {
            id: "root-1".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            auto_sync: true,
            remote_url: remote_dir.path().to_str().unwrap().to_string(),
            sync_debounce_secs: 0,
        };

        run_startup_catchup(&app, &manager, vec![root]);

        let synced = wait_until(Duration::from_secs(5), || {
            manager.last_known_state("root-1") == Some(SyncState::Synced)
        });
        assert!(
            synced,
            "expected the dirty working tree to be committed and pushed"
        );

        let status_after = run_git(dir.path(), &["status", "--porcelain"]).unwrap();
        assert!(
            status_after.stdout.is_empty(),
            "the dirty change must have been committed"
        );
        assert!(
            remote_log_oneline(remote_dir.path()).contains("note-taker sync"),
            "the commit made from the dirty working tree must have reached the remote"
        );
    }

    #[test]
    fn run_startup_catchup_does_not_push_when_auto_sync_is_disabled() {
        let remote_dir = TempDir::new().unwrap();
        init_bare_remote(remote_dir.path());

        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        write_and_stage(dir.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = RootConfig {
            id: "root-1".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            auto_sync: false,
            remote_url: remote_dir.path().to_str().unwrap().to_string(),
            sync_debounce_secs: 0,
        };

        run_startup_catchup(&app, &manager, vec![root]);

        let committed_locally = wait_until(Duration::from_secs(5), || {
            manager.last_known_state("root-1") == Some(SyncState::LocalOnly)
        });
        assert!(
            committed_locally,
            "expected the dirty working tree to still be committed locally"
        );

        // Give a wrongly-pushing implementation a moment it could use to push
        // before asserting the remote never received anything.
        thread::sleep(Duration::from_millis(200));
        assert!(
            remote_log_oneline(remote_dir.path()).is_empty(),
            "auto_sync is disabled for this root -- startup catchup must not push"
        );
    }

    fn commit_count(repo_path: &Path) -> usize {
        let log = run_git(repo_path, &["log", "--oneline"]).unwrap();
        if !log.status.success() {
            return 0;
        }
        String::from_utf8_lossy(&log.stdout)
            .lines()
            .filter(|line| !line.is_empty())
            .count()
    }

    fn root_config(id: &str, path: &Path, sync_debounce_secs: u32) -> RootConfig {
        RootConfig {
            id: id.to_string(),
            path: path.to_str().unwrap().to_string(),
            auto_sync: false,
            remote_url: String::new(),
            sync_debounce_secs,
        }
    }

    /// Issue #86: `trigger_sync` is the shared immediate primitive behind
    /// every structural mutation and manual sync -- unlike
    /// `trigger_sync_delayed`, it must commit right away regardless of the
    /// root's configured debounce, since none of those triggers have
    /// keystrokes behind them worth coalescing.
    #[test]
    fn trigger_sync_commits_immediately_regardless_of_the_configured_debounce() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        // A generous debounce -- if trigger_sync respected it like
        // trigger_sync_delayed does, the short wait_until bound below would
        // never see a commit.
        let root = root_config("root-1", dir.path(), 5);

        trigger_sync(app, manager, root, None);

        let committed = wait_until(Duration::from_millis(800), || commit_count(dir.path()) == 1);
        assert!(
            committed,
            "trigger_sync must commit almost immediately, with no multi-second wait"
        );
    }

    /// Issue #86's "an immediate trigger arriving while a delay is counting
    /// down does not lose the pending note save": a note save arms
    /// `trigger_sync_delayed`, then before its delay elapses a structural
    /// mutation (e.g. a rename) fires `trigger_sync` directly on the same
    /// root. The immediate call's `git add -A` picks up the note's
    /// already-written content regardless of which call ends up owning the
    /// commit, so the save must never be lost even though its own delayed
    /// call is still pending.
    #[test]
    fn an_immediate_trigger_during_a_pending_delay_still_commits_the_saved_note() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        // Seed an initial commit so the working tree isn't empty at HEAD --
        // matches a real root, where the note already exists before this save.
        write_and_stage(dir.path(), "note.md", "base\n");
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "seed"]).unwrap();

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = root_config("root-1", dir.path(), 5);

        // Simulates a note save: content lands on disk and the save's trigger
        // arms the delay.
        write_and_stage(dir.path(), "note.md", "saved content\n");
        trigger_sync_delayed(
            app.clone(),
            manager.clone(),
            root.clone(),
            Some("note.md".to_string()),
        );

        // Simulates a concurrent structural mutation (e.g. a rename) firing
        // the immediate path before the save's delay has elapsed.
        trigger_sync(app, manager, root, None);

        let committed = wait_until(Duration::from_millis(800), || commit_count(dir.path()) == 1);
        assert!(
            committed,
            "the immediate trigger must commit promptly rather than waiting on the pending delay"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("note.md")).unwrap(),
            "saved content\n",
            "the note's saved content must survive, committed by the immediate trigger"
        );
    }

    #[test]
    fn trigger_sync_delayed_does_not_commit_until_the_delay_elapses() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = root_config("root-1", dir.path(), 1);

        trigger_sync_delayed(app, manager, root, Some("note.md".to_string()));

        assert_eq!(
            commit_count(dir.path()),
            0,
            "the chain must not run before the configured delay elapses"
        );

        let committed = wait_until(Duration::from_secs(5), || commit_count(dir.path()) == 1);
        assert!(
            committed,
            "expected the chain to run once the delay elapsed"
        );
    }

    #[test]
    fn trigger_sync_delayed_restarts_the_countdown_on_a_second_trigger() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());
        let root = root_config("root-1", dir.path(), 2);

        let start = std::time::Instant::now();
        trigger_sync_delayed(app.clone(), manager.clone(), root.clone(), None);

        // Rearm partway through the first countdown -- if this didn't restart
        // it, the chain would run ~2s after `start`; since it does, it must
        // not run until ~2s after this second call instead.
        thread::sleep(Duration::from_millis(800));
        trigger_sync_delayed(app, manager, root, None);

        thread::sleep(Duration::from_millis(1600));
        assert_eq!(
            commit_count(dir.path()),
            0,
            "the second trigger must have restarted the countdown rather than \
             letting the first trigger's original deadline fire"
        );

        let committed = wait_until(Duration::from_secs(5), || commit_count(dir.path()) == 1);
        assert!(committed, "expected exactly one run, after the rearm");
        assert!(
            start.elapsed() >= Duration::from_millis(2400),
            "the chain must not have run before the second trigger's own full delay"
        );
    }

    #[test]
    fn trigger_sync_delayed_defaults_to_the_roots_configured_debounce() {
        let short_dir = TempDir::new().unwrap();
        init_repo(short_dir.path());
        write_and_stage(short_dir.path(), "note.md", "hello\n");

        let long_dir = TempDir::new().unwrap();
        init_repo(long_dir.path());
        write_and_stage(long_dir.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());

        trigger_sync_delayed(
            app.clone(),
            manager.clone(),
            root_config("root-short", short_dir.path(), 1),
            None,
        );
        trigger_sync_delayed(
            app,
            manager,
            root_config("root-long", long_dir.path(), 3),
            None,
        );

        let short_committed_early = wait_until(Duration::from_millis(1500), || {
            commit_count(short_dir.path()) == 1
        });
        assert!(
            short_committed_early,
            "the 1s-delay root should have committed well before the 3s-delay root"
        );
        assert_eq!(
            commit_count(long_dir.path()),
            0,
            "the 3s-delay root must still be waiting out its own configured delay"
        );

        let long_committed = wait_until(Duration::from_secs(5), || {
            commit_count(long_dir.path()) == 1
        });
        assert!(
            long_committed,
            "expected the longer delay to eventually fire"
        );
    }

    #[test]
    fn trigger_sync_delayed_is_independent_per_root() {
        let dir_a = TempDir::new().unwrap();
        init_repo(dir_a.path());
        write_and_stage(dir_a.path(), "note.md", "hello\n");

        let dir_b = TempDir::new().unwrap();
        init_repo(dir_b.path());
        write_and_stage(dir_b.path(), "note.md", "hello\n");

        let app = mock_app_handle();
        let manager = Arc::new(SyncManager::new());

        // Arm root A with a long delay, then root B with a short one -- A's
        // countdown must be untouched by B's trigger on a different root.
        trigger_sync_delayed(
            app.clone(),
            manager.clone(),
            root_config("root-a", dir_a.path(), 3),
            None,
        );
        trigger_sync_delayed(
            app,
            manager.clone(),
            root_config("root-b", dir_b.path(), 1),
            None,
        );

        let b_committed_early = wait_until(Duration::from_millis(1500), || {
            commit_count(dir_b.path()) == 1
        });
        assert!(
            b_committed_early,
            "root B's short delay should resolve on its own schedule"
        );
        assert_eq!(
            commit_count(dir_a.path()),
            0,
            "root A's longer delay must not be affected by root B's trigger"
        );

        let a_committed = wait_until(Duration::from_secs(5), || commit_count(dir_a.path()) == 1);
        assert!(a_committed, "expected root A to eventually commit too");
    }
}
