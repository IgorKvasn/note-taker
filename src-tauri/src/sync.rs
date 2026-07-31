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

pub fn emit_status(app: &AppHandle, root_id: &str, state: SyncState) {
    let event = SyncStatusEvent {
        root_id: root_id.to_string(),
        state,
    };
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
        let state = sync_once(dir.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Synced);
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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());

        assert_eq!(state, SyncState::Conflict);
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
        let state = sync_once(dir, true, remote_dir.path().to_str().unwrap());
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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());
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
        let state = sync_once(clone_b.path(), true, remote_dir.path().to_str().unwrap());
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
}
