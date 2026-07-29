# `.deb` packaging for a Tauri v2 app on Ubuntu

## Recommendation / summary

**Q1 — Build tooling.** Use `tauri build`'s built-in bundler (`tauri-bundler`) with `"targets": ["deb"]`. It generates deb, rpm and appimage on Linux and writes the `.desktop` file from a Handlebars template you can override. `cargo-deb` is *not* needed, but it is not purely redundant either — it is the only one of the two that derives `Depends` automatically via `dpkg-shlibdeps`.

**Q2 — Runtime dependencies (the sharpest constraint).** **The Tauri v2 bundler does not auto-populate `Depends` at all.** Contrary to the wording of the Debian distribution guide, the bundler writes `Depends:` only from `bundle.linux.deb.depends` in your config — there is no hardcoded list and no `ldd`/`shlibdeps` step anywhere in the source. If you leave `depends` empty, you ship a `.deb` with **no `Depends` field at all**, which installs cleanly on a machine with no WebKit and then fails at launch. You must write the list by hand: at minimum `libwebkit2gtk-4.1-0`, `libgtk-3-0` (plus `libayatana-appindicator3-1` only if you enable a tray icon). Tauri v2 uses **WebKitGTK 4.1 / libsoup3** (v1 used 4.0 / libsoup2); `libwebkit2gtk-4.1-0` exists on 22.04 and 24.04 but **not on 20.04**, which is why 22.04 is the practical floor.

**Q3 — Versioning.** `tauri.conf.json` `version` wins; if absent, `Cargo.toml` `package.version` (with workspace inheritance) is used. The bundler applies **no semver→Debian translation** — the raw string goes into both the filename (`{productName}_{version}_{arch}.deb`) and the control `Version:` field. This is a real gotcha: semver `1.0.0-beta.1` becomes a Debian version whose `-beta.1` is parsed as a *debian_revision*, and it sorts **after** `1.0.0`, the opposite of semver. Debian's pre-release idiom is `~` (`1.0.0~beta.1`), which is not valid semver.

**Q4 — Update mechanism.** **The updater plugin does support `.deb`** — this is the biggest docs-vs-source divergence found. The docs only ever mention AppImage, but the plugin source has `install_deb()` which shells out to `dpkg -i` via `pkexec`/zenity/`sudo`. It works by build-time binary patching of a `__TAURI_BUNDLE_TYPE` marker, so it only triggers for a binary bundled as deb. The catch: every update prompts for an **admin password**, which is a worse UX than AppImage's silent in-place swap. For a single developer, deb + updater or deb + manual reinstall are both realistic; a PPA is the least realistic (Launchpad rejects prebuilt binaries and requires source builds).

---

## Q1 — What produces the `.deb`, and what is configurable

### The bundler, not cargo-deb

`tauri build` invokes `tauri-bundler` directly; the `.deb` target is first-party. Linux bundle targets in v2 are **`deb`, `rpm`, `appimage`** (the full `BundleTarget` enum is `deb`, `rpm`, `appimage`, `msi`, `nsis`, `app`, `dmg`, plus `"all"`) — [Tauri v2 config reference, BundleTarget](https://v2.tauri.app/reference/config/). Note **`rpm` is new in v2**; v1 shipped only deb + appimage. There is no Snap or Flatpak bundler target — the [distribute index](https://v2.tauri.app/distribute/) documents AppImage, AUR, Debian, RPM and Snapcraft, but AUR/Snapcraft are external workflows, not bundler outputs.

### `bundle.linux.deb` keys in the v2 schema

All confirmed from the [v2 config reference `DebConfig`](https://v2.tauri.app/reference/config/):

| Key | Meaning |
|---|---|
| `depends` | List of deb dependencies → `Depends:` |
| `recommends` | List of recommended deps → `Recommends:` |
| `provides` | → `Provides:` |
| `conflicts` | → `Conflicts:` |
| `replaces` | → `Replaces:` |
| `files` | Map of destination path in package → source path relative to `tauri.conf.json` |
| `section` | Debian control `Section:` |
| `priority` | One of `required`, `important`, `standard`, `optional`, `extra` |
| `changelog` | Path to uncompressed changelog, installed to `/usr/share/doc/<pkg>/changelog.gz` |
| `desktopTemplate` | Path to a custom `.desktop` Handlebars template |
| `preInstallScript` / `postInstallScript` / `preRemoveScript` / `postRemoveScript` | Maintainer scripts |

Sibling configs: `bundle.linux.appimage` (`files`, `bundleMediaFramework`) and `bundle.linux.rpm` (`depends`, `recommends`, `provides`, `conflicts`, `obsoletes`, `epoch`, `release`, `compression`, `files`, `desktopTemplate`, and the same four maintainer-script keys).

Verified against source: each key maps 1:1 onto a control-file line in [`crates/tauri-bundler/src/bundle/linux/debian.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/debian.rs) — e.g. `Priority: optional` is written as a default when `priority` is unset, and every other optional field is emitted only when non-empty.

### `.desktop` file handling

The bundler renders `.desktop` from a bundled Handlebars template, overridable via `desktopTemplate`. The stock template ([`freedesktop/main.desktop`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/freedesktop/main.desktop)) is:

```
[Desktop Entry]
Categories={{categories}}
{{#if comment}}
Comment={{comment}}
{{/if}}
Exec={{exec}}
StartupWMClass={{exec}}
Icon={{icon}}
Name={{name}}
Terminal=false
Type=Application
{{#if mime_type}}
MimeType={{mime_type}}
{{/if}}
```

`StartupWMClass` and the conditional `MimeType` (driven by `bundle.fileAssociations`) are the notable inclusions — relevant if the app should be a handler for `.md` files. The template is registered from a file when `desktopTemplate` is set, else `include_str!` of the built-in ([`freedesktop/mod.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs), `generate_desktop_file`).

### Is cargo-deb redundant?

Mostly, with one real exception. [cargo-deb](https://github.com/kornelski/cargo-deb) "automatically creates binary Debian packages (.deb) from Cargo projects" and documents `depends` as "Generated automatically when absent, or if the list includes the `$auto` keyword". Its source shows the mechanism the README omits — it runs the Debian-standard tool:

```rust
const DPKG_SHLIBDEPS_COMMAND: &str = "dpkg-shlibdeps";
/// Resolves the dependencies based on the output of dpkg-shlibdeps on the binary.
pub(crate) fn resolve_with_dpkg(...)
```
— [`cargo-deb/src/dependencies.rs`](https://github.com/kornelski/cargo-deb/blob/main/src/dependencies.rs)

So the one genuine reason to reach for cargo-deb is **correct, automatic, ABI-accurate `Depends`**. Against it: cargo-deb knows nothing about Tauri's frontend build, resources, icons, `.desktop` file, or updater signing/binary-patching, so using it would mean re-implementing the Tauri packaging steps. The pragmatic middle path is to keep `tauri build` and use `dpkg-shlibdeps` (or `dpkg -I`/`ldd` on the built binary) *once* as a cross-check to author the `depends` list by hand.

---

## Q2 — Runtime dependencies

### WebKitGTK 4.1 and libsoup3 (v2, not v1)

Confirmed for v2: the [prerequisites page](https://v2.tauri.app/start/prerequisites/) build-dep line is `libwebkit2gtk-4.1-dev` (plus `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`). The AppImage guide states it directly: you must build on "the oldest base system you intend to support that also provides **Tauri v2's required WebKitGTK 4.1 packages**" — [distribute/appimage](https://v2.tauri.app/distribute/appimage/).

The libsoup coupling is transitive rather than something you list yourself: WebKitGTK 4.0 links libsoup2, WebKitGTK 4.1 links libsoup3. That is the whole point of the parallel 4.0/4.1 sonames. Depending on `libwebkit2gtk-4.1-0` pulls the right libsoup automatically, so **`libsoup` does not need to appear in `depends`**. (I did not find a first-party Tauri page that spells out the libsoup2→libsoup3 change in prose for v2; the 4.1 requirement is documented and the soname coupling is a WebKitGTK packaging fact. Flagged as partly inferred in open questions.)

### Ubuntu package availability per release

From [packages.ubuntu.com](https://packages.ubuntu.com/):

| Ubuntu | `libwebkit2gtk-4.1-0` (v2) | `libwebkit2gtk-4.0-37` (v1) |
|---|---|---|
| 20.04 focal | **Not available** | (focal is past standard support and no longer indexed in the package search) |
| 22.04 jammy | Yes — `2.36.0-2ubuntu1`, updated to `2.50.4-0ubuntu0.22.04.1` | Yes — `2.36.0-2ubuntu1` / `2.50.4-0ubuntu0.22.04.1` |
| 24.04 noble | Yes — `2.44.0-2`, updated to `2.52.3-0ubuntu0.24.04.1` | **Not available** |

Searches: [libwebkit2gtk-4.1-0](https://packages.ubuntu.com/search?keywords=libwebkit2gtk-4.1-0&searchon=names&suite=all&section=all), [libwebkit2gtk-4.0-37](https://packages.ubuntu.com/search?keywords=libwebkit2gtk-4.0-37&searchon=names&suite=all&section=all). Note 22.04 is the only release carrying **both** sonames — it is the crossover release. 24.04 has dropped 4.0 entirely, which is why a Tauri **v1** app cannot run on 24.04 unaided, and 20.04 lacks 4.1, which is why a Tauri **v2** app cannot run on 20.04.

`libsoup-3.0-0` follows the same pattern — present in jammy (`3.0.5-1`, updated `3.0.7-0ubuntu1`) and noble (`3.4.4-5build2`, updated `3.4.4-5ubuntu0.7`), absent from focal — [search](https://packages.ubuntu.com/search?keywords=libsoup-3.0-0&searchon=names&suite=all&section=all).

### GTK 3, not GTK 4

Tauri v2 on Linux is GTK**3**-based (`libgtk-3-0`); `libwebkit2gtk-4.1` is itself a GTK3 library. There is no GTK4 path in v2 — the prerequisites and the Debian guide both reference GTK3 only.

### appindicator: only if you have a tray

The [Debian distribution guide](https://v2.tauri.app/distribute/debian/) describes the stock bundler as handling icons, the desktop file, and "default dependencies: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, and **optionally `libappindicator3-1` for system tray support**". So appindicator is conditional on the tray. Ubuntu ships the Ayatana fork — the build dep is `libayatana-appindicator3-dev` per prerequisites, whose runtime library package is `libayatana-appindicator3-1`. The tray itself is gated behind the `tray-icon` Cargo feature ([system tray guide](https://v2.tauri.app/learn/system-tray/)), which notably does **not** document any Linux system-library requirement. For a note-taking app with no tray icon, omit it.

Naming caveat: `libappindicator3-1` (the name in the Debian guide) and `libayatana-appindicator3-1` (the Ayatana fork Ubuntu actually ships) are different package names. On modern Ubuntu the Ayatana one is the live package. Treat the guide's `libappindicator3-1` as the legacy name and verify on your target release before putting either in `depends`.

### Does the bundler auto-populate `Depends`? No.

This is the most important correction in this document. The docs' phrase "default dependencies" implies the bundler injects them. **It does not.** The complete logic in [`debian.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/debian.rs) is:

```rust
let dependencies = settings.deb().depends.as_ref().cloned().unwrap_or_default();
if !dependencies.is_empty() {
  writeln!(file, "Depends: {}", dependencies.join(", "))?;
}
```

`unwrap_or_default()` on an absent config yields an empty vec, and the `if !is_empty()` guard then **omits the `Depends:` line entirely**. I grepped case-insensitively for `libwebkit2gtk`, `libgtk-3-0` and `appindicator` across `bundle/linux/debian.rs`, `bundle/linux/mod.rs`, `bundle/settings.rs` and the generated `config.schema.json` — **zero matches in any of them**. There is no hardcoded list, no `ldd` invocation, and no `dpkg-shlibdeps` call. `Depends` is **config-only**.

Practical consequence: you must author `bundle.linux.deb.depends` yourself, e.g.

```json
{ "bundle": { "linux": { "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"] } } } }
```

Without it the package is silently under-declared: `dpkg -i` succeeds, then the app fails to start on a machine lacking WebKitGTK. Worth a build-time check in CI.

> Caveat on scope: I read the `dev` branch of `tauri-bundler`. It is conceivable (though I found no evidence) that some other layer injects defaults. The safe move either way is to set `depends` explicitly and verify with `dpkg -I your.deb`.

### The cross-release problem and standard practice

Because the *soname is in the package name* (`libwebkit2gtk-4.1-0` vs `-4.0-37`), and because those names don't overlap across 20.04/24.04, a single `.deb` cannot satisfy all three releases. Two independent axes bite:

1. **Package-name/soname availability** — no single `depends` string resolves on both focal and noble.
2. **glibc forward-incompatibility** — glibc symbol versioning is backward- but not forward-compatible. The Debian guide notes "Core libraries such as glibc frequently break compatibility with older systems", so a binary built on 24.04 will typically fail on 22.04 with `GLIBC_2.xx not found`.

**Standard practice, per Tauri's own docs: build on the oldest release you intend to support that has WebKitGTK 4.1** — i.e. **Ubuntu 22.04** (or Debian 12), yielding one `.deb` that covers 22.04 → 24.04 and later. The docs recommend Docker or GitHub Actions for a reproducible old-baseline build ([distribute/appimage](https://v2.tauri.app/distribute/appimage/), [distribute/debian](https://v2.tauri.app/distribute/debian/)). One `.deb` per release is only needed if you must also support 20.04 — which for v2 means no supported WebKit at all, so 20.04 is effectively out of scope regardless.

**Minimum Ubuntu version:** the docs never state a bare number. What they state is a *rule* — oldest base system that provides WebKitGTK 4.1 — plus a recommended baseline of "Ubuntu 22.04 or Debian 12". Combined with the packages.ubuntu.com evidence that 4.1 first appears in jammy, the effective minimum is **Ubuntu 22.04**. Presented as derived, not as a quoted number.

---

## Q3 — Versioning

### Precedence: config first, then Cargo.toml

The config reference for `version` says: "App version as a semver number or path to package.json containing the version field. If removed, the version from Cargo.toml is used; managing versioning in Tauri config is recommended" — [v2 config reference](https://v2.tauri.app/reference/config/).

Source confirms the exact chain in [`crates/tauri-cli/src/interface/rust.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/interface/rust.rs):

```rust
let version = config.version.clone().unwrap_or_else(|| {
  cargo_package_settings
    .version
    .clone()
    .expect("Cargo manifest must have the `package.version` field")
    .resolve("version", || {
      ws_package_settings.as_ref().and_then(|p| p.version.clone())
        .context("Couldn't inherit value for `version` from workspace")
    })
    .expect("Cargo project does not have a version")
});
```

So: **`tauri.conf.json` `version` → `Cargo.toml` `[package] version` → workspace `[workspace.package] version`** (i.e. `version.workspace = true` is honoured). Note the `.expect()` calls — a project with neither source panics rather than defaulting.

### Filename and control `Version:` — no translation

From [`debian.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/debian.rs):

```rust
let package_base_name = format!(
  "{}_{}_{}",
  settings.product_name(),
  settings.version_string(),
  arch
);
let package_name = format!("{package_base_name}.deb");
```

and the control file:

```rust
writeln!(file, "Version: {}", settings.version_string())?;
```

`version_string()` is a bare accessor — `&self.package.version` ([`settings.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/settings.rs)). **No normalization, no `~` substitution, no epoch, no debian_revision is added.** Output lands in `target/release/bundle/deb/` as `{productName}_{version}_{arch}.deb`.

Architecture mapping: `x86_64→amd64`, `x86→i386`, `aarch64→arm64`, `armhf→armhf`, `armel→armel`, `riscv64→riscv64`; anything else is a hard error.

Note the filename uses `product_name()` (e.g. `Note Taker`), not a Debian-sanitized package name — a product name containing spaces or uppercase produces a correspondingly odd filename. Keeping `productName` lowercase and hyphen-free avoids the question.

### The semver-vs-Debian gotcha

[Debian Policy §5.6.12](https://www.debian.org/doc/debian-policy/ch-controlfields.html#version) says `upstream_version` "must contain only alphanumerics and the characters `.` `+` `-` `~`", and critically: **a hyphen is only allowed if a `debian_revision` follows**, because the package manager splits on the *last* hyphen. And on sorting: "a tilde sorts before anything, even the end of a part".

Therefore, with the bundler passing versions through verbatim:

- `1.0.0` → fine.
- `1.0.0-beta.1` → *accepted* by dpkg, but reinterpreted as upstream `1.0.0` + debian_revision `beta.1`. Since a revision sorts **after** the bare version, **`1.0.0-beta.1` is considered NEWER than `1.0.0`** — exactly inverted from semver, where the pre-release precedes the release. An apt-based upgrade path would refuse to "upgrade" from the beta to the final.
- `1.0.0+build.5` → `+` is legal and sorts after `1.0.0`. Semver says build metadata is ignored for precedence; Debian does not ignore it. Divergent but less dangerous.
- Debian's correct idiom would be `1.0.0~beta.1` (sorts *before* `1.0.0`) — but `~` is **not valid semver**, so putting it in `tauri.conf.json` `version` conflicts with the documented "semver number" contract, and the updater parses versions with the `semver` crate (`use semver::Version;` in the plugin source), which would reject it.

**Net:** for a `.deb`-distributed app, prefer plain `MAJOR.MINOR.PATCH` releases and avoid semver pre-release suffixes, or accept that pre-release ordering is wrong in Debian terms. Whether the CLI *validates* the config `version` as strict semver before bundling, I did not confirm — see open questions.

---

## Q4 — Update mechanism

### The docs say AppImage; the source says deb and RPM too

The [updater plugin docs](https://v2.tauri.app/plugin/updater/) mention only AppImage for Linux — "On Linux, Tauri will create the normal AppImage inside the `target/release/bundle/appimage/` folder" — and say nothing about `.deb`. Taken alone this reads as "AppImage only".

The plugin source contradicts that. In [`plugins/updater/src/updater.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs) (branch `v2`), the Linux `install_inner` dispatches on bundle type:

```rust
/// Linux (AppImage, Deb, RPM)
fn install_inner(&self, bytes: &[u8]) -> Result<()> {
    match installer_for_bundle_type(bundle_type()) {
        Some(Installer::Deb) => self.install_deb(bytes),
        Some(Installer::Rpm) => self.install_rpm(bytes),
        _ => self.install_appimage(bytes),
    }
}

fn install_deb(&self, bytes: &[u8]) -> Result<()> {
    if !infer::archive::is_deb(bytes) {
        log::warn!("update is not a valid deb package");
        return Err(Error::InvalidUpdaterFormat);
    }
    self.try_tmp_locations(bytes, "dpkg", "-i", "deb")
}
```

Privilege escalation is tried in order — `pkexec` (graphical), then a `zenity`/`kdialog` password prompt piped to `sudo`, then plain terminal `sudo` (`try_install_with_privileges`). The `Installer` enum includes `AppImage`, `Deb`, `Rpm`, `App`, `Msi`, `Nsis`, and the doc comment for the expected release layout lists `[AppName]_[version]_amd64.deb` and `.rpm` alongside the AppImage tarball.

**How it knows it was installed as a deb** — build-time binary patching, not runtime sniffing. `tauri-utils` declares a placeholder:

```rust
// Variable holding the type of bundle the executable is stored in. This is modified by binary
// patching during build
#[used]
static mut __TAURI_BUNDLE_TYPE: &str = "__TAURI_BUNDLE_TYPE_VAR_UNK";
```
— [`crates/tauri-utils/src/platform.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/platform.rs)

and the bundler rewrites that byte string per target:

```rust
const BUNDLE_VAR_TOKEN: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
fn patch_binary(binary: &PathBuf, package_type: &PackageType) -> crate::Result<()> {
  let bundle_type = match package_type {
    crate::PackageType::Deb => b"__TAURI_BUNDLE_TYPE_VAR_DEB",
    ...
```
— [`crates/tauri-bundler/src/bundle.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs)

`bundle_type()` returns `None` when the marker is still `_UNK` (non-macOS), in which case the Linux path falls through to `install_appimage` — so an unbundled `cargo run` binary gets no deb behaviour. There is a `--no-binary-patching` CLI flag which "Skip[s] patching the main executable with bundle type information", noting "The patching rewrites the binary in place, invalidating an existing code" signature ([`crates/tauri-cli/src/bundle.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/bundle.rs)) — using it disables deb-aware updating.

The updater also appends the installer name to the target key it looks for: it tries `{os}-{arch}-{installer}` (e.g. `linux-x86_64-deb`) before falling back to `{os}-{arch}`, and substitutes a `{{bundle_type}}` placeholder in the endpoint URL. So a static `latest.json` can serve distinct artifacts per package format.

Maturity note: the mutable-static workaround landed via [PR #13812](https://github.com/tauri-apps/tauri/pull/13812) — "Making the static variable mutable so that it's not stripped on stable rust" — a **contributor** PR (author `kandrelczyk`) reviewed by team members `FabianLars` and `Legend-Master`, released in a patch bump (tauri 2.6.2 → 2.6.3). That the mechanism needed a fix to survive compiler optimization on stable Rust suggests deb updating is newer and less battle-tested than the AppImage path. **The feature is real in source but undocumented; treat the docs' silence as a signal about support level, and verify on the exact Tauri version you pin.**

### Options compared

| Option | Auto-update? | Setup cost | Ongoing cost | Notable catch |
|---|---|---|---|---|
| **deb + updater plugin** | Yes (source-confirmed) | Low — enable plugin, sign updates | Publish `.deb` + `latest.json` | Password prompt (`pkexec`/`sudo`) on **every** update; undocumented feature |
| **Manual reinstall** (`dpkg -i`) | No | None | User must notice + act | Simplest, zero infra; poor update adoption |
| **AppImage alongside/instead** | Yes, silent in-place | Low | Publish extra ~70MB+ artifact | Docs' blessed path; size jumps from "2-6 MB to 70+ MB" ([appimage docs](https://v2.tauri.app/distribute/appimage/)); no system integration by default |
| **Self-hosted apt repo** | Yes, via `apt upgrade` | Medium | Regenerate indices + sign per release | Users must add repo + trust key; native UX |
| **Launchpad PPA** | Yes, via `apt upgrade` | High | Source package per release | **Rejects prebuilt binaries** — see below |

### Hosting an apt repository

Minimum viable: a `Packages` index (`.deb` metadata), a `Release` file, and ideally a GPG-signed `InRelease`/`Release.gpg`. [Debian's DebianRepository/Setup wiki](https://wiki.debian.org/DebianRepository/Setup) lists `dak` as "the official solution" for large archives, documents **reprepro** with a manual and short HOWTO, marks **`apt-ftparchive` as deprecated**, and lists **aptly** under "Alternative tools". `dpkg-scanpackages` can generate the `Packages` index. Signing is described as optional but recommended — unsigned repos require `[trusted=yes]` or `--allow-unauthenticated` and are a bad practice.

**Can GitHub Pages serve an apt repo?** Structurally yes — apt only needs plain HTTP(S) GET of a static file tree, and the wiki's own examples are plain `deb http://example.org/debian ...` lines with no server-side requirements. GitHub Pages serves static files over HTTPS, so it satisfies the transport contract. I found **no first-party Debian or GitHub documentation endorsing this specific combination**, and repository size/bandwidth limits on Pages are a practical concern for multi-MB `.deb`s accumulating per release. Marked as reasoned-from-primitives rather than documented.

### Launchpad PPA — verified constraint

The Launchpad reference for PPAs states plainly: **"Source packages only; pre-built binary uploads are rejected"** — [Launchpad manual, PPA reference](https://ubuntu.com/docs/launchpad/user/reference/packaging/ppas/ppa/). So you cannot upload the `.deb` that `tauri build` produced; you must upload a source package that Launchpad's builders compile.

For a Rust + npm app that is genuinely painful: the build must succeed on a Launchpad builder, which means every Cargo crate and every npm package has to be vendored into the source package (or expressed as Ubuntu build-deps), and `cargo`/`npm` must run fully offline. I could **not** find a first-party Launchpad page stating in so many words "builders have no network access" — the search surfaced only indirect signals (build isolation language, and `dep-wait` for unsatisfiable dependencies). The *source-only* requirement is firmly documented; the *no-network-during-build* claim is widely-held but **unconfirmed from a primary source here**, so I'm flagging it rather than asserting it.

There is an old Launchpad answer ([Question #57744](https://answers.launchpad.net/launchpad/+question/57744)) where staff (Christian Reis, Celso Providelo) say shipping binaries is "within our TOU" — but read carefully, that's about *embedding* a prebuilt binary inside a source package (the vmware-player pattern), not uploading a `.deb`. It doesn't contradict the source-only rule. It's a 2009 answer and a maintainer statement on a Q&A site, not current reference docs.

### Read for a single-developer app

- **Most realistic:** ship the `.deb` as the primary artifact and rely on either manual reinstall or the (undocumented but source-backed) deb updater. Zero infrastructure, native install, and the only real cost is a sudo prompt per update.
- **Best auto-update UX:** add an **AppImage** artifact for users who want silent updates, keeping the `.deb` for users who want system integration. The updater's `{os}-{arch}-{installer}` target keys make serving both from one `latest.json` straightforward. Cost is the extra large artifact.
- **Only if a real user base materializes:** a self-hosted apt repo (reprepro or aptly) — genuinely nice UX, but it adds GPG key custody, index regeneration per release, and hosting to a solo maintainer's burden.
- **Realistically out:** a **PPA**, because source-only builds force full Cargo+npm vendoring into a Launchpad-buildable source package.

Not deciding project policy here — presenting the evidence.

---

## Open questions / things that can't be settled from docs

1. **Does the `.deb` updater path actually work end-to-end on Ubuntu?** Source-confirmed, but the official docs never mention it, and the enabling mechanism needed a fix (PR #13812) to survive stable-Rust optimization. Needs an empirical test on the pinned Tauri version before relying on it. Also unverified: whether a `dpkg -i` over a *running* application behaves sanely (the AppImage path swaps the file; deb replaces binaries under a live process).
2. **Whether the CLI validates `version` as strict semver before bundling.** I confirmed the *bundler* does no transformation and that the *updater* parses with the `semver` crate, but did not find the config-load-time validation path. So what `tauri build` does with `version: "1.0.0~beta"` (reject, or pass through to a valid-Debian-but-invalid-semver package) is unconfirmed.
3. **The "default dependencies" wording in the Debian guide.** Docs imply the bundler supplies `libwebkit2gtk-4.1-0`/`libgtk-3-0`; the `dev`-branch source shows `Depends` is config-only with zero hardcoded packages. I grepped the obvious bundler files and the generated JSON schema and found nothing, but I did not read the *entire* CLI/bundler tree. Either the docs are describing intent/what you should set, or injection happens somewhere I didn't look. **Set `depends` explicitly and check `dpkg -I` regardless** — that makes the question moot.
4. **libsoup2 → libsoup3 for v2 is partly inferred.** The WebKitGTK 4.1 requirement is documented first-party; the 4.1↔libsoup3 coupling is a WebKitGTK packaging fact I did not confirm from a Tauri-authored page. Practically irrelevant since libsoup comes in transitively, but the claim isn't fully first-party sourced.
5. **`libappindicator3-1` vs `libayatana-appindicator3-1` runtime package name.** The Debian guide names the former, prerequisites name the Ayatana `-dev` package. I did not run a packages.ubuntu.com query for the exact *runtime* library name per release. Verify before adding either to `depends` (moot for this project if there's no tray).
6. **Ubuntu 20.04 WebKit status is inferred from absence.** packages.ubuntu.com returned no results for focal on both `libwebkit2gtk-4.1-0` and `libsoup-3.0-0`, but focal is past standard support and appears to be de-indexed, so "no results" is weaker evidence than an explicit listing. The conclusion (no 4.1 on 20.04) is consistent with Tauri's own "oldest system that provides 4.1 = 22.04" guidance.
7. **No official Tauri statement of a minimum Ubuntu version number.** The docs give a rule plus a recommended baseline, not a supported-versions table. "Minimum = 22.04" is my derivation from the 4.1 rule + package availability, not a quoted figure.
8. **GitHub Pages as apt-repo host is reasoned, not documented.** apt needs only static HTTPS, which Pages provides, but no primary source endorses the pairing, and Pages' size/bandwidth limits vs accumulating `.deb`s are untested.
9. **Launchpad builder network isolation unconfirmed.** The source-only rule is documented verbatim; "no network access during build" is not, from the pages I reached. It doesn't change the conclusion (vendoring is required either way for reproducible source builds), but the specific mechanism is unverified.
10. **Not investigated:** deb `Installed-Size` correctness, `postInstallScript` interaction with the updater's `dpkg -i`, whether the bundler runs `update-desktop-database`/`gtk-update-icon-cache` in maintainer scripts, and Debian Policy lint compliance (`lintian`) of bundler output — all plausibly relevant later but outside the four questions.
