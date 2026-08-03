import "./UpdateNotice.css";

interface UpdateNoticeProps {
  version: string;
  onDismiss: () => void;
}

/** Content for the update-available notice (issue #53). Positioning and
 * stacking are owned by NoticeStack; this component only renders the
 * notice's own content. "What's new" is present but inert here -- it opens
 * the changelog modal in a follow-up ticket. */
export function UpdateNotice({ version, onDismiss }: UpdateNoticeProps) {
  return (
    <div className="update-notice" role="status">
      <p>{version} available</p>
      <div className="update-notice__actions">
        <button type="button">What's new</button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
