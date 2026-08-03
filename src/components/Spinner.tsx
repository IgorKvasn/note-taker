import "./Spinner.css";

interface SpinnerProps {
  /** Accessible label, also shown as the static text under reduced motion. */
  label?: string;
  /**
   * Delays the spinner's visibility so a fast operation never flashes it
   * (issue #60). Off by default -- callers with a naturally slow/ongoing
   * operation (e.g. an inline in-progress indicator) can skip the delay.
   */
  delayed?: boolean;
}

/**
 * Shared loading indicator for boot, note-open, and similar spots where an
 * async operation has no other visible feedback.
 *
 * Under `prefers-reduced-motion: reduce`, the rotating ring is hidden in
 * favor of a static/fading label -- the global reduced-motion catch-all in
 * `styles.css` forces every animation to run for exactly one iteration, which
 * would otherwise freeze the ring mid-rotation.
 */
export function Spinner({ label = "Loading…", delayed = false }: SpinnerProps) {
  return (
    <div
      className={`spinner${delayed ? " spinner--delayed" : ""}`}
      role="status"
      aria-live="polite"
      data-testid="spinner"
    >
      <span className="spinner__ring" aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </div>
  );
}
