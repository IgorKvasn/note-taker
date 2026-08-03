import { Children, type ReactNode } from "react";
import "./NoticeStack.css";

interface NoticeStackProps {
  children: ReactNode;
}

/** Fixed bottom-right container that stacks app-level notices in a vertical
 * column. Individual notices (e.g. LocalOnlyNotice) are plain content
 * components with no positioning of their own -- this container owns that.
 *
 * Ordering: the first child is anchored nearest the corner (bottom-most,
 * via `flex-direction: column-reverse`), and each subsequent child stacks
 * above it. So the least urgent/oldest notice goes first, and a new,
 * more urgent notice (e.g. an update-check prompt) is appended after it to
 * appear above. */
export function NoticeStack({ children }: NoticeStackProps) {
  // `Children.toArray` (unlike `Children.count`) drops booleans/null/undefined,
  // so conditionally-rendered notices (e.g. `{show && <Notice />}`) don't count
  // as present children when absent.
  if (Children.toArray(children).length === 0) {
    return null;
  }

  return (
    <div className="notice-stack" data-testid="notice-stack">
      {children}
    </div>
  );
}
