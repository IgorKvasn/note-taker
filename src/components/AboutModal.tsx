import { useEffect } from "react";
import "./AboutModal.css";

interface AboutModalProps {
  isOpen: boolean;
  version: string | null;
  onClose: () => void;
}

export function AboutModal({ isOpen, version, onClose }: AboutModalProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="about-backdrop" data-testid="about-backdrop" onClick={onClose}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="about-dialog__title" id="about-title">
          note-taker
        </h2>
        <dl className="about-dialog__facts">
          <dt>Version</dt>
          <dd>{version ?? "Loading…"}</dd>
        </dl>
        <button className="about-dialog__close" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
