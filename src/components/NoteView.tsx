import { useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { ATTACHMENT_PROTOCOL, ATTACHMENT_SCHEME, BROKEN_ATTACHMENT_TITLE, attachmentTarget } from "./attachments";
import { copyToClipboard } from "./clipboard";
import { Toast } from "./Toast";
import { useToasts } from "../hooks/useToasts";
import { BROKEN_NOTE_LINK_TITLE, NOTE_LINK_PROTOCOL, NOTE_LINK_SCHEME, noteLinkTarget } from "./noteLinks";
import "./NoteView.css";

/**
 * Rendered notes are untrusted input -- they arrive by git from other machines
 * (spec §9.2) -- so this widens `defaultSchema` by exactly two custom URL
 * schemes, each restricted to the one attribute it's meant for: `note:` on
 * `href` (a cross-note link's ULID; unchanged) and `attachment:` on `src` (an
 * attached image's ULID) -- asymmetric by design, since an attachment is
 * never a navigation target and a note link is never an image source (spec
 * §11.4). Also widens `hljs` class names for syntax highlighting.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs/]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), NOTE_LINK_SCHEME],
    src: [...(defaultSchema.protocols?.src ?? []), ATTACHMENT_SCHEME],
  },
};

/**
 * `react-markdown` blanks any URL outside its own hardcoded protocol list
 * *before* rehype plugins run, so widening `SANITIZE_SCHEMA` alone is not
 * enough to let a `note:`/`attachment:` URL through. This lets exactly those
 * two schemes past and defers every other URL to the stock transform.
 *
 * Each scheme is let through regardless of which attribute it appears on --
 * `SANITIZE_SCHEMA`'s per-attribute protocol lists are what actually keep
 * `attachment:` off `href` and `note:` off `src`, so nothing is widened here
 * by not distinguishing.
 */
function allowNoteSchemeUrl(url: string): string {
  return url.startsWith(NOTE_LINK_PROTOCOL) || url.startsWith(ATTACHMENT_PROTOCOL) ? url : defaultUrlTransform(url);
}

interface NoteViewProps {
  content: string;
  /**
   * Resolves a `note:` link's ULID to a path in the *same* root. Links are
   * same-root only by design, so an ID absent from this map is treated as
   * unresolvable rather than searched for elsewhere.
   */
  resolveNoteLink?: (id: string) => string | null;
  onOpenNoteLink?: (path: string) => void;
  /**
   * Resolves an `attachment:` src's ULID to a displayable image URL (a cached
   * blob URL), triggering the underlying fetch as a side effect if this is
   * the first time this ID has been seen. `undefined` means resolution is in
   * flight; `null` means it's been tried and the attachment isn't found.
   *
   * Owned above `NoteView` (`App.tsx`, not this component) since `NoteView`
   * itself remounts on every edit/preview toggle -- a cache living here would
   * refetch and re-mint object URLs on every toggle instead of once per
   * attachment (spec §11.4).
   */
  resolveAttachment?: (id: string) => string | null | undefined;
}

interface CopyableBlockProps {
  as: "pre" | "blockquote";
  className: string;
  children: React.ReactNode;
  onCopy: (text: string) => void;
}

/** Wraps a rendered `pre` or `blockquote` with an always-mounted, hover/focus-revealed
 * copy button. Reads `textContent` off the rendered element rather than slicing the
 * markdown source, so the copied text matches what's on screen. */
function CopyableBlock({ as: Tag, className, children, onCopy }: CopyableBlockProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    const content = contentRef.current;
    let text = "";
    if (content !== null) {
      // Strip nested copy buttons (e.g. from a blockquote inside this one) before
      // reading textContent, so their "Copy" label doesn't leak into the copied text.
      const clone = content.cloneNode(true) as HTMLDivElement;
      clone.querySelectorAll(".copyable-block__copy-button").forEach((button) => button.remove());
      text = clone.textContent?.trim() ?? "";
    }
    copyToClipboard(text)
      .then(() => onCopy("Copied to clipboard"))
      .catch(() => onCopy("Failed to copy"));
  };

  return (
    <Tag className={className}>
      <div className="copyable-block__content" ref={contentRef}>
        {children}
      </div>
      <button type="button" className="copyable-block__copy-button" aria-label="Copy" onClick={handleCopy}>
        Copy
      </button>
    </Tag>
  );
}

interface NoteLinkProps extends React.ComponentPropsWithoutRef<"a"> {
  resolveNoteLink: ((id: string) => string | null) | undefined;
  onOpenNoteLink: ((path: string) => void) | undefined;
}

/**
 * Renders an anchor, giving `note:` hrefs cross-note behaviour and leaving
 * every other href exactly as it was.
 *
 * A `note:` link whose ULID resolves to nothing renders inert and visibly
 * broken rather than merely failing on click: in a git-synced app an
 * unresolvable target is a normal temporary state (not yet pulled, or in
 * another root), so the user is better served seeing it at a glance.
 */
function NoteLink({ href, children, resolveNoteLink, onOpenNoteLink, ...anchorProps }: NoteLinkProps) {
  const targetId = noteLinkTarget(href);
  // Every other anchor keeps the attributes the sanitizer already vetted --
  // notably the aria and footnote-backref props GFM puts on footnote links.
  if (targetId === null) {
    return (
      <a href={href} {...anchorProps}>
        {children}
      </a>
    );
  }

  const path = resolveNoteLink?.(targetId) ?? null;
  if (path === null) {
    return (
      <span className="note-view__broken-link" title={BROKEN_NOTE_LINK_TITLE} data-testid="broken-note-link">
        {children}
      </span>
    );
  }

  return (
    <a
      {...anchorProps}
      className="note-view__note-link"
      href={`${NOTE_LINK_PROTOCOL}${targetId}`}
      data-testid="note-link"
      onClick={(event) => {
        // The href is not navigable by the webview; opening is ours to do.
        event.preventDefault();
        onOpenNoteLink?.(path);
      }}
    >
      {children}
    </a>
  );
}

interface AttachmentProps extends React.ComponentPropsWithoutRef<"img"> {
  resolveAttachment: ((id: string) => string | null | undefined) | undefined;
}

/**
 * Renders an `img`, giving `attachment:` srcs cached-blob-URL resolution and
 * leaving every other src exactly as it was (there is currently no other
 * image src an untrusted note could carry past the sanitizer, but this stays
 * symmetric with `NoteLink` regardless).
 *
 * Three states, distinct from `NoteLink`'s two: resolved (the image),
 * loading (resolution hasn't settled yet -- a neutral placeholder, since a
 * "broken" look would be misleading for something that just hasn't loaded),
 * and missing (styled and labelled distinctly from a broken note link, since
 * the causes -- and what a fix looks like -- differ).
 */
function Attachment({ src, alt, resolveAttachment, ...imgProps }: AttachmentProps) {
  const targetId = attachmentTarget(src);
  if (targetId === null) {
    // eslint-disable-next-line jsx-a11y/alt-text -- alt is spread in via imgProps.
    return <img src={src} alt={alt} {...imgProps} />;
  }

  // No resolver at all is treated as missing, not loading -- `undefined` is
  // otherwise reserved for "resolution is in flight", which only applies
  // when there's a resolver to eventually settle it.
  const resolved = resolveAttachment === undefined ? null : resolveAttachment(targetId);
  if (resolved === undefined) {
    return <span className="note-view__attachment-loading" data-testid="loading-attachment" />;
  }
  if (resolved === null) {
    return (
      <span className="note-view__broken-attachment" title={BROKEN_ATTACHMENT_TITLE} data-testid="broken-attachment">
        {alt || "Image"}
      </span>
    );
  }

  return <img {...imgProps} src={resolved} alt={alt} className="note-view__attachment" data-testid="attachment" />;
}

export function NoteView({ content, resolveNoteLink, onOpenNoteLink, resolveAttachment }: NoteViewProps) {
  const { toasts, showToast } = useToasts();

  return (
    <div className="note-view" data-testid="note-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, SANITIZE_SCHEMA]]}
        urlTransform={allowNoteSchemeUrl}
        components={{
          pre: ({ className = "", children }) => (
            <CopyableBlock as="pre" className={className} onCopy={showToast}>
              {children}
            </CopyableBlock>
          ),
          blockquote: ({ className = "", children }) => (
            <CopyableBlock as="blockquote" className={className} onCopy={showToast}>
              {children}
            </CopyableBlock>
          ),
          a: ({ children, node: _node, ...anchorProps }) => (
            <NoteLink {...anchorProps} resolveNoteLink={resolveNoteLink} onOpenNoteLink={onOpenNoteLink}>
              {children}
            </NoteLink>
          ),
          img: ({ node: _node, ...imgProps }) => (
            <Attachment {...imgProps} resolveAttachment={resolveAttachment} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
      <Toast toasts={toasts} />
    </div>
  );
}
