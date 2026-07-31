#!/usr/bin/env bash
# Takes commits on main to a published GitHub release with the .deb attached:
# proposes the next semver version from Conventional Commits since the last
# release tag, builds the .deb via build-deb.sh, then tags and publishes.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

export GIT_PAGER=cat

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: $0 [--dry-run]" >&2
      exit 1
      ;;
  esac
done

# --- Preflight ---------------------------------------------------------

for tool in git gh cargo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found on PATH" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated; run 'gh auth login' first" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash changes first" >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "main" ]]; then
  echo "error: must be on main, but current branch is $current_branch" >&2
  exit 1
fi

git fetch origin main
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [[ "$local_head" != "$remote_head" ]]; then
  echo "error: main is not up to date with origin/main" >&2
  echo "       local:  $local_head" >&2
  echo "       origin: $remote_head" >&2
  exit 1
fi

# --- 1. Determine and confirm the next version --------------------------

cargo_toml="src-tauri/Cargo.toml"

current_version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$cargo_toml" | head -1)"
if [[ -z "$current_version" ]]; then
  echo "error: could not find version in $cargo_toml" >&2
  exit 1
fi

last_tag="$(git tag -l 'v*' --sort=-v:refname | head -1)"
if [[ -n "$last_tag" ]]; then
  echo "Last release tag: $last_tag"
  commit_range="${last_tag}..HEAD"
else
  echo "No previous release tag found; this will be the first release."
  commit_range="HEAD"
fi

commit_subjects="$(git log --format='%s' "$commit_range")"
if [[ -z "$commit_subjects" ]]; then
  echo "error: no commits since $last_tag; nothing to release" >&2
  exit 1
fi

release_notes="$(git log --format='- %s' "$commit_range")"

echo
echo "Commits since ${last_tag:-the beginning of history}:"
git log --format='  %h %s' "$commit_range"
echo

# Classify the bump level implied by Conventional Commits subjects/bodies.
# Anything that doesn't parse as a recognized type is treated as the most
# conservative level (patch), which also covers pre-commitlint history.
has_breaking=0
has_feat=0
breaking_re='^[a-zA-Z]+(\([^)]*\))?!:'
feat_re='^feat(\([^)]*\))?: '
while IFS= read -r subject; do
  if [[ "$subject" =~ $breaking_re ]]; then
    has_breaking=1
  elif [[ "$subject" =~ $feat_re ]]; then
    has_feat=1
  fi
done <<<"$commit_subjects"

if git log --format='%B' "$commit_range" | grep -qE '^BREAKING[ -]CHANGE:'; then
  has_breaking=1
fi

IFS='.' read -r current_major current_minor current_patch <<<"$current_version"

if [[ "$has_breaking" -eq 1 ]]; then
  echo "Breaking change detected (commit with '!' or a 'BREAKING CHANGE:' footer)."
  echo "A 0.x -> 1.0.0 jump is a product decision, not something this script"
  echo "infers automatically. Current version: $current_version."
  proposed_version=""
elif [[ "$has_feat" -eq 1 ]]; then
  proposed_version="${current_major}.$((current_minor + 1)).0"
else
  proposed_version="${current_major}.${current_minor}.$((current_patch + 1))"
fi

if [[ -n "$proposed_version" ]]; then
  echo "Proposed next version: $current_version -> $proposed_version"
else
  echo "Proposed next version: (none -- see breaking-change note above)"
fi
echo

if [[ "$dry_run" -eq 1 ]]; then
  echo "--dry-run: stopping before confirmation. No changes made."
  exit 0
fi

if [[ ! -t 0 ]]; then
  echo "error: not running interactively; refusing to guess a version." >&2
  echo "       Run this script from an interactive terminal." >&2
  exit 1
fi

read -r -p "Enter version to release [${proposed_version}]: " next_version
next_version="${next_version:-$proposed_version}"

if [[ -z "$next_version" ]]; then
  echo "error: no version given; aborting" >&2
  exit 1
fi

if [[ ! "$next_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: '$next_version' is not a plain MAJOR.MINOR.PATCH version" >&2
  exit 1
fi

next_tag="v${next_version}"
if git rev-parse -q --verify "refs/tags/${next_tag}" >/dev/null; then
  echo "error: tag $next_tag already exists" >&2
  exit 1
fi

echo
read -r -p "Release ${next_tag}? [y/N] " confirmation
if [[ ! "$confirmation" =~ ^[yY]$ ]]; then
  echo "Aborted; no changes made."
  exit 1
fi

# --- Bump the version and commit ----------------------------------------

warn_bump_failed() {
  echo "error: failed while bumping the version, before a bump commit was made." >&2
  echo "       Working tree may have uncommitted changes to $cargo_toml and/or" >&2
  echo "       src-tauri/Cargo.lock. Nothing was committed, tagged, or pushed." >&2
  echo "       Inspect with 'git status' / 'git diff', then run" >&2
  echo "       'git checkout -- $cargo_toml src-tauri/Cargo.lock' to discard." >&2
}
trap warn_bump_failed EXIT

sed -i "0,/^version = \".*\"/s//version = \"${next_version}\"/" "$cargo_toml"
(cd src-tauri && cargo update -p note-taker)

git add "$cargo_toml" src-tauri/Cargo.lock
git commit -m "chore(release): ${next_tag}"
bump_commit="$(git rev-parse HEAD)"
trap - EXIT

cleanup_failed_bump() {
  echo "error: build failed; reverting the local version-bump commit ($bump_commit)." >&2
  echo "       Nothing was pushed or tagged." >&2
  git reset --hard "${local_head}"
}

# --- 2. Build the .deb ----------------------------------------------------

echo
echo "Building .deb via scripts/build-deb.sh..."
build_log="$(mktemp)"
trap 'rm -f "$build_log"' EXIT

if ! ./scripts/build-deb.sh | tee "$build_log"; then
  cleanup_failed_bump
  exit 1
fi

deb_path="$(tail -1 "$build_log")"
if [[ -z "$deb_path" || ! -f "$deb_path" ]]; then
  echo "error: could not determine .deb path from build-deb.sh output" >&2
  cleanup_failed_bump
  exit 1
fi

# --- 3. Tag and publish -----------------------------------------------------

git tag -a "$next_tag" -m "$next_tag" "$bump_commit"

if ! git push origin "$current_branch"; then
  echo "error: failed to push $current_branch to origin." >&2
  echo "       The version-bump commit ($bump_commit) and tag $next_tag exist" >&2
  echo "       locally but are not pushed. Push manually once fixed, or run" >&2
  echo "       'git tag -d $next_tag && git reset --hard $local_head' to undo." >&2
  exit 1
fi

if ! git push origin "$next_tag"; then
  echo "error: failed to push tag $next_tag to origin." >&2
  echo "       The commit was pushed to main, but the tag was not. Push it" >&2
  echo "       manually with 'git push origin $next_tag' once fixed, or" >&2
  echo "       delete it locally with 'git tag -d $next_tag'." >&2
  exit 1
fi

if ! gh release create "$next_tag" "$deb_path" \
  --title "$next_tag" \
  --notes "$release_notes"; then
  echo "error: failed to create the GitHub release." >&2
  echo "       Tag $next_tag is pushed and the commit is on main, but no" >&2
  echo "       release was created. Fix the issue and run:" >&2
  echo "         gh release create $next_tag $deb_path --title $next_tag --notes '...'" >&2
  exit 1
fi

echo
echo "Released ${next_tag}."
