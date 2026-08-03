# note-taker

A note-taking app for Linux that keeps your notes as plain files.

Your notes are ordinary `.md` files in ordinary folders. There's no database, no
proprietary format, and nothing to export — point the app at a folder and that
folder stays readable, greppable, and editable by any other tool on your
machine. If you stop using note-taker tomorrow, you still have your notes.

Each folder you add is its own git repository, synced to its own remote. That's
how notes get between your machines, and it's also your undo history.

## Installing

Download the `.deb` from the
[latest release](https://github.com/IgorKvasn/note-taker/releases/latest)
and install it:

```bash
sudo apt install ./note-taker_*.deb
```

Ubuntu 26.04 only. Older releases won't install.

On first launch, open Settings and add a folder to keep your notes in. You can
add several — a personal one and a work one, say. Each can point at a git remote,
or stay purely local.

## Writing notes

The editor styles your markdown as you type. Bold looks bold, headings look like
headings, and the `**` markers just fade into the background instead of
disappearing — so what you see still matches what's in the file. There's a
toolbar for the common formatting, and a preview mode when you want to see the
finished page with tables, task lists, and highlighted code.

Notes save themselves shortly after you stop typing. You never press save, and
you don't lose work if a save briefly fails.

Tables, task lists, and fenced code blocks all render properly, and code blocks
and quotes have a button to copy their contents.

## Finding things

**Search** looks through the full text of every note in every folder you've
added, as you type. Each hit shows a snippet with the match highlighted and which
folder it lives in, with the most relevant notes first. Pick one and the editor
opens it scrolled to the first match.

**The tree** shows one section per folder you've added, kept separate rather than
merged together. Right-click for new note, new folder, rename, and delete. Drag
notes to move them. `F2` renames.

Deleting is permanent — there's no trash. Deleting a folder asks first and tells
you how much is inside. If you sync to a remote, git is your way back.

## Linking notes together

Notes can link to each other. Hit the `🔖` button, pick a note, and you get a
link that keeps working even after you rename or move either note. When other
notes link to the one you're reading, it shows a collapsible **Linked from**
list of them.

Links work within a single folder, not across the folders you've added.

## Syncing

If a folder has a git remote, note-taker commits and pushes your changes in the
background after you write. Nothing blocks while it happens — the note is saved
the moment it's saved, regardless of the network. If the remote has changes too,
they get merged in and pushed back.

Each folder in the tree shows its own status: syncing, synced, local only,
conflict, or failed, with a retry button when something went wrong. Statuses are
per folder, because that's how syncing actually works — one folder can be fine
while another is stuck.

### When two machines edit the same note

You get git's conflict markers directly in the editor:

```
<<<<<<< HEAD
the version from this machine
=======
the version from the other machine
>>>>>>> 824a8fadbc34721fe61fe911f98e39b813ad9296
```

(The row of hex at the bottom is just the incoming commit's ID — that's normal,
not an error.)

Edit the note until it says what you want and the markers are gone, then hit
**Mark resolved** — it won't let you through while a marker is still there. Once
you've cleared the last conflicted note, the merge finishes and pushes on its
own.

There's no side-by-side merge tool. Notes are prose, and editing the text
directly is usually faster than clicking through a three-pane diff.

## Updates

On startup, note-taker checks whether a newer release exists and shows a
dismissible notice with the changelog if so. It only tells you — it never
downloads or installs anything, and it stays quiet if you're offline.

## Keyboard shortcuts

| | |
|---|---|
| `Mod-B` / `Mod-I` | Bold / italic |
| `Mod-Shift-X` | Strikethrough |
| `Mod-E` | Inline code |
| `Mod-K` | Link |
| `Mod-Alt-1` … `3` | Heading 1–3 |
| `Mod-Shift-8` / `Mod-Shift-7` | Bullet / numbered list (renumbers from 1) |
| `Mod-Shift-.` | Quote |
| `F2` | Rename in tree |
| `Escape` | Clear search, close dialog, cancel renaming |
| `←` / `→` | Move the split divider (when focused) |

`Mod` is `Ctrl` on Linux.

## How your notes are stored

One note is one `.md` file, and **the filename is the title**. Rename the note
and you rename the file. The only thing note-taker adds is an ID at the top:

```markdown
---
id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
---
# My note
```

That ID is what makes links survive renames. It's stored in the note itself, so
it travels with the file and can't drift out of step with it. Notes that arrive
from elsewhere without an ID get one the first time you open them.

Because titles are filenames, a few characters aren't allowed in a title — `/`,
`\`, and `:` — and you can't have two notes with the same name in one folder.
You'll get told when a title doesn't work, rather than having it quietly changed
behind your back.

Your settings live in `~/.config/note-taker/config.toml`, and things like window
layout and which note was last open are kept alongside it. Both are plain text,
though the app manages them for you through Settings.

## Good to know

- **Editing notes outside the app.** Perfectly fine — but note-taker notices
  changes when you focus the window or after a sync, not the instant they
  happen. Switch to the window and you'll see them.
- **Git credentials.** note-taker uses the `git` already on your system, so your
  existing SSH keys or credential helper do the work. The app never asks for or
  stores your credentials.
- **Search speed.** Search reads your notes each time instead of keeping an
  index. That keeps results honest — they can never be stale — and it's quick at
  the scale of hand-written notes.

## Contributing

Building from source, running the checks, packaging, and cutting a release are
all in [`docs/development.md`](docs/development.md).
[`docs/spec.md`](docs/spec.md) has the full spec, including the reasoning behind
the design decisions and a list of known gaps.
