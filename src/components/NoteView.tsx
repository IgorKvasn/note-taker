import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { copyToClipboard } from "./clipboard";
import { Toast } from "./Toast";
import { useToasts } from "../hooks/useToasts";
import "./NoteView.css";

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs/]],
  },
};

interface NoteViewProps {
  content: string;
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

export function NoteView({ content }: NoteViewProps) {
  const { toasts, showToast } = useToasts();

  return (
    <div className="note-view" data-testid="note-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, SANITIZE_SCHEMA]]}
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
        }}
      >
        {content}
      </ReactMarkdown>
      <Toast toasts={toasts} />
    </div>
  );
}
