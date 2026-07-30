# note-taker

A Linux desktop note-taking app. Notes are plain `.md` files organized in
directories under one or more configurable root folders, each an independent git
repository synced to its own remote.

See [`docs/spec.md`](docs/spec.md) for the full implementation spec.

## Stack

Tauri v2 (Rust backend) + React with built-in state only — no Zustand or Redux.

## Development

```bash
npm install
npm run tauri dev
```

Build requirements on Ubuntu 26.04:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev build-essential curl file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Checks

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # vitest
cd src-tauri && cargo test        # backend + config invariants
```

## Packaging

```bash
./scripts/build-deb.sh
```

Releases must be built on **Ubuntu 26.04**, the only supported release. The
`.deb` links against 26.04's glibc and is *not* installable on 22.04 or 24.04;
those releases are no longer supported as build hosts or install targets. The
script therefore fails on a non-26.04 host — set `ALLOW_ANY_UBUNTU=1` to build
anyway for local testing, but the artifact is not releasable.

The version lives in `src-tauri/Cargo.toml` only and is deliberately omitted from
`tauri.conf.json`. Ship plain `MAJOR.MINOR.PATCH` versions — Debian reads the
hyphen in `1.0.0-beta.1` as a `debian_revision` and sorts it *newer* than
`1.0.0`, inverted from semver.
