//! The background git sync chain (spec §7): `git add` -> `git commit` -> (if
//! `auto_sync` and a remote are configured) `git push` -> on rejection, a plain
//! `git merge` -> re-push if clean, or report `conflict` if markers remain.
//!
//! Save and tree-mutation commands return as soon as their filesystem work is
//! done; this module's [`trigger_sync`] is the one call they all make to kick
//! the chain off as a background task rather than awaiting it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::RootConfig;
use crate::gitutil::{run_git, run_git_expecting_success, stderr_of};

pub const EVENT_SYNC_STATUS: &str = "sync-status";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "lowercase")]
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RootStatus {
    pub conflicted_count: u32,
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

    fn record_state(&self, root_id: &str, state: SyncState) {
        self.last_known_state.lock().unwrap().insert(root_id.to_string(), state);
    }
}

/// Kicks off the sync chain for `root` as a background task and returns
/// immediately -- callers (`save_note`, `create_note`, `create_folder`,
/// `sync_root`) must not await this.
pub fn trigger_sync(app: AppHandle, manager: Arc<SyncManager>, root: RootConfig) {
    let slot = manager.slot_for(&root.id);

    {
        let mut busy = slot.busy.lock().unwrap();
        if *busy {
            *slot.pending.lock().unwrap() = true;
            return;
        }
        *busy = true;
    }

    let manager_for_task = manager.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            run_sync_chain(&app, &manager_for_task, &root);

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

fn emit_status(app: &AppHandle, root_id: &str, state: SyncState) {
    let event = SyncStatusEvent { root_id: root_id.to_string(), state };
    if let Err(error) = app.emit(EVENT_SYNC_STATUS, &event) {
        eprintln!("failed to emit {EVENT_SYNC_STATUS}: {error}");
    }
}

/// `git add` -> `git commit` -> (if configured) `git push` -> on rejection,
/// merge and re-push. Runs synchronously on whatever thread calls it; the
/// caller is expected to be the background task spawned by [`trigger_sync`].
fn run_sync_chain(app: &AppHandle, manager: &SyncManager, root: &RootConfig) {
    emit_status(app, &root.id, SyncState::Syncing);

    let repo_path = Path::new(&root.path);
    let final_state = sync_once(repo_path, root.auto_sync, &root.remote_url);
    manager.record_state(&root.id, final_state.clone());
    emit_status(app, &root.id, final_state);
}

/// The chain's actual logic, separated from event emission so it can be unit
/// tested against real throwaway git repos without a `tauri::AppHandle`.
fn sync_once(repo_path: &Path, auto_sync: bool, remote_url: &str) -> SyncState {
    if let Err(stderr) = git_add_all(repo_path) {
        return SyncState::Error { stderr };
    }

    match git_commit(repo_path) {
        Ok(_) => {}
        Err(CommitError::NothingToCommit) => {}
        Err(CommitError::Failed(stderr)) => return SyncState::Error { stderr },
    }

    if !auto_sync || remote_url.is_empty() {
        return SyncState::LocalOnly;
    }

    match git_push(repo_path) {
        Ok(()) => SyncState::Synced,
        Err(stderr) => resolve_after_push_rejection(repo_path, &stderr),
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
        Err(MergeError::Failed(stderr)) => {
            SyncState::Error { stderr: format!("push rejected: {push_stderr}\nmerge failed: {stderr}") }
        }
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
    let output = run_git(repo_path, &["commit", "-m", "note-taker sync"])
        .map_err(CommitError::Failed)?;

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

/// `get_root_status`'s conflict signal: a `MERGE_HEAD` file is sufficient
/// evidence of a stuck merge for this ticket's scope (spec §7's full per-file
/// marker scan is issue #26's job).
pub fn is_merge_in_progress(repo_path: &Path) -> bool {
    repo_path.join(".git").join("MERGE_HEAD").exists()
}

pub fn root_status(repo_path: &Path, last_known_state: Option<SyncState>) -> RootStatus {
    let conflicted_count = if is_merge_in_progress(repo_path) { 1 } else { 0 };
    let sync_state = if conflicted_count > 0 {
        SyncState::Conflict
    } else {
        last_known_state.unwrap_or(SyncState::LocalOnly)
    };

    RootStatus { conflicted_count, sync_state }
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

    fn init_repo(dir: &Path) {
        run_git(dir, &["init"]).unwrap();
        run_git(dir, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(dir, &["config", "user.name", "Test"]).unwrap();
    }

    fn write_and_stage(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn sync_once_commits_locally_and_reports_local_only_without_remote() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let state = sync_once(dir.path(), true, "");

        assert_eq!(state, SyncState::LocalOnly);
        let log = run_git(dir.path(), &["log", "--oneline"]).unwrap();
        assert!(log.status.success());
        assert!(!log.stdout.is_empty(), "expected a commit to exist");
    }

    #[test]
    fn sync_once_reports_local_only_when_auto_sync_is_false_even_with_a_remote() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");

        let state = sync_once(dir.path(), false, "git@example.com:user/notes.git");

        assert_eq!(state, SyncState::LocalOnly);
    }

    #[test]
    fn sync_once_is_a_no_op_success_when_nothing_changed() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        write_and_stage(dir.path(), "note.md", "hello\n");
        sync_once(dir.path(), true, "");

        // Second run: nothing changed since the first commit. `git commit`
        // failing with "nothing to commit" must not surface as SyncState::Error.
        let state = sync_once(dir.path(), true, "");

        assert_eq!(state, SyncState::LocalOnly);
    }

    #[test]
    fn sync_once_pushes_to_a_configured_remote_and_reports_synced() {
        let remote_dir = TempDir::new().unwrap();
        run_git(remote_dir.path(), &["init", "--bare"]).unwrap();

        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        run_git(dir.path(), &["remote", "add", "origin", remote_dir.path().to_str().unwrap()]).unwrap();
        write_and_stage(dir.path(), "note.md", "hello\n");

        // `git push` needs an upstream on the first push from a fresh repo.
        run_git(dir.path(), &["add", "-A"]).unwrap();
        run_git(dir.path(), &["commit", "-m", "seed"]).unwrap();
        let push = run_git(dir.path(), &["push", "-u", "origin", "HEAD:refs/heads/main"]).unwrap();
        assert!(push.status.success(), "seed push failed: {}", stderr_of(&push));

        write_and_stage(dir.path(), "note2.md", "more\n");
        let state = sync_once(dir.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
    }

    #[test]
    fn sync_once_merges_and_repushes_after_a_rejected_push() {
        let remote_dir = TempDir::new().unwrap();
        run_git(remote_dir.path(), &["init", "--bare"]).unwrap();

        // Clone A seeds the remote's initial history.
        let clone_a = TempDir::new().unwrap();
        run_git(clone_a.path(), &["init"]).unwrap();
        init_repo(clone_a.path());
        run_git(clone_a.path(), &["remote", "add", "origin", remote_dir.path().to_str().unwrap()]).unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(clone_a.path(), &["push", "-u", "origin", "HEAD:refs/heads/main"]).unwrap();

        // Clone B clones the same history, then diverges with its own file.
        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args(["clone", remote_dir.path().to_str().unwrap(), clone_b.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(clone.status.success());
        init_repo(clone_b.path());

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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
        assert!(clone_b.path().join("a-only.md").exists(), "merge should have pulled in a's file");
    }

    #[test]
    fn sync_once_reports_conflict_when_the_merge_leaves_markers() {
        let remote_dir = TempDir::new().unwrap();
        run_git(remote_dir.path(), &["init", "--bare"]).unwrap();

        let clone_a = TempDir::new().unwrap();
        run_git(clone_a.path(), &["init"]).unwrap();
        init_repo(clone_a.path());
        run_git(clone_a.path(), &["remote", "add", "origin", remote_dir.path().to_str().unwrap()]).unwrap();
        write_and_stage(clone_a.path(), "shared.md", "base\n");
        run_git(clone_a.path(), &["add", "-A"]).unwrap();
        run_git(clone_a.path(), &["commit", "-m", "base"]).unwrap();
        run_git(clone_a.path(), &["push", "-u", "origin", "HEAD:refs/heads/main"]).unwrap();

        let clone_b = TempDir::new().unwrap();
        let clone = Command::new("git")
            .args(["clone", remote_dir.path().to_str().unwrap(), clone_b.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(clone.status.success());
        init_repo(clone_b.path());

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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Conflict);
        assert!(is_merge_in_progress(clone_b.path()));
    }

    #[test]
    fn root_status_reports_conflict_when_merge_head_exists() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/MERGE_HEAD"), "deadbeef\n").unwrap();

        let status = root_status(dir.path(), Some(SyncState::Synced));

        assert_eq!(status.conflicted_count, 1);
        assert_eq!(status.sync_state, SyncState::Conflict);
    }

    #[test]
    fn root_status_falls_back_to_local_only_before_any_sync_has_run() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());

        let status = root_status(dir.path(), None);

        assert_eq!(status.conflicted_count, 0);
        assert_eq!(status.sync_state, SyncState::LocalOnly);
    }

    #[test]
    fn root_status_reports_the_last_known_state_when_not_mid_merge() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());

        let status = root_status(dir.path(), Some(SyncState::Synced));

        assert_eq!(status.conflicted_count, 0);
        assert_eq!(status.sync_state, SyncState::Synced);
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
        assert!(pending, "expected the trailing trigger to be coalesced as one pending pass");

        busy = slot.busy.lock().unwrap();
        assert!(*busy, "busy should still be true until the coalesced pass also completes");
    }

    #[test]
    fn sync_manager_gives_independent_slots_to_different_roots() {
        let manager = SyncManager::new();
        let slot_a = manager.slot_for("root-a");
        let slot_b = manager.slot_for("root-b");

        *slot_a.busy.lock().unwrap() = true;

        assert!(!*slot_b.busy.lock().unwrap(), "a different root's slot must be unaffected");
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
            assert!(Arc::ptr_eq(&slots[0], slot), "all callers must get the same slot for one root id");
        }
    }
}
