import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

/** Content-styling decorations, keyed by the syntax node type they apply to. */
const CONTENT_DECORATIONS: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-live-preview-strong" }),
  Emphasis: Decoration.mark({ class: "cm-live-preview-emphasis" }),
  Strikethrough: Decoration.mark({ class: "cm-live-preview-strikethrough" }),
  InlineCode: Decoration.mark({ class: "cm-live-preview-code" }),
  ATXHeading1: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-1" }),
  ATXHeading2: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-2" }),
  ATXHeading3: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-3" }),
  ATXHeading4: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-4" }),
  ATXHeading5: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-5" }),
  ATXHeading6: Decoration.mark({ class: "cm-live-preview-heading cm-live-preview-heading-6" }),
  Blockquote: Decoration.mark({ class: "cm-live-preview-blockquote" }),
};

/** Marker-token node types (the `**`, `#`, `~~`, `` ` ``, `>` themselves), de-emphasized
 * separately from the content they wrap so the raw syntax stays visible but muted. */
const MARKER_NODE_TYPES = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "HeaderMark",
  "QuoteMark",
]);

const markerDecoration = Decoration.mark({ class: "cm-live-preview-marker" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const contentDecoration = CONTENT_DECORATIONS[node.name];
        if (contentDecoration !== undefined) {
          ranges.push({ from: node.from, to: node.to, decoration: contentDecoration });
          return;
        }
        if (MARKER_NODE_TYPES.has(node.name)) {
          ranges.push({ from: node.from, to: node.to, decoration: markerDecoration });
        }
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of ranges) {
    if (range.from < range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }
  return builder.finish();
}

/** Applies live-preview inline styling (bold, italic, strikethrough, inline code, headings,
 * blockquotes) directly to the raw markdown as the syntax tree updates, so formatting is
 * visible while the raw syntax markers -- shown dimmed -- remain in place and editable. */
export const markdownLivePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);
