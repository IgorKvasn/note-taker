import "./LocalOnlyNotice.css";

interface LocalOnlyNoticeProps {
  onDismiss: () => void;
}

/** Content for the one-time local-only-sync notice (spec §7). Positioning
 * and stacking are owned by NoticeStack; this component only renders the
 * notice's own content. */
export function LocalOnlyNotice({ onDismiss }: LocalOnlyNoticeProps) {
  return (
    <div className="local-only-notice" role="status">
      <p>
        Notes here are saved and committed locally. Sync to a remote is off (or none is configured), so nothing
        leaves this machine automatically.
      </p>
      <button type="button" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
