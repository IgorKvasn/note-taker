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

echo
echo "Built packages:"
find src-tauri/target/release/bundle/deb -name '*.deb' -print
