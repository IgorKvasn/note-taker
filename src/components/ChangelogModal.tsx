import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReleaseInfo } from "../ipc";
import { useExitAnimation } from "../hooks/useExitAnimation";
import "./ChangelogModal.css";

interface ChangelogModalProps {
  isOpen: boolean;
  releases: ReleaseInfo[];
  onClose: () => void;
}

/**
 * Release notes are remote content fetched from GitHub, with no `note:` links
 * or syntax-highlighted code blocks to account for -- so this renders through
 * the stock `rehype-sanitize` schema rather than `NoteView`'s widened one,
 * keeping every link restricted to the sanitizer's default safe protocols.
 */
export function ChangelogModal({ isOpen, releases, onClose }: ChangelogModalProps) {
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

  const newestRelease = releases[0] ?? null;

  return (
    <div
      className={isClosing ? "changelog-backdrop changelog-backdrop--closing" : "changelog-backdrop"}
      data-testid="changelog-backdrop"
      onClick={onClose}
      onTransitionEnd={handleExitTransitionEnd}
    >
      <div
        className={isClosing ? "changelog-dialog changelog-dialog--closing" : "changelog-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="changelog-dialog__title" id="changelog-title">
          What's new
        </h2>
        <div className="changelog-dialog__releases">
          {releases.map((release) => (
            <section key={release.version} className="changelog-dialog__release">
              <h3>{release.version}</h3>
              {release.notes.trim() === "" ? (
                <p className="changelog-dialog__no-notes">No release notes.</p>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, defaultSchema]]}>
                  {release.notes}
                </ReactMarkdown>
              )}
            </section>
          ))}
        </div>
        <div className="changelog-dialog__actions">
          {newestRelease !== null && (
            <button type="button" onClick={() => void openUrl(newestRelease.url)}>
              View on GitHub
            </button>
          )}
          <button className="changelog-dialog__close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
