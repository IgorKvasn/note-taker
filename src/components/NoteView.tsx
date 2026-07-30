import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
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

export function NoteView({ content }: NoteViewProps) {
  return (
    <div className="note-view" data-testid="note-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, SANITIZE_SCHEMA]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
