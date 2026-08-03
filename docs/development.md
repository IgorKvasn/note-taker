# Development

Building, testing, packaging, and releasing note-taker. For what the app does,
see the [README](../README.md); for the design reasoning and accepted gaps, see
[`spec.md`](spec.md).

## Stack

| | |
|---|---|
| Shell | Tauri v2, Rust backend |
| Frontend | React 19, built-in state only — `useState`/`useContext`/`useReducer`, no Zustand or Redux |
| Editor | CodeMirror 6, hand-rolled ref/`useEffect` wrapper rather than `@uiw/react-codemirror` |
| View | `react-markdown` + `remark-gfm` + `rehype-sanitize` + `rehype-highlight` |
| Sync | System `git` binary, shelled out from Rust |
| Packaging | `.deb` via `tauri build` |
| Platform | Ubuntu 26.04 only |

The CodeMirror wrapper is deliberately hand-written: the formatting toolbar
dispatches CM6 transactions directly, and a wrapper library would be an
abstraction to reach through.

`rehype-sanitize` runs on every render and is not optional — notes arrive from
other machines over git, so rendered note content is treated as untrusted.

Notes carry a ULID in YAML frontmatter, assigned at creation and backfilled on
first open for files that arrive via git without one — never during the tree
walk, which stays read-only. Titles are normalized to NFC to avoid NFC/NFD
mismatches that would read as duplicates or churn across machines.

Roots are validated as a set and committed atomically — either every root is
valid and `config.toml` is written, or nothing changes. UI state lives separately
in `state.toml` and falls back to defaults if missing or corrupt.

Sync is per root by design: roots sync in parallel, a single root serializes,
rapid saves coalesce into one pass per root, and startup runs a catch-up pass.
There is deliberately no global sync indicator, since an app-wide status would
imply a state that does not exist. Merges are plain merges, never rebases.

## Setup

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

The same checks run in CI (`.github/workflows/ci.yml`) on every pull request and
on pushes to `main`, on an `ubuntu-26.04` runner so the backend is checked
against the same release the `.deb` is built on. Pull requests additionally get
their commit messages linted against
[Conventional Commits](https://www.conventionalcommits.org/).

## Packaging

```bash
./scripts/build-deb.sh
```

Releases must be built on **Ubuntu 26.04**, the only supported release. The
`.deb` links against 26.04's glibc and is *not* installable on 22.04 or 24.04;
those releases are supported neither as build hosts nor as install targets. The
script therefore fails on a non-26.04 host — set `ALLOW_ANY_UBUNTU=1` to build
anyway for local testing, but the artifact is not releasable. It also inspects
the built package's `Depends:` line, requiring `git`, `libwebkit2gtk-4.1-0` and
`libgtk-3-0` to all be present, and rejecting any name that appears twice. Only
`git` is declared in `tauri.conf.json` — Tauri injects the webkit and GTK pair
itself, so declaring them there as well is what would produce the duplicates.

The version lives in `src-tauri/Cargo.toml` only and is deliberately omitted
from `tauri.conf.json` so the two cannot drift. Ship plain
`MAJOR.MINOR.PATCH` versions — Debian reads the hyphen in `1.0.0-beta.1` as a
`debian_revision` and sorts it *newer* than `1.0.0`, inverted from semver.

## Releasing

```bash
./scripts/release.sh            # interactive release
./scripts/release.sh --dry-run  # preview without making changes
```

This takes `main` from "commits since the last release" to a published GitHub
release with the `.deb` attached, in one run:

1. Finds the last `vMAJOR.MINOR.PATCH` tag (or treats all commits as the release
   contents if there is none yet), lists the commits since then, and proposes the
   next version from their Conventional Commits subjects: a breaking change (`!`
   or a `BREAKING CHANGE:` footer) proposes a major bump but always asks rather
   than assuming `1.0.0`; `feat` proposes a minor bump; anything else proposes a
   patch bump. This mapping applies as-is even at `0.x` — a `feat` still bumps
   the minor, it does not shift down to a patch.
2. Asks for confirmation (or a different version) before changing anything.
   Requires an interactive terminal — it will not guess a version
   non-interactively.
3. On confirmation, writes the version to `src-tauri/Cargo.toml`, refreshes
   `src-tauri/Cargo.lock`, and commits the bump.
4. Builds the `.deb` via `scripts/build-deb.sh`. A failed build reverts the
   version-bump commit and stops — no tag or release is created.
5. Tags the bump commit `vMAJOR.MINOR.PATCH`, then pushes the branch, pushes the
   tag, and creates the GitHub release with the `.deb` attached and the commit
   list as release notes. These are separately guarded steps, each with its own
   recovery message.

Preflight checks (clean working tree, on `main`, up to date with `origin`, `gh`
authenticated) run before anything else, and the script must be run on Ubuntu
26.04 since it builds through `build-deb.sh`. If a later step fails (push, tag
push, release creation), the script leaves the commit and tag state as found and
prints exactly what happened and how to recover.
