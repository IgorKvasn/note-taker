//! On-demand GitHub release check (issue #52).
//!
//! Deliberately fails silently: any network/parse problem just yields "no
//! update available" rather than surfacing as a user-facing error, since a
//! failed update check must never block or scare a user away from their
//! notes. Failures are still logged to stderr so a terminal-run build stays
//! diagnosable.

use std::time::Duration;

use serde::{Deserialize, Serialize};

const REPO_OWNER: &str = "IgorKvasn";
const REPO_NAME: &str = "note-taker";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// One release as returned by the GitHub API, before filtering.
#[derive(Debug, Clone, Deserialize)]
struct RawRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    html_url: String,
}

/// A release newer than the running version, ready for the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub version: String,
    pub notes: String,
    pub url: String,
}

/// Parses a `vMAJOR.MINOR.PATCH` tag into its numeric parts. Any other shape
/// (missing `v` prefix, non-numeric part, wrong number of parts) is not an
/// error here -- the caller skips it silently, since a hand-written tag that
/// doesn't fit the convention shouldn't ever crash the check.
fn parse_version_tag(tag: &str) -> Option<(u64, u64, u64)> {
    let stripped = tag.strip_prefix('v')?;
    let mut parts = stripped.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Pure filtering/comparison: excludes drafts, prereleases, and unparseable
/// tags, then keeps only releases strictly newer than `current`, sorted
/// newest-first. Kept separate from the HTTP fetch so it is unit-testable
/// against fixture JSON with no network access.
fn select_updates(current: (u64, u64, u64), releases: Vec<RawRelease>) -> Vec<ReleaseInfo> {
    let mut newer: Vec<((u64, u64, u64), ReleaseInfo)> = releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let version = parse_version_tag(&release.tag_name)?;
            Some((version, release))
        })
        .filter(|(version, _)| *version > current)
        .map(|(version, release)| {
            (
                version,
                ReleaseInfo {
                    version: release.tag_name,
                    notes: release.body.unwrap_or_default(),
                    url: release.html_url,
                },
            )
        })
        .collect();

    newer.sort_by(|(a, _), (b, _)| b.cmp(a));
    newer.into_iter().map(|(_, info)| info).collect()
}

/// The running compiled-in version, parsed the same way as a release tag.
/// `CARGO_PKG_VERSION` is guaranteed plain `MAJOR.MINOR.PATCH` (see the
/// `release_version_has_no_prerelease_suffix` test in `lib.rs`), so this never
/// fails in practice; a `None` here just means no release can ever look
/// newer, which is a safe fallback rather than a panic.
fn current_version() -> (u64, u64, u64) {
    parse_version_tag(&format!("v{}", env!("CARGO_PKG_VERSION"))).unwrap_or((0, 0, 0))
}

/// Fetches this repo's releases from GitHub and returns those newer than the
/// running version. Every failure mode -- offline, DNS, timeout, non-2xx,
/// malformed JSON -- is swallowed into an empty `Vec` (spec: "fail silently"),
/// with the reason logged to stderr for diagnosability.
async fn fetch_updates() -> Vec<ReleaseInfo> {
    let url = format!("https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases?per_page=30");
    let user_agent = format!("note-taker/{}", env!("CARGO_PKG_VERSION"));

    let client = match reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(user_agent)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("update check: failed to build HTTP client: {error}");
            return Vec::new();
        }
    };

    let response = match client.get(&url).send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("update check: request failed: {error}");
            return Vec::new();
        }
    };

    if !response.status().is_success() {
        eprintln!("update check: unexpected status {}", response.status());
        return Vec::new();
    }

    let releases: Vec<RawRelease> = match response.json().await {
        Ok(releases) => releases,
        Err(error) => {
            eprintln!("update check: failed to parse response: {error}");
            return Vec::new();
        }
    };

    select_updates(current_version(), releases)
}

/// Tauri command entry point: checks GitHub for a stable release newer than
/// the one currently running. Never returns an `Err` -- see `fetch_updates`.
#[tauri::command]
pub async fn check_for_update() -> Vec<ReleaseInfo> {
    fetch_updates().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, prerelease: bool) -> RawRelease {
        RawRelease {
            tag_name: tag.to_string(),
            draft,
            prerelease,
            body: Some(format!("notes for {tag}")),
            html_url: format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/tag/{tag}"),
        }
    }

    #[test]
    fn parses_a_well_formed_tag() {
        assert_eq!(parse_version_tag("v1.2.3"), Some((1, 2, 3)));
    }

    #[test]
    fn rejects_tags_missing_the_v_prefix_or_with_extra_parts() {
        assert_eq!(parse_version_tag("1.2.3"), None);
        assert_eq!(parse_version_tag("v1.2.3.4"), None);
        assert_eq!(parse_version_tag("v1.2"), None);
        assert_eq!(parse_version_tag("v1.2.beta"), None);
    }

    #[test]
    fn newer_release_is_reported() {
        let releases = vec![release("v1.1.0", false, false)];
        let updates = select_updates((1, 0, 0), releases);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].version, "v1.1.0");
        assert_eq!(updates[0].notes, "notes for v1.1.0");
        assert!(updates[0].url.ends_with("v1.1.0"));
    }

    #[test]
    fn equal_version_reports_no_update() {
        let releases = vec![release("v1.0.0", false, false)];
        assert!(select_updates((1, 0, 0), releases).is_empty());
    }

    #[test]
    fn older_version_reports_no_update() {
        let releases = vec![release("v0.9.0", false, false)];
        assert!(select_updates((1, 0, 0), releases).is_empty());
    }

    #[test]
    fn draft_release_is_excluded() {
        let releases = vec![release("v2.0.0", true, false)];
        assert!(select_updates((1, 0, 0), releases).is_empty());
    }

    #[test]
    fn prerelease_is_excluded() {
        let releases = vec![release("v2.0.0", false, true)];
        assert!(select_updates((1, 0, 0), releases).is_empty());
    }

    #[test]
    fn unparseable_tag_is_skipped_without_failing_the_whole_check() {
        let releases = vec![
            release("nightly-build", false, false),
            release("v1.1.0", false, false),
        ];
        let updates = select_updates((1, 0, 0), releases);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].version, "v1.1.0");
    }

    #[test]
    fn empty_release_list_reports_no_update() {
        assert!(select_updates((1, 0, 0), Vec::new()).is_empty());
    }

    #[test]
    fn multiple_newer_releases_sort_newest_first() {
        let releases = vec![
            release("v1.1.0", false, false),
            release("v1.3.0", false, false),
            release("v1.2.0", false, false),
        ];
        let updates = select_updates((1, 0, 0), releases);
        let versions: Vec<&str> = updates
            .iter()
            .map(|update| update.version.as_str())
            .collect();
        assert_eq!(versions, vec!["v1.3.0", "v1.2.0", "v1.1.0"]);
    }

    #[test]
    fn deserializes_real_github_release_shape() {
        // Fixture trimmed from the GitHub releases-list API response shape,
        // confirming field names/types line up with `RawRelease`.
        let json = r#"[
            {
                "tag_name": "v1.4.0",
                "draft": false,
                "prerelease": false,
                "body": "Release notes here",
                "html_url": "https://github.com/IgorKvasn/note-taker/releases/tag/v1.4.0",
                "name": "v1.4.0",
                "id": 123456
            }
        ]"#;
        let releases: Vec<RawRelease> = serde_json::from_str(json).unwrap();
        let updates = select_updates((1, 0, 0), releases);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].version, "v1.4.0");
    }
}
