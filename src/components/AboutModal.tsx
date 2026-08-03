import { useEffect } from "react";
import { useExitAnimation } from "../hooks/useExitAnimation";
import "./AboutModal.css";

interface AboutModalProps {
  isOpen: boolean;
  version: string | null;
  onClose: () => void;
}

export function AboutModal({ isOpen, version, onClose }: AboutModalProps) {
  const { shouldRender, isClosing, handleExitTransitionEnd } = useExitAnimation(isOpen);

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

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      className={isClosing ? "about-backdrop about-backdrop--closing" : "about-backdrop"}
      data-testid="about-backdrop"
      onClick={onClose}
      onTransitionEnd={handleExitTransitionEnd}
    >
      <div
        className={isClosing ? "about-dialog about-dialog--closing" : "about-dialog"}
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
