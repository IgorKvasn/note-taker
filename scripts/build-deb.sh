#!/usr/bin/env bash
# Builds the .deb via Tauri's bundler. Releases must be built on Ubuntu 26.04,
# the only supported release; see README.md for why.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH" >&2
  exit 1
fi

ubuntu_version="$(lsb_release -rs 2>/dev/null || echo unknown)"
if [[ "$ubuntu_version" != "26.04" ]]; then
  if [[ "${ALLOW_ANY_UBUNTU:-}" == "1" ]]; then
    echo "warning: building on Ubuntu ${ubuntu_version} (ALLOW_ANY_UBUNTU=1);" >&2
    echo "         the resulting .deb is not releasable." >&2
  else
    echo "error: releases must be built on Ubuntu 26.04, but this host reports" >&2
    echo "       ${ubuntu_version}. The .deb links against 26.04's glibc, so" >&2
    echo "       building elsewhere produces an artifact we do not support." >&2
    echo "       Set ALLOW_ANY_UBUNTU=1 to build anyway for local testing." >&2
    exit 1
  fi
fi

npm ci
npm run test
npm run tauri build -- --bundles deb

deb_path="$(find src-tauri/target/release/bundle/deb -name '*.deb' -print -quit 2>/dev/null || true)"
if [[ -z "$deb_path" ]]; then
  echo "error: no .deb produced under src-tauri/target/release/bundle/deb" >&2
  exit 1
fi

# tauri-cli's Linux bundling appends libwebkit2gtk-4.1-0 and libgtk-3-0 to
# bundle.linux.deb.depends with no dedup (tauri-cli 2.11.4/2.11.5), so any
# overlap between our config and its auto-injected pair would silently
# double an entry in the shipped control file. Check the real artifact,
# since that's the only place the two lists actually merge.
depends_line="$(dpkg-deb -f "$deb_path" Depends)"
echo "Depends: $depends_line"

IFS=',' read -r -a depends_raw <<<"$depends_line"
depends_names=()
for entry in "${depends_raw[@]}"; do
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  depends_names+=("${entry%% *}")
done

duplicates="$(printf '%s\n' "${depends_names[@]}" | sort | uniq -d)"
if [[ -n "$duplicates" ]]; then
  echo "error: duplicate entries in Depends: $duplicates" >&2
  exit 1
fi

# libgtk-3-0 is a virtual package on 26.04, satisfied only by libgtk-3-0t64's
# `Provides` -- a name match here does not prove the .deb installs. See spec.md §10.
for required in libwebkit2gtk-4.1-0 libgtk-3-0 git; do
  found=0
  for name in "${depends_names[@]}"; do
    [[ "$name" == "$required" ]] && found=1 && break
  done
  if [[ "$found" -eq 0 ]]; then
    echo "error: Depends is missing required package: $required" >&2
    exit 1
  fi
done

echo
echo "Built packages:"
echo "$deb_path"
