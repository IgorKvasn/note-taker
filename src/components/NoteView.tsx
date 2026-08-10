import { useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { copyToClipboard } from "./clipboard";
import { Toast } from "./Toast";
import { useToasts } from "../hooks/useToasts";
import { BROKEN_NOTE_LINK_TITLE, NOTE_LINK_PROTOCOL, NOTE_LINK_SCHEME, noteLinkTarget } from "./noteLinks";
import { ATTACHMENT_PROTOCOL, ATTACHMENT_SCHEME, BROKEN_ATTACHMENT_TITLE, attachmentTarget } from "./attachments";
import "./NoteView.css";

/**
 * Rendered notes are untrusted input -- they arrive by git from other machines
 * (spec §9.2) -- so this widens `defaultSchema` by exactly two things beyond
 * the `hljs` class names syntax highlighting needs: the `note:` href protocol
 * carrying a cross-note link's ULID, and the `attachment:` src protocol
 * carrying an image's ULID. The widening is asymmetric (spec §11.4): `note:`
 * is href-only (it's not an image to render), `attachment:` is src-only (it's
 * not a navigation target).
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
 * enough to let a `note:` href or `attachment:` src through. This lets those
 * two schemes past and defers every other URL to the stock transform.
 *
 * Each scheme is still restricted to one attribute by `SANITIZE_SCHEMA`
 * itself: an `![alt](note:...)` image's `src` is stripped downstream, as is a
 * `[text](attachment:...)` link's `href`.
 */
function allowNoteSchemeUrl(url: string): string {
  return url.startsWith(NOTE_LINK_PROTOCOL) || url.startsWith(ATTACHMENT_PROTOCOL) ? url : defaultUrlTransform(url);
}

/**
 * Resolves an `attachment:` ULID to a displayable `blob:` URL, or `null` if
 * the file isn't found. `undefined` means resolution is still in flight.
 *
 * Owned above `NoteView` rather than as a component-local hook (spec §11.4):
 * `NoteView` unmounts on every Edit/Preview toggle, and caching by
 * `(rootId, id)` above that point means a blob URL survives the toggle
 * instead of being re-fetched and re-minted every time.
 */
type ResolveAttachment = (id: string) => string | null | undefined;

interface NoteViewProps {
  content: string;
  /**
   * Resolves a `note:` link's ULID to a path in the *same* root. Links are
   * same-root only by design, so an ID absent from this map is treated as
   * unresolvable rather than searched for elsewhere.
   */
  resolveNoteLink?: (id: string) => string | null;
  onOpenNoteLink?: (path: string) => void;
  /** Resolves `attachment:` image references; see `ResolveAttachment`. */
  resolveAttachment?: ResolveAttachment;
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
  resolveAttachment: ResolveAttachment | undefined;
}

/**
 * Renders an `attachment:` src as an image via the resolver's cached `blob:`
 * URL, and leaves every other src exactly as it was.
 *
 * Three visually distinct states (spec §11.4) so a slow sync is never
 * mistaken for a permanently-missing file: resolved (the image), loading (a
 * neutral placeholder, no tooltip), missing (a distinct placeholder, with a
 * tooltip, `data-testid="broken-attachment"`).
 */
function Attachment({ src, alt, resolveAttachment, ...imgProps }: AttachmentProps) {
  const targetId = attachmentTarget(src);
  if (targetId === null) {
    // eslint-disable-next-line jsx-a11y/alt-text -- alt is already in imgProps
    return <img src={src} alt={alt} {...imgProps} />;
  }

  const resolved = resolveAttachment === undefined ? null : resolveAttachment(targetId);

  if (resolved === undefined) {
    return <span className="note-view__attachment-placeholder note-view__attachment-placeholder--loading" />;
  }

  if (resolved === null) {
    return (
      <span
        className="note-view__attachment-placeholder note-view__attachment-placeholder--broken"
        title={BROKEN_ATTACHMENT_TITLE}
        data-testid="broken-attachment"
      />
    );
  }

  return <img {...imgProps} src={resolved} alt={alt} />;
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
