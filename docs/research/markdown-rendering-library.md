# View-mode markdown renderer: recommendation

## Recommendation

**`react-markdown` + `remark-gfm` + `rehype-sanitize`** (add `rehype-highlight` for fenced-code syntax highlighting).

Main tradeoff: this stack is CommonMark + GFM by default, matching `@lezer/markdown`'s GFM bundle feature-for-feature (tables, task lists, strikethrough, autolinks) with essentially the same edge-case philosophy, and it sanitizes untrusted output by default (important since notes may be synced via git from other machines/people). The cost is more setup than `marked` (multiple plugins to wire up) and a somewhat heavier dependency tree (remark/unified ecosystem) than a single-file library like `marked` or `markdown-it`.

---

## Ground truth: what CodeMirror actually accepts

- `@lezer/markdown` is "an incremental Markdown (CommonMark with support for extension) parser," and explicitly does not fully conform to CommonMark (e.g., doesn't validate link references) — [github.com/lezer-parser/markdown](https://github.com/lezer-parser/markdown).
- It ships a **GFM extension bundle**: Table, TaskList (`[ ]`/`[x]`), Strikethrough (`~~`), and Autolink (`www.`/`http(s)://`/`mailto:`/`xmpp:`) — same source, and confirmed via [npm](https://www.npmjs.com/package/@lezer/markdown).
- `@codemirror/lang-markdown`'s `markdownLanguage` export is described as "Language support for [GFM](https://github.github.com/gfm/) plus subscript, superscript, and emoji syntax" — i.e. **GFM is the default dialect for edit mode**, not opt-in — [github.com/codemirror/lang-markdown](https://github.com/codemirror/lang-markdown).

So the target to match is: **CommonMark + GFM (tables, task lists, strikethrough, autolinks)**, plus awareness that subscript/superscript/emoji syntax will highlight in the editor but won't render in view mode unless explicitly added.

---

## Candidate comparison

| | Default dialect | GFM parity | Code highlighting | Sanitization | React integration | Size/perf |
|---|---|---|---|---|---|---|
| **react-markdown** | CommonMark by default: "react-markdown follows CommonMark, which standardizes the differences between markdown implementations, by default" ([README](https://github.com/remarkjs/react-markdown)) | Needs `remark-gfm` (not bundled) | Needs `rehype-highlight` (highlight.js/lowlight) or `rehype-starry-night`; no built-in highlighting ([rehype-highlight](https://github.com/rehypejs/rehype-highlight)) | **Secure by default** — HTML in markdown is escaped/ignored unless you opt in via `rehype-raw`; `rehype-sanitize` recommended for a defined-safe schema ([README](https://github.com/remarkjs/react-markdown)) | First-party maintained React component (`remarkjs/react-markdown`); no `dangerouslySetInnerHTML` needed | Built on remark/unified (see micromark below); `rehype-raw` alone adds ~60kb minzipped if used |
| **remark-gfm** (plugin for react-markdown) | N/A — plugin | Adds "autolink literals, footnotes, strikethrough, tables, and tasklists" per GFM ([README](https://github.com/remarkjs/remark-gfm)) | — | — | — | Notes known GitHub-implementation quirks; single-tilde strikethrough enabled by default (matches GitHub, technically outside strict GFM spec), configurable via `singleTilde: false` |
| **micromark** (engine under remark) | CommonMark: "passes all tests from CommonMark and has many more tests to match the CommonMark reference parsers" ([README](https://github.com/micromark/micromark)) | Via `micromark-extension-gfm`, claimed "100% GFM compliance" | No | Safe by default — "encoding or dropping dangerous HTML/protocols"; opt-in unsafe mode available | Not a React library itself — it's what remark is built on | ~14kB minified core; remark is described as built on top of it |
| **markdown-it** | CommonMark "+ adds syntax extensions & sugar" ([README](https://github.com/markdown-it/markdown-it)) | Tables and Strikethrough built in; **task lists require a separate plugin** (e.g. `markdown-it-task-lists`) — not bundled | No built-in highlighter; exposes a `highlight` callback for e.g. highlight.js | `html: false` by default (raw HTML disabled); not a sanitizer in itself, no automatic sanitization of allowed constructs | No official React wrapper — plain JS API, integrate via `dangerouslySetInnerHTML` | Emphasizes speed benchmarks in README; no official bundle-size figure found in primary source |
| **marked** | Claims broad spec support; self-reported compliance table: CommonMark 0.31 at 98%, GFM 0.29 at 97%, with "Disallowed Raw HTML" at 0% and tables/task-lists/strikethrough each 100% ([marked.js.org](https://marked.js.org/)) | Tables, task lists, strikethrough all pass its own listed conformance tests | No built-in highlighting; historically via extensions/callbacks (highlight.js commonly wired in manually) | **Explicitly does not sanitize**: "Marked does not sanitize the output HTML. Please use a sanitize library, like DOMPurify (recommended)..." ([README](https://github.com/markedjs/marked)) | No official React wrapper; manual `dangerouslySetInnerHTML` + manual DOMPurify pass | Markets itself as "built for speed," "low-level compiler... without caching or blocking" |

---

## Notes per criterion

**1. Dialect target.** All five track CommonMark as the base. Only `@lezer/markdown`'s GFM bundle, `remark-gfm`, `micromark-extension-gfm`, and `marked`'s built-ins reach full GFM parity out of the box; `markdown-it` needs an extra plugin for task lists specifically.

**2. Code highlighting.** None of the candidates highlight fenced code by default — this is universal across the ecosystem. All require wiring in highlight.js, Shiki, or Prism. `react-markdown`'s rehype ecosystem has ready-made plugins (`rehype-highlight`, `rehype-starry-night`); `markdown-it`/`marked` expect a manual callback/post-process step.

**3. Security.** This is the sharpest differentiator. `marked` is explicit that sanitization is the caller's job. `markdown-it` disables raw HTML by default but doesn't sanitize the constructs it does allow (e.g., link protocols) unless configured. `react-markdown`/remark/micromark are "secure by default" — raw HTML is escaped unless explicitly re-enabled via `rehype-raw`, and `rehype-sanitize` is the documented way to allow a safe subset. Given notes may sync via git from untrusted sources, default-safe behavior is a real advantage.

**4. React integration.** `react-markdown` is the only one with a maintained, first-party React component consuming a virtual AST (no `dangerouslySetInnerHTML`). `markdown-it` and `marked` require manual HTML injection.

**5. Bundle/performance.** `markdown-it` and `marked` both foreground speed benchmarks in their own docs. `micromark` documents itself as ~14kB minified. `react-markdown`'s own overhead is the remark/unified/micromark chain plus whichever rehype plugins are added (e.g., `rehype-raw` at ~60kB minzipped if raw HTML support is needed — not needed for the sanitize-by-default path recommended here). For a desktop Tauri app rendering local notes (not a high-volume web page), none of these differences are likely to be perceptible; correctness/security tradeoffs dominate the choice.

---

## Dialect-compatibility verdict

`@codemirror/lang-markdown` defaults to GFM (tables, task lists, strikethrough, autolinks) plus subscript/superscript/emoji. `react-markdown` + `remark-gfm` reaches the same GFM feature set (and remark-gfm additionally enables footnotes, which lezer's bundle doesn't include — worth flagging as an editor/view asymmetry if footnotes are ever typed). Both sides are CommonMark-based parsers with known, documented divergences from the strict spec (lezer skips link-reference validation; remark-gfm follows GitHub's real quirky behavior over the written GFM spec, e.g. single-tilde strikethrough). This is the closest achievable alignment across the two ecosystems without hand-rolling one parser to match the other exactly.

Two residual gaps to track if parity must be exact:
- CodeMirror's `markdownLanguage` also highlights subscript/superscript/emoji syntax that plain `remark-gfm` won't render — would need extra remark plugins (`remark-supersub`, emoji plugin) to close.
- `remark-gfm` includes footnotes; lezer's GFM bundle does not — footnote syntax would highlight as plain text in the editor but render as a footnote in view mode unless lezer's footnote extension (if any) is also enabled, or footnotes are disabled in `remark-gfm`.
