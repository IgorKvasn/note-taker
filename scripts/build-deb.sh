#!/usr/bin/env bash
# Builds the .deb via Tauri's bundler. Releases must be built on Ubuntu 22.04;
# see README.md for why.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH" >&2
  exit 1
fi

ubuntu_version="$(lsb_release -rs 2>/dev/null || echo unknown)"
if [[ "$ubuntu_version" != "22.04" ]]; then
  echo "warning: building on Ubuntu ${ubuntu_version}, but releases must be built" >&2
  echo "         on 22.04 to stay installable on both 22.04 and 24.04." >&2
fi

npm ci
npm run test
npm run tauri build -- --bundles deb

deb_path="$(find src-tauri/target/release/bundle/deb -name '*.deb' -print -quit)"
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

IFS=', ' read -r -a depends_entries <<<"$depends_line"
duplicates="$(printf '%s\n' "${depends_entries[@]}" | sort | uniq -d)"
if [[ -n "$duplicates" ]]; then
  echo "error: duplicate entries in Depends: $duplicates" >&2
  exit 1
fi

for required in libwebkit2gtk-4.1-0 libgtk-3-0 git; do
  found=0
  for entry in "${depends_entries[@]}"; do
    [[ "$entry" == "$required" ]] && found=1 && break
  done
  if [[ "$found" -eq 0 ]]; then
    echo "error: Depends is missing required package: $required" >&2
    exit 1
  fi
done

echo
echo "Built packages:"
echo "$deb_path"
