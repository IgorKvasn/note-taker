//! Shared shelling-out-to-`git` plumbing used by both [`crate::config`] (repo
//! setup/remote management) and [`crate::sync`] (the background sync chain).
//! The app stores no credentials and implements no auth mechanism (spec §7):
//! every call here just inherits the invoking process's environment.

use std::path::Path;
use std::process::{Command, Output};

pub fn run_git(repo_path: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|error| error.to_string())
}

pub fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

/// Runs `git` with `args` and collapses a non-zero exit into `Err(stderr)` --
/// the shape every fire-and-forget git call (`init`, `add`, `commit`, `push`,
/// `remote add`/`set-url`/`remove`) reduces to.
pub fn run_git_expecting_success(repo_path: &Path, args: &[&str]) -> Result<(), String> {
    let output = run_git(repo_path, args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(stderr_of(&output))
    }
}
