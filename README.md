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
cd src-tauri && cargo fmt --all --check
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test        # backend + config invariants
```

These same checks run in CI (`.github/workflows/ci.yml`) on every pull request
and on pushes to `main`, on an `ubuntu-26.04` runner so the backend is checked
against the same release the `.deb` is built on.

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

## Releasing

```bash
./scripts/release.sh          # interactive release
./scripts/release.sh --dry-run  # preview without making changes
```

This takes `main` from "commits since the last release" to a published GitHub
release with the `.deb` attached, in one run:

1. Finds the last `vMAJOR.MINOR.PATCH` tag (or treats all commits as the
   release contents if there is none yet), lists the commits since then, and
   proposes the next version from their [Conventional Commits](https://www.conventionalcommits.org/)
   subjects: a breaking change (`!` or a `BREAKING CHANGE:` footer) proposes a
   major bump but always asks rather than assuming `1.0.0`; `feat` proposes a
   minor bump; anything else proposes a patch bump. This mapping applies as-is
   even at `0.x` — a `feat` still bumps the minor, it does not shift down to a
   patch.
2. Asks for confirmation (or a different version) before changing anything.
   Requires an interactive terminal — it will not guess a version
   non-interactively.
3. On confirmation, writes the version to `src-tauri/Cargo.toml`, refreshes
   `src-tauri/Cargo.lock`, and commits the bump.
4. Builds the `.deb` via `scripts/build-deb.sh`. A failed build reverts the
   version-bump commit and stops — no tag or release is created.
5. Tags the bump commit `vMAJOR.MINOR.PATCH`, pushes the commit and tag, and
   creates the GitHub release with the `.deb` attached and the commit list as
   release notes.

Preflight checks (clean working tree, on `main`, up to date with `origin`,
`gh` authenticated) run before anything else, and the script must be run on
Ubuntu 26.04 since it builds through `build-deb.sh`. If a later step fails
(push, tag push, release creation), the script leaves the commit/tag state as
found and prints exactly what happened and how to recover.
