use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RootConfig {
    pub id: String,
    pub path: String,
    pub auto_sync: bool,
    #[serde(default)]
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub roots: Vec<RootConfig>,
}

/// A root submitted from Settings/first-run before `save_config` commits it.
/// `id` is absent for newly added roots; `save_config` generates one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootDraft {
    pub id: Option<String>,
    pub path: String,
    pub auto_sync: bool,
    #[serde(default)]
    pub remote_url: String,
    /// Set once the user has confirmed creating a missing directory. `save_config`
    /// refuses to `mkdir` without it, so a Save can never silently create a folder
    /// the user didn't ask for.
    #[serde(default)]
    pub create_if_missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ConfigOutcome {
    Missing,
    Invalid { error: String },
    Ok { config: Config },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RootValidation {
    pub exists: bool,
    pub is_writable: bool,
    pub is_git_repo: bool,
    pub has_remote: bool,
    pub remote_url: Option<String>,
}

/// `None` only when the OS cannot resolve a home directory at all, which the
/// `directories` crate treats as an environment fault rather than something
/// `get_config`'s Missing/Invalid/Ok model can distinguish -- e.g. no `$HOME`.
pub fn config_path() -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    Some(base_dirs.config_dir().join("note-taker").join("config.toml"))
}

/// Resolves a root's configured path from its stable ID, as every IPC command
/// addressing a note or directory takes `(root_id, relative_path)` rather than
/// an absolute path (spec §9.2).
pub fn find_root_path(root_id: &str) -> Result<PathBuf, String> {
    let config = match get_config() {
        ConfigOutcome::Ok { config } => config,
        ConfigOutcome::Missing => return Err("no configuration file exists".to_string()),
        ConfigOutcome::Invalid { error } => return Err(error),
    };

    config
        .roots
        .into_iter()
        .find(|root| root.id == root_id)
        .map(|root| PathBuf::from(root.path))
        .ok_or_else(|| format!("no root with id {root_id}"))
}

/// Resolves `(root_id, relative_path)` to an absolute path, rejecting any result
/// that escapes the root -- killing path traversal (`../../.ssh/id_rsa`) as a
/// category rather than a check every command taking a relative path must
/// remember (spec §9.2). Every future command addressing a note or directory
/// inside a root should resolve through this rather than joining paths itself.
pub fn resolve_path_in_root(root_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root_path = find_root_path(root_id)?;

    let canonical_root = root_path
        .canonicalize()
        .map_err(|error| format!("could not resolve root path: {error}"))?;

    let candidate = canonical_root.join(relative_path);

    // `canonicalize` requires the path to exist, which a not-yet-created note
    // wouldn't -- so containment is checked lexically via `components()`
    // instead, which also collapses `.`/`..` without touching the filesystem.
    let mut depth: i32 = 0;
    for component in relative_path.split('/') {
        match component {
            "" | "." => {}
            ".." => depth -= 1,
            _ => depth += 1,
        }
        if depth < 0 {
            return Err(format!("path escapes its root: {relative_path}"));
        }
    }

    Ok(candidate)
}

pub fn get_config() -> ConfigOutcome {
    let Some(config_path) = config_path() else {
        return ConfigOutcome::Invalid {
            error: "could not resolve a home directory for the config file".to_string(),
        };
    };

    let raw = match fs::read_to_string(&config_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return ConfigOutcome::Missing,
        Err(error) => return ConfigOutcome::Invalid { error: error.to_string() },
    };

    match toml::from_str::<Config>(&raw) {
        Ok(config) => ConfigOutcome::Ok { config },
        Err(error) => ConfigOutcome::Invalid { error: error.to_string() },
    }
}

/// Pure read-only probe: touches nothing on disk. Doubles as remote auto-detection,
/// since the same `git remote get-url origin` call that answers `has_remote` also
/// surfaces the URL to pre-fill in the Settings UI.
pub fn validate_root_path(path: &str) -> RootValidation {
    let path = Path::new(path);

    let exists = path.exists();
    let is_writable = exists && path.is_dir() && is_directory_writable(path);
    let is_git_repo = exists && path.join(".git").exists();
    let remote_url = if is_git_repo { git_remote_url(path) } else { None };
    let has_remote = remote_url.is_some();

    RootValidation {
        exists,
        is_writable,
        is_git_repo,
        has_remote,
        remote_url,
    }
}

/// Permission bits can mislead (e.g. read-only filesystems, ACLs), so this probes by
/// actually creating and removing a throwaway file rather than inspecting metadata.
fn is_directory_writable(dir: &Path) -> bool {
    let probe_path = dir.join(format!(".note-taker-write-probe-{}", Ulid::generate()));
    match fs::File::create(&probe_path) {
        Ok(_) => {
            let _ = fs::remove_file(&probe_path);
            true
        }
        Err(_) => false,
    }
}

fn git_remote_url(repo_path: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

#[derive(Debug, Clone)]
pub struct RootDraftError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for RootDraftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

/// Read-only validation for every draft. Returns one error per failing root so a
/// rejected Save can explain all problems at once rather than stopping at the first.
fn validate_drafts(drafts: &[RootDraft]) -> Vec<RootDraftError> {
    let mut errors = Vec::new();

    for draft in drafts {
        let validation = validate_root_path(&draft.path);

        if !validation.exists && !draft.create_if_missing {
            errors.push(RootDraftError {
                path: draft.path.clone(),
                message: "path does not exist and creating it was not confirmed".to_string(),
            });
            continue;
        }

        if validation.exists && !Path::new(&draft.path).is_dir() {
            errors.push(RootDraftError {
                path: draft.path.clone(),
                message: "path exists but is not a directory".to_string(),
            });
            continue;
        }

        if validation.exists && !validation.is_writable {
            errors.push(RootDraftError {
                path: draft.path.clone(),
                message: "path exists but is not writable".to_string(),
            });
        }
    }

    errors
}

fn git_init(repo_path: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("init")
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_set_remote(repo_path: &Path, remote_url: &str, already_has_remote: bool) -> Result<(), String> {
    let subcommand = if already_has_remote { "set-url" } else { "add" };
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["remote", subcommand, "origin", remote_url])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_remove_remote(repo_path: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["remote", "remove", "origin"])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Validate-then-commit: every draft is checked read-only first via
/// [`validate_drafts`], and only if all pass does this perform any side effect. A
/// failure partway through the commit phase (e.g. `git init` fails on root 2) is
/// still possible in principle -- validation and commit are not one atomic
/// filesystem transaction -- but the read-only pre-check eliminates the class of
/// failure the spec calls out: a root failing for a reason `validate_root_path`
/// itself would have caught.
pub fn save_config(drafts: Vec<RootDraft>) -> Result<Config, String> {
    let errors = validate_drafts(&drafts);
    if !errors.is_empty() {
        let message = errors
            .iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("validation failed, no changes were made: {message}"));
    }

    let mut roots = Vec::with_capacity(drafts.len());

    for draft in drafts {
        let path = Path::new(&draft.path);
        let validation = validate_root_path(&draft.path);

        if !validation.exists {
            fs::create_dir_all(path).map_err(|error| error.to_string())?;
        }

        if !validation.is_git_repo {
            git_init(path)?;
        }

        let previous_remote_url = validation.remote_url.unwrap_or_default();
        if draft.remote_url.is_empty() {
            if validation.has_remote {
                git_remove_remote(path)?;
            }
        } else if draft.remote_url != previous_remote_url {
            git_set_remote(path, &draft.remote_url, validation.has_remote)?;
        }

        let id = draft.id.unwrap_or_else(|| Ulid::generate().to_string());

        roots.push(RootConfig {
            id,
            path: draft.path,
            auto_sync: draft.auto_sync,
            remote_url: draft.remote_url,
        });
    }

    let config = Config { version: 1, roots };
    write_config(&config)?;
    Ok(config)
}

fn write_config(config: &Config) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "could not resolve a home directory for the config file".to_string())?;
    let parent = path.parent().expect("config path always has a parent");
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let serialized = toml::to_string_pretty(config).map_err(|error| error.to_string())?;

    // Write to a temp file and rename so a crash mid-write can't leave a
    // truncated/corrupt config.toml behind -- the file that Save is meant to
    // atomically replace.
    let temp_path = path.with_extension("toml.tmp");
    fs::write(&temp_path, serialized).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, &path).map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // `config_path` reads $XDG_CONFIG_HOME through `directories::BaseDirs`, which is
    // process-wide state, so tests that touch it must not run concurrently. Shared
    // with state.rs's tests, which touch the same env var.
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_xdg_config_home<T>(f: impl FnOnce(&Path) -> T) -> T {
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
    fn config_path_resolves_under_xdg_config_home() {
        with_xdg_config_home(|xdg_home| {
            let path = config_path().unwrap();
            assert_eq!(path, xdg_home.join("note-taker").join("config.toml"));
        });
    }

    #[test]
    fn get_config_reports_missing_when_no_file_exists() {
        with_xdg_config_home(|_| {
            assert!(matches!(get_config(), ConfigOutcome::Missing));
        });
    }

    #[test]
    fn get_config_reports_invalid_with_parse_error_on_bad_toml() {
        with_xdg_config_home(|_| {
            let path = config_path().unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "this is not valid toml [[[").unwrap();

            match get_config() {
                ConfigOutcome::Invalid { error } => assert!(!error.is_empty()),
                other => panic!("expected Invalid, got {other:?}"),
            }
        });
    }

    #[test]
    fn config_round_trips_through_write_and_read_preserving_order() {
        with_xdg_config_home(|_| {
            let config = Config {
                version: 1,
                roots: vec![
                    RootConfig {
                        id: "01AAA".to_string(),
                        path: "/home/user/notes".to_string(),
                        auto_sync: true,
                        remote_url: "git@example.com:user/notes.git".to_string(),
                    },
                    RootConfig {
                        id: "01BBB".to_string(),
                        path: "/home/user/work-notes".to_string(),
                        auto_sync: false,
                        remote_url: String::new(),
                    },
                ],
            };

            write_config(&config).unwrap();

            match get_config() {
                ConfigOutcome::Ok { config: read_back } => assert_eq!(read_back, config),
                other => panic!("expected Ok, got {other:?}"),
            }
        });
    }

    #[test]
    fn validate_root_path_reports_nonexistent_path() {
        let validation = validate_root_path("/this/path/does/not/exist/hopefully");
        assert!(!validation.exists);
        assert!(!validation.is_writable);
        assert!(!validation.is_git_repo);
        assert!(!validation.has_remote);
    }

    #[test]
    fn validate_root_path_reports_existing_non_repo_directory() {
        let temp_dir = TempDir::new().unwrap();
        let validation = validate_root_path(temp_dir.path().to_str().unwrap());

        assert!(validation.exists);
        assert!(validation.is_writable);
        assert!(!validation.is_git_repo);
        assert!(!validation.has_remote);
    }

    #[test]
    fn validate_root_path_detects_git_repo_and_remote() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path();
        git_init(path).unwrap();
        git_set_remote(path, "git@example.com:user/notes.git", false).unwrap();

        let validation = validate_root_path(path.to_str().unwrap());

        assert!(validation.is_git_repo);
        assert!(validation.has_remote);
        assert_eq!(
            validation.remote_url,
            Some("git@example.com:user/notes.git".to_string())
        );
    }

    #[test]
    fn validate_root_path_reports_repo_without_remote() {
        let temp_dir = TempDir::new().unwrap();
        git_init(temp_dir.path()).unwrap();

        let validation = validate_root_path(temp_dir.path().to_str().unwrap());

        assert!(validation.is_git_repo);
        assert!(!validation.has_remote);
        assert_eq!(validation.remote_url, None);
    }

    #[test]
    fn save_config_rejects_all_roots_when_one_is_invalid() {
        with_xdg_config_home(|_| {
            let valid_dir = TempDir::new().unwrap();

            let drafts = vec![
                RootDraft {
                    id: None,
                    path: valid_dir.path().to_str().unwrap().to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                    create_if_missing: false,
                },
                RootDraft {
                    id: None,
                    path: "/this/path/does/not/exist/hopefully".to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                    create_if_missing: false,
                },
            ];

            let result = save_config(drafts);

            assert!(result.is_err());
            assert!(
                !valid_dir.path().join(".git").exists(),
                "root 1 must not be git-init'd when root 2 fails validation"
            );
            assert!(
                matches!(get_config(), ConfigOutcome::Missing),
                "no config.toml should be written on a rejected save"
            );
        });
    }

    #[test]
    fn save_config_removes_the_git_remote_when_the_field_is_cleared() {
        with_xdg_config_home(|_| {
            let root_dir = TempDir::new().unwrap();
            git_init(root_dir.path()).unwrap();
            git_set_remote(root_dir.path(), "git@example.com:user/notes.git", false).unwrap();

            let drafts = vec![RootDraft {
                id: None,
                path: root_dir.path().to_str().unwrap().to_string(),
                auto_sync: false,
                remote_url: String::new(),
                create_if_missing: false,
            }];

            save_config(drafts).expect("save should succeed");

            assert_eq!(git_remote_url(root_dir.path()), None);
        });
    }

    #[test]
    fn find_root_path_resolves_a_configured_root_by_id() {
        with_xdg_config_home(|_| {
            let config = Config {
                version: 1,
                roots: vec![RootConfig {
                    id: "01AAA".to_string(),
                    path: "/home/user/notes".to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                }],
            };
            write_config(&config).unwrap();

            let path = find_root_path("01AAA").unwrap();
            assert_eq!(path, PathBuf::from("/home/user/notes"));
        });
    }

    #[test]
    fn find_root_path_errors_on_unknown_id() {
        with_xdg_config_home(|_| {
            let config = Config { version: 1, roots: vec![] };
            write_config(&config).unwrap();

            assert!(find_root_path("nonexistent").is_err());
        });
    }

    #[test]
    fn resolve_path_in_root_joins_a_relative_path_onto_the_root() {
        with_xdg_config_home(|_| {
            let root_dir = TempDir::new().unwrap();
            let config = Config {
                version: 1,
                roots: vec![RootConfig {
                    id: "01AAA".to_string(),
                    path: root_dir.path().to_str().unwrap().to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                }],
            };
            write_config(&config).unwrap();

            let resolved = resolve_path_in_root("01AAA", "folder/note.md").unwrap();
            assert_eq!(
                resolved,
                root_dir.path().canonicalize().unwrap().join("folder/note.md")
            );
        });
    }

    #[test]
    fn resolve_path_in_root_rejects_traversal_above_the_root() {
        with_xdg_config_home(|_| {
            let root_dir = TempDir::new().unwrap();
            let config = Config {
                version: 1,
                roots: vec![RootConfig {
                    id: "01AAA".to_string(),
                    path: root_dir.path().to_str().unwrap().to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                }],
            };
            write_config(&config).unwrap();

            assert!(resolve_path_in_root("01AAA", "../../.ssh/id_rsa").is_err());
        });
    }

    #[test]
    fn resolve_path_in_root_rejects_traversal_that_dips_below_zero_before_recovering() {
        with_xdg_config_home(|_| {
            let root_dir = TempDir::new().unwrap();
            let config = Config {
                version: 1,
                roots: vec![RootConfig {
                    id: "01AAA".to_string(),
                    path: root_dir.path().to_str().unwrap().to_string(),
                    auto_sync: false,
                    remote_url: String::new(),
                }],
            };
            write_config(&config).unwrap();

            // Escapes above the root and comes back down -- still a traversal attempt,
            // so it must be rejected even though the final depth looks non-negative.
            assert!(resolve_path_in_root("01AAA", "a/../../b").is_err());
        });
    }

    #[test]
    fn save_config_commits_all_side_effects_when_every_root_is_valid() {
        with_xdg_config_home(|_| {
            let root_dir = TempDir::new().unwrap();
            let missing_dir = root_dir.path().join("new-root");

            let drafts = vec![RootDraft {
                id: None,
                path: missing_dir.to_str().unwrap().to_string(),
                auto_sync: true,
                remote_url: String::new(),
                create_if_missing: true,
            }];

            let config = save_config(drafts).expect("save should succeed");

            assert!(missing_dir.exists());
            assert!(missing_dir.join(".git").exists());
            assert_eq!(config.roots.len(), 1);
            assert!(!config.roots[0].id.is_empty());

            match get_config() {
                ConfigOutcome::Ok { config: read_back } => assert_eq!(read_back, config),
                other => panic!("expected Ok, got {other:?}"),
            }
        });
    }
}
