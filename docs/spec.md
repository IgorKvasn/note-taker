# note-taker — implementation spec

A Linux/Ubuntu desktop note-taking app. Notes are plain `.md` files organized in directories under one or more configurable root folders, each an independent git repository synced to its own remote.

This document consolidates the 13 decisions charted on [Map: Note-taking app spec](https://github.com/IgorKvasn/note-taker/issues/1). Each section cites the ticket that owns the decision; those tickets hold the rejected alternatives and rationale, which are not repeated here. Where a ticket was later amended, only the final form appears below.

**Status:** every decision is locked. Nothing in this document is an open question.

---

## 1. Stack and platform

| | |
|---|---|
| Shell | Tauri v2 (Rust backend) |
| Frontend | React, built-in state only — `useState`/`useContext`/`useReducer`, no Zustand/Redux ([#6](https://github.com/IgorKvasn/note-taker/issues/6)) |
| Editor | CodeMirror 6, integrated via a direct custom ref/`useEffect` wrapper — no `@uiw/react-codemirror` ([#6](https://github.com/IgorKvasn/note-taker/issues/6)) |
| View-mode renderer | `react-markdown` + `remark-gfm` + `rehype-sanitize` + `rehype-highlight` ([#4](https://github.com/IgorKvasn/note-taker/issues/4)) |
| Storage | Plain `.md` files, filename = title ([#3](https://github.com/IgorKvasn/note-taker/issues/3)) |
| Sync | System `git` binary, shelled out from Rust ([#7](https://github.com/IgorKvasn/note-taker/issues/7)) |
| Packaging | `.deb` via `tauri build` ([#13](https://github.com/IgorKvasn/note-taker/issues/13)) |
| Platform | Ubuntu 26.04 only ([#35](https://github.com/IgorKvasn/note-taker/issues/35)) |

The CM6 wrapper is deliberately hand-rolled: the formatting toolbar (§5) dispatches CM6 transactions directly, and a wrapper library would be an abstraction to reach through ([#6](https://github.com/IgorKvasn/note-taker/issues/6)).

---

## 2. Layout

Two panes, one split ratio.

- **Left** — one collapsible top-level section per configured root, labeled with the root's own folder name. No merging across roots. A search input is pinned above the tree and replaces the tree with results while active (§8).
- **Right** — the open note: CodeMirror editor with a formatting toolbar, or rendered markdown view. One note at a time.

**Chrome** ([#10](https://github.com/IgorKvasn/note-taker/issues/10)): native Tauri menu bar, flat — **Settings**, **About**, **Quit** as single top-level actions, no submenus. About opens a modal showing the app version. OS-native title bar, not frameless. No global sync indicator — sync is per-root, so a single app-wide status would imply a state that doesn't exist; the per-root tree indicator (§7) is the only sync surface.

---

## 3. Note identity

Every note carries a **stable ID in YAML frontmatter** alongside its path ([#3](https://github.com/IgorKvasn/note-taker/issues/3)). The path is the display identity and what git tracks; the ID survives renames and moves.

```markdown
---
id: 01J8X...
---
```

- **Format** — ULID or UUIDv7 (lexicographically sortable by creation time).
- **Assignment** — on creation, by `create_note`. Every note the app creates has an ID from birth.
- **Backfill** — files arriving via git without an ID get one written by `open_note`, never during the tree walk (§9.5).
- No sidecar index: the ID lives in the file, so it cannot desync from it.

### Title rules

Titles are filenames, so they are constrained by the filesystem:

- **Duplicate titles** — blocked with an inline error, scoped **per root** (independent vaults may reuse a title).
- **Invalid characters** (`/`, `\`, `:`, control chars) — blocked with an inline error. No silent sanitization.
- **Unicode** — normalized to **NFC** before use as a filename, avoiding NFC/NFD mismatches that would read as duplicates or produce cross-machine git churn.
- **Rename and move** — staged as `git mv`, preserving history and `git log --follow`. The frontmatter ID is untouched. Destination-directory duplicate and character checks apply.

---

## 4. Directory tree

All decisions from [#2](https://github.com/IgorKvasn/note-taker/issues/2), applied within each root's section.

- **Create** — context menu only. On a folder → inside it; on a note → sibling in its parent; on empty space → at that root's top level. A new item appears as an inline editable field immediately (VS Code style); Enter confirms, Escape discards.
- **Rename** — context menu or F2 on selection, same inline field.
- **Delete** — always confirmed by dialog. Permanent; no app-level trash. Folder deletion states how many notes and subfolders will go. Recovery is via git history.
- **Move** — drag-and-drop only, no "Move to…" action.
- **Sort** — always automatic: folders before notes, each group alphabetical. No manual ordering, so no order state to persist.
- **Open** — single click on a note loads it into the right pane.
- **Folder click** — toggles expand/collapse and selects the folder as the target for context-menu create actions.

---

## 5. Editor and formatting toolbar

Flat single-row toolbar, all buttons visible, thin dividers between groups ([#5](https://github.com/IgorKvasn/note-taker/issues/5)):

> Bold · Italic · Strikethrough · Inline code | H1 · H2 · H3 | Bullet · Ordered · Task list | Blockquote · Link · Image · Table · Code block · Horizontal rule

Every action is a direct CM6 `EditorState.changeByRange`/`dispatch`:

| Group | Behavior |
|---|---|
| Bold, Italic, Strikethrough, Inline code | **Wrap-toggle** with `**`, `_`, `~~`, `` ` ``. Re-applying on an already-wrapped selection (markers just inside or outside the bounds) strips them. Empty selection inserts both markers, cursor between. |
| H1–H3 | **Line-prefix toggle** per touched line. Same level again removes it; a different level replaces the existing `#` prefix. |
| Bullet, Ordered, Task list | **Line-prefix toggle** across all touched lines. Ordered lists renumber sequentially. The first touched line's state decides on vs. off for the whole selection. |
| Blockquote | `> ` line-prefix toggle across touched lines. |
| Link, Image | Insert `[label](url)` / `![alt](url)`, using the selection as label/alt if present. Cursor lands on the `url` placeholder. |
| Table, Code block, Horizontal rule | **Template insert** on a new line after the current one, adding a leading newline if the current line isn't empty. |

**Accepted edge case:** selecting only the marker characters (e.g. just the leading `**` of a bold span) and clicking that button wraps again rather than toggling off — `**bold**` → `******bold**`. Rare and self-correcting; deliberately not guarded ([#5](https://github.com/IgorKvasn/note-taker/issues/5)).

### Markdown dialect

Edit and view mode must agree ([#4](https://github.com/IgorKvasn/note-taker/issues/4)). `@codemirror/lang-markdown` defaults to GFM; `remark-gfm` reaches the same feature set — tables, task lists, strikethrough, autolinks. `rehype-sanitize` is required, not optional: notes sync in via git from other machines, so rendered output is untrusted input.

Two known asymmetries, accepted:
- CodeMirror highlights subscript/superscript/emoji syntax that `remark-gfm` won't render.
- `remark-gfm` renders footnotes that lezer's GFM bundle won't highlight.

---

## 6. Configuration

TOML at `$XDG_CONFIG_HOME/note-taker/config.toml`, falling back to `~/.config/note-taker/config.toml`, resolved via the `directories` crate ([#9](https://github.com/IgorKvasn/note-taker/issues/9)).

```toml
version = 1

[[roots]]
id = "01J8X..."                                 # stable, generated on add, never displayed
path = "/home/user/notes"                       # doubles as the git repo root
auto_sync = true                                # commit + push on save; needs remote_url to push
remote_url = "git@github.com:user/notes.git"    # optional; absent = local-only

[[roots]]
id = "01J8Y..."
path = "/home/user/work-notes"
auto_sync = false
remote_url = ""
```

- `roots` is an array of tables; **array order is tree display order**.
- Each root is a fully independent git repo with its own sync settings — `auto_sync` is per-root, not global.
- `id` is generated by `save_config` when a root is added, and is **never shown in the UI** — tree labels derive from the folder name. It exists because IPC addresses everything as `(root_id, relative_path)` (§9.2): an array index shifts when a root is removed, and a path breaks when edited, which Settings explicitly supports. Only a stable ID survives both, and the persisted last-open note depends on it.
- No `name` field — renaming a root's label means renaming the folder on disk.
- **No credential fields, ever** (§7).

### Settings UI

An add/remove/edit list of roots behind an explicit **Save** button — no autosave-on-blur.

- **Add** — directory picker; `git init` runs if the target isn't already a repo.
- **Remove** — drops the entry only. The folder and its notes are untouched on disk.
- **Edit** — path, remote, `auto_sync` per entry.
- **Save** — validates each root's path (exists, writable), offers to create a missing directory with confirmation, and `git init`s where needed. **No note migration**: repointing a root copies and moves nothing.

Validation is read-only and happens *before* any write (§9.4), so a Save cannot half-apply — leaving root 1 `git init`'d while root 3 failed.

### Startup

- **Config missing** → first-run setup to pick at least one root before the main UI.
- **Config invalid or unparseable** → hard error dialog showing the parse error. The app does not guess, fall back to defaults, or proceed.

### UI state (separate file)

`state.toml` / `state.json` beside `config.toml`, **autosaved with no Save button** — deliberately distinct from config's explicit-Save lifecycle, since UI state changes constantly as a side effect of use ([#10](https://github.com/IgorKvasn/note-taker/issues/10)).

| Persisted | Scope |
|---|---|
| Pane split ratio | Global — chrome preference, not a document property |
| Last-open note | Global — one note plus its root ID (only one note is ever open) |
| Tree expand/collapse | Per root — set of expanded folder paths |
| Window size/position | **Not persisted** — OS/default each launch |
| Search query and results | **Never persisted** (§8) |

---

## 7. Git sync

### Remote and authentication ([#7](https://github.com/IgorKvasn/note-taker/issues/7))

Settings auto-detects an existing remote and lets the user paste or edit a URL; the backend runs the `git remote add`/`set-url origin` equivalent.

**The app stores no credentials and implements no auth mechanism.** It shells out to the system `git` binary as a subprocess, inheriting the user's environment — SSH keys, ssh-agent, credential helpers, and gitconfig all work exactly as they do in a terminal in that directory. This is why the backend uses the git binary rather than `git2`/libgit2.

- **No remote** is a valid, unremarkable mode: `git init` and commit-on-save still happen, push is never attempted. A one-time dismissible notice on first save explains sync is local-only. No recurring nags.
- **Auth failure on push** shows the raw `git` stderr verbatim plus a short static hint that this is a system git/SSH/credential problem to fix outside the app. No error parsing or categorization.

This is what "fail loudly" means throughout: raw stderr surfaced immediately, no silent retries, no swallowed errors.

### The sync chain ([#12](https://github.com/IgorKvasn/note-taker/issues/12) §5)

`git add` → `git commit` → (if `auto_sync` **and** `remote_url`) `git push` → on rejection, automatic plain `git merge` → re-push if clean, or report `conflict` if markers remain.

With `auto_sync = false` or no remote, the chain still **commits locally** and stops before push, reporting `local_only`.

- **Save and sync are decoupled.** `save_note` returns as soon as the file is on disk; the chain runs as a background task. "Your text is safe on disk" and "your text reached the remote" are different guarantees with different failure surfaces — the editor must not withhold "saved" pending a network round trip.
- **Sync is serialized per root** — concurrent syncs on one repo would race on the index. Rapid successive saves coalesce rather than stack.
- **Merge, not rebase** — a single, more forgiving resolution failure mode for non-git-experts.
- Tree mutations (create, move, delete) trigger the chain too; otherwise a rename would sit uncommitted until some unrelated note was edited.

### Startup catchup ([#12](https://github.com/IgorKvasn/note-taker/issues/12) §7)

Reactive-only sync leaves work stranded when a push is interrupted — a network drop, a closed laptop, an app killed mid-push — with nothing to ever retry it. So on startup, per root, the backend:

1. **Commits a dirty working tree** if one exists (an interrupted save, or edits made outside the app).
2. **Pushes unpushed commits**, if `auto_sync` and a remote are set. `git push` is idempotent, so retrying is safe.
3. Reports the outcome via the sync-status event channel.

**Non-blocking**: the UI launches immediately and restores the last-open note; results land per root as each settles. An unreachable remote yields an error state on that root's indicator — never a hang, never a modal.

### Conflicts ([#8](https://github.com/IgorKvasn/note-taker/issues/8))

**Scope: same-file content conflicts only** — standard `<<<<<<<`/`=======`/`>>>>>>>` markers. Delete/modify and rename/modify conflicts are an **accepted gap**: they surface as a raw git error needing terminal intervention.

A rejected push is *not* itself a conflict — the automatic merge resolves most divergence silently, and the user sees nothing. A conflict is only a merge that leaves unresolved markers.

**Detection is reactive**, never background-polled, at three moments: save/push, manual `sync_root`, and startup catchup.

**Surfacing is non-blocking and scoped**: a persistent indicator on the affected root's tree section ("N notes need resolution") plus a one-time toast per affected root. Other roots and other notes stay fully usable; nothing app-wide is blocked. The toast carries more weight for startup conflicts — the user just launched the app and took no action, so nothing else would prompt them to look.

**Conflict state is derived, never tracked.** On open (or re-render after a failed sync), the backend checks whether the root has a `MERGE_HEAD` and whether the file still contains markers. An open note whose sync fails re-renders into conflict view in place — no interrupting modal.

**Resolution — no new diff/merge UI.** The conflicted note opens in the normal CodeMirror editor showing raw markers as text. The user hand-edits them away and clicks **Mark resolved**, which scans for leftover marker syntax and blocks with an inline error if any remain, so note content is never silently corrupted.

**Multi-file merges**: non-conflicting files auto-merge and stage normally; each conflicted file needs its own Mark resolved. When the last one clears, the app fires the merge commit automatically — no separate "Finish merge" step — and immediately re-attempts the push. A second rejection repeats the same cycle.

---

## 8. Search

In scope for v1: **full-text, across all roots, no index** ([#11](https://github.com/IgorKvasn/note-taker/issues/11)). The corpus is hand-written markdown, so an on-demand walk is fast enough; an index (SQLite FTS5, tantivy) can be added later behind the same IPC command without changing the UX.

**Location** — the input pinned at the top of the left panel **swaps the panel's content**: results replace the tree, and clearing restores the tree with its expand/collapse state intact.

**Match semantics** — case-insensitive **plain-substring match on the whole query string**. No tokenization, regex, or operators. Substring is deliberate: `docker comp` should find "docker compose", because partial recall is the point.

- Matched against **raw markdown**, so `**bold**` and URLs inside links are findable and snippets read as the file does.
- **Note titles are searched; directory names are not.**
- **YAML frontmatter is excluded** from matching and snippets — a hit on an opaque ULID is never useful.
- Match count is the number of **non-overlapping occurrences**.

**Result rows** — note title, a single-line snippet with matches highlighted, and the root + directory path as dim secondary text (needed since hits are cross-root). **One row per note, never one per match.** A **title-only hit** shows the note's first content line unhighlighted — the absent highlight is itself the honest signal that the match was in the title.

**Ordering** — **match count descending, then title alphabetically**. No relevance scoring: real ranking is what an index buys, and hand-tuned weights produce an order nobody can predict or debug. Title occurrences fold into the same count, keeping one rule.

**When it runs** — as-you-type, **250 ms debounce, 2-character minimum**. Below the minimum, no results.

> **In-flight searches must be cancelled when a newer keystroke supersedes them.** This is the one genuine correctness trap in the feature: without cancellation, a slow walk over a large root can land *after* a newer one and overwrite fresher results with stale ones. `search_notes` carries a sequence number for exactly this.

**Traversal** — recursive, `*.md` only. Skip `.git/` entirely (typically the largest directory, full of objects and packed refs). Don't follow symlinks (walk cycles, duplicate hits). Ignore dotfiles and dot-directories (`.obsidian/`, `.trash/`). No file-size cap — a cap only ever fires on a hand-written note you'd want found. Missing or unreadable roots are skipped silently, surfaced by the per-root tree indicator instead; a search shouldn't be what shouts about an unmounted root.

**Clicking a result** — single click opens the note and **leaves the panel in search mode with query and results intact**, scrolling the editor to the first match with the cursor placed there. Results surviving the click is essential: restoring the tree would make this the overlay dialog that was rejected, only slower. No persistent all-match highlight — CodeMirror already ships find-in-document.

**Exit** — `Escape` clears the query and restores the tree. No result cap. A "no matches" empty state, not a silent fallback to the tree, which would read like search broke.

Search is **fully independent of file-watching** — a stateless command that walks on demand. Results deliberately do not re-run while the open note is edited: a list that reshuffles under the cursor mid-typing is worse than a slightly stale one.

### Accepted gaps

- **`.gitignore` is not consulted.** Honoring it needs either `git check-ignore` per candidate (slow) or a reimplementation of ignore matching. With `.git/` and dotfiles already excluded, what remains is almost certainly a note worth finding.
- **Word order matters** — `compose docker` finds nothing where `docker compose` would. The most likely thing to revisit; the fix stays behind the same command and row design.
- **Match-count ordering favors long notes**, which mention any term more often. Mild and comprehensible.
- **Results go stale** after editing an open note until the query is touched.
- The **last-open note is persisted but the search that led to it is not** — a restart restores the note with the tree on the left. Intended; documented so nobody "fixes" it.

---

## 9. Backend architecture

### 9.1 No filesystem watcher in v1

The backend does **not** watch roots — no `notify` crate, no polling ([#12](https://github.com/IgorKvasn/note-taker/issues/12) §1). This follows the grain of every other decision: conflict detection is already reactive, search is already independent of watching, tree mutations all originate in the app, and ID backfill is triggered by the app's own reads.

**Refresh triggers instead** — the frontend re-calls `list_tree` on window focus regain, on completion of any git operation that may have rewritten files (notably the automatic merge, the one case where the app's own action rewrites the open note underneath the user), and on explicit manual refresh.

**Accepted gap:** edit a note in vim while the app is open and unfocused, and nothing notices until focus returns. Acceptable for a single-user tool, and avoiding a watcher avoids a class of problems that would otherwise need specifying — debouncing the app's own writes echoing back, a `git pull` firing hundreds of events at once, and the genuinely hard "file changed on disk under your unsaved edits" reconciliation.

### 9.2 Addressing: `(root_id, relative_path)`

Every command naming a note or directory takes a root ID and a path **relative to that root**. Absolute paths never cross the IPC boundary.

The backend joins the relative path onto the root path, canonicalizes, and **rejects any result that escapes the root** — killing path traversal (`../../.ssh/id_rsa`) as a category rather than as a check each command must remember.

### 9.3 Transport

Request/response throughout, with **one exception**: a one-way backend→frontend **sync-status event channel**, carrying `{ root_id, state }` where state is one of `syncing` / `synced` / `local_only` / `conflict` / `error(stderr)`.

Events rather than an awaited promise because sync also fires from startup catchup, which has no originating call to return into. This is not a filesystem-watching channel and does not reopen §9.1.

### 9.4 Command surface

**Tree and notes**

- **`list_tree(root_id) -> Tree`** — full recursive tree for one root. Pure `readdir` metadata: filename, relative path, is-directory. **Never reads file contents.** Eager, not lazy: expand/collapse stays pure frontend state, making the persisted-expanded-paths restore trivial rather than a cascade of rehydration calls. A metadata-only walk is strictly cheaper than the full-content walk search already accepts on every debounced keystroke. Designed to be re-called wholesale on refresh, not diffed.
- **`open_note(root_id, path) -> { content, id, is_conflicted }`** — one call returning everything needed to render. Reads content and the frontmatter ULID, backfilling if absent (§9.5). Derives `is_conflicted`: `false` immediately if the root has no `MERGE_HEAD`, otherwise scans for markers. Deliberately **not** split into `read_note` + `get_conflict_state`, which would let the frontend hold content without having checked — reintroducing the tracked-state trap that conflict handling rejects. Costs one `stat` per open.
- **`save_note(root_id, path, content)`** — writes to disk and returns **as soon as the file is written**. Does not wait on git; triggers the sync chain as a background task.

**Tree mutations**

- **`create_note(root_id, path)`** — writes a file with fresh frontmatter containing a new ULID.
- **`create_folder(root_id, path)`** — bare `mkdir`, no git effect. *Accepted gap:* produces no commit and won't sync until it contains a note, since git doesn't track empty directories.
- **`move_item(root_id, from_path, to_path)`** — **covers both rename and move**, for notes and directories alike. These are already the same operation (`git mv`, ID preserved, same validation against the destination); a rename is just a move whose parent doesn't change. Two commands required to stay behaviorally identical would be a place for them to drift.
- **`delete_item(root_id, path)`** — permanent removal; recovery via git history.

All mutations run the title validation from §3 and trigger the sync chain.

**Sync and conflicts**

- **`sync_root(root_id)`** — manually triggers the chain. Exposed as a retry on the per-root indicator ("network's back, try again"); without it, the only way to retry a failed push would be to edit a note. Per-root, not the global indicator that was declined.
- **`mark_resolved(root_id, path)`** — scans for leftover markers and refuses if any remain, otherwise stages the file; when the merge's last conflicted file clears, fires the merge commit and re-attempts the push.
- **`get_root_status(root_id) -> { conflicted_count, sync_state }`** — feeds the per-root tree indicator, including on launch before any sync has run.

**Search**

- **`search_notes(query, seq) -> results`** — stateless, walks and reads on demand. `seq` is the sequence number backing in-flight cancellation (§8).

**Config and state**

- **`get_config() -> Missing | Invalid(parse_error) | Ok(config)`** — the three outcomes are distinguishable, driving first-run setup, the hard-error dialog, and normal launch respectively.
- **`validate_root_path(path) -> { exists, is_writable, is_git_repo, has_remote, remote_url }`** — pure read-only probe, no mutation. Called when a directory is picked and again before Save; also serves as remote auto-detection, since the same call surfaces the existing `origin`.
- **`save_config(config)`** — single transactional write performing all side effects for all roots at once: `mkdir` where confirmed, `git init` where needed, `git remote set-url` where changed, and ID generation for new roots. Validate-then-commit, not save-does-everything: since Save must offer to create a missing directory with confirmation, a mid-Save prompt would mean the backend stopping halfway, asking, and resuming.
- **`get_state()` / `save_state(state)`** — the autosaved UI-state file (§6).
- **`get_app_version()`** — the About modal.

### 9.5 ID backfill happens on open, never during the tree walk

`list_tree` is pure metadata and never triggers backfill; `open_note` reads the ULID and writes it if absent.

**A read command must not write.** Backfilling during the tree walk would mean *drawing the tree* dirties the git working tree — and with auto-sync, creates commits the user never asked for and cannot attribute to any action. A `git pull` bringing in 50 notes from another machine would rewrite all 50 on the next refresh. Nothing needs the ID until a note is opened: the tree renders from paths, search excludes frontmatter, and git tracks files by path.

**Accepted gap:** a freshly-pulled vault has IDs only for notes actually opened, so they trickle in as small commits over time rather than landing as one bulk change. The better failure mode, but a real difference from "every note always has an ID."

---

## 10. Packaging

`tauri build` with `"targets": ["deb"]` — the built-in bundler, no `cargo-deb` ([#13](https://github.com/IgorKvasn/note-taker/issues/13)). A build shell script producing the `.deb` should exist ([#10](https://github.com/IgorKvasn/note-taker/issues/10)).

> ### The bundler auto-injects the webkit/gtk pair, and nothing else
>
> `bundle.linux.deb.depends` must be written by hand for anything outside that pair: the value is `settings.deb().depends … .unwrap_or_default()` guarded by `if !dependencies.is_empty()`, so a dependency we omit is simply absent from the shipped `Depends:` line, producing a `.deb` that installs cleanly and then fails at launch. What the bundler *does* add unconditionally is `libwebkit2gtk-4.1-0` and `libgtk-3-0`, with no dedup against our list — so declaring either of those ourselves doubles it. Verified against tauri-cli 2.11.4 on Ubuntu 26.04: a config of `["git"]` produced `Depends: git, libwebkit2gtk-4.1-0, libgtk-3-0`.

```json
"bundle": {
  "linux": {
    "deb": {
      "depends": ["git"]
    }
  }
}
```

- **`git`** — the backend shells out to the system binary (§7), and `git` is `Priority: optional` in the archive, so it is *not* guaranteed present on a minimal Ubuntu install. Declaring it is what makes "shell out to system git" safe as an architecture.
- **`libwebkit2gtk-4.1-0`** (auto-injected) — Tauri v2 requires WebKitGTK **4.1**, not v1's 4.0. Present on 26.04 as `2.52.x`.
- **`libgtk-3-0`** (auto-injected) — **a virtual package on 26.04.** The 64-bit `time_t` transition renamed the real package to `libgtk-3-0t64`, which declares `Provides: libgtk-3-0`; that compatibility Provides is the only reason the bundler's hardcoded name still resolves. Nothing in our config can influence this name, so if the Provides is ever dropped the fix is a bundler upgrade, not a config change.
- **No appindicator dependency** — this app has no tray icon.
- `libsoup3` needs no explicit entry; it arrives transitively via webkit2gtk-4.1.

**Supported release: Ubuntu 26.04 only.** Earlier releases are supported neither as build hosts nor as install targets: a 26.04 build links against 26.04's glibc and will not install on 22.04 or 24.04. This inverts the earlier build-on-the-oldest-release policy, which existed to keep one `.deb` installable across 22.04 and 24.04, and is a deliberate support-policy change ([#35](https://github.com/IgorKvasn/note-taker/issues/35)). `scripts/build-deb.sh` hard-errors on a non-26.04 host; `ALLOW_ANY_UBUNTU=1` overrides it for local testing at the cost of a non-releasable artifact. Tauri publishes no official minimum Ubuntu version.

### Versioning

Version precedence is `tauri.conf.json` `version` → `Cargo.toml` `package.version` → workspace inheritance, panicking if none is found. **Set it in `Cargo.toml` only** and omit it from `tauri.conf.json`, for a single source of truth.

The string is passed through **untranslated** into both the filename `{productName}_{version}_{arch}.deb` and the control `Version:` field — there is no semver→Debian conversion.

> **Ship plain `MAJOR.MINOR.PATCH` releases only.** Debian reads the hyphen in `1.0.0-beta.1` as a `debian_revision`, so it sorts **newer** than `1.0.0` — inverted from semver. Debian's `~` pre-release idiom isn't valid semver, so the two schemes can't be reconciled cleanly.

### Updates: manual reinstall for v1

Download the new `.deb` and `dpkg -i`. No updater plugin.

The updater's deb path does exist — `plugins/updater/src/updater.rs` has `install_deb()` running `dpkg -i` via `pkexec` → `zenity`/`kdialog` → `sudo` — contradicting docs that describe Linux updates as AppImage-only. It was declined for v1 anyway: it prompts for sudo on every update and landed recently via contributor PR, and a single-developer app with no release cadence doesn't yet earn the machinery. Adding it later doesn't disturb any packaging decision here.

A self-hosted apt repo (`aptly`/`apt-ftparchive` + GPG signing + static hosting) is the other deferred option. **A Launchpad PPA is permanently out**: PPAs accept source packages only and reject pre-built binary uploads, which for a Rust + npm app would mean vendoring every dependency for an offline builder.

---

## 11. Accepted gaps

Consolidated from the sections above — each is a deliberate decision with rationale in its ticket, not an oversight.

| Gap | Section |
|---|---|
| Delete/modify and rename/modify conflicts fall back to raw git errors and terminal intervention | §7 |
| External edits go unnoticed while the window is unfocused (no watcher) | §9.1 |
| `create_folder` produces no commit until the folder contains a note | §9.4 |
| Freshly-pulled vaults get IDs only as notes are opened, trickling in as small commits | §9.5 |
| Search ignores `.gitignore` | §8 |
| Search is whole-query-literal, so word order matters | §8 |
| Match-count ordering is biased toward long notes | §8 |
| Search results go stale after editing an open note until the query is touched | §8 |
| Marker-only selections re-wrap instead of toggling off in the toolbar | §5 |
| Editor highlights sub/superscript/emoji that view mode won't render; view mode renders footnotes the editor won't highlight | §5 |
| No auto-update — manual `dpkg -i` per release | §10 |
| Only Ubuntu 26.04 supported — the `.deb` will not install on 22.04 or 24.04 | §10 |

---

## 12. Unverified assumptions

Flagged during packaging research and not settled from primary sources ([#13](https://github.com/IgorKvasn/note-taker/issues/13)). None blocks implementation; the first is worth a smoke test if the updater is ever adopted.

- Deb-updater end-to-end behavior, especially `dpkg -i` over a running app.
- Whether the Tauri CLI validates `version` as strict semver.
- `libsoup3` coupling is inferred from WebKitGTK packaging, not stated on a Tauri page.
- No official minimum Ubuntu version from Tauri; targeting 26.04 is our support policy, not a documented floor.
- GitHub Pages as apt hosting is reasoned from apt's static-HTTP requirements, not documented as supported.

---

## Source tickets

| # | Decision |
|---|---|
| [2](https://github.com/IgorKvasn/note-taker/issues/2) | Directory tree UI behavior |
| [3](https://github.com/IgorKvasn/note-taker/issues/3) | Filename-as-title identity and edge cases |
| [4](https://github.com/IgorKvasn/note-taker/issues/4) | Markdown view-mode rendering approach |
| [5](https://github.com/IgorKvasn/note-taker/issues/5) | Formatting toolbar button set and behavior |
| [6](https://github.com/IgorKvasn/note-taker/issues/6) | Frontend framework choice for Tauri webview |
| [7](https://github.com/IgorKvasn/note-taker/issues/7) | Git remote setup and authentication flow |
| [8](https://github.com/IgorKvasn/note-taker/issues/8) | Conflict UI and manual resolution flow |
| [9](https://github.com/IgorKvasn/note-taker/issues/9) | Config file schema and fields |
| [10](https://github.com/IgorKvasn/note-taker/issues/10) | Window layout persistence and app chrome |
| [11](https://github.com/IgorKvasn/note-taker/issues/11) | Search across notes |
| [12](https://github.com/IgorKvasn/note-taker/issues/12) | Tauri backend architecture: file-watching and IPC surface |
| [13](https://github.com/IgorKvasn/note-taker/issues/13) | .deb packaging pipeline |

Supporting research: [`docs/research/markdown-rendering-library.md`](research/markdown-rendering-library.md), [`docs/research/deb-packaging.md`](research/deb-packaging.md).
