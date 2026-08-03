import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChangelogModal } from "./ChangelogModal";
import type { ReleaseInfo } from "../ipc";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const RELEASES: ReleaseInfo[] = [
  { version: "v0.8.0", notes: "- newest feature", url: "https://github.com/IgorKvasn/note-taker/releases/tag/v0.8.0" },
  { version: "v0.7.0", notes: "- older feature", url: "https://github.com/IgorKvasn/note-taker/releases/tag/v0.7.0" },
];

describe("ChangelogModal", () => {
  it("renders nothing while closed", () => {
    render(<ChangelogModal isOpen={false} releases={RELEASES} onClose={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every release newest-first, each headed by its version", () => {
    render(<ChangelogModal isOpen releases={RELEASES} onClose={vi.fn()} />);

    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["v0.8.0", "v0.7.0"]);
  });

  it("renders release notes as formatted markdown", () => {
    render(<ChangelogModal isOpen releases={RELEASES} onClose={vi.fn()} />);

    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["newest feature", "older feature"]);
  });

  it("still renders a release's section when its notes are empty", () => {
    render(
      <ChangelogModal
        isOpen
        releases={[{ version: "v0.9.0", notes: "", url: "https://example.com/v0.9.0" }]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "v0.9.0" })).toBeDefined();
    expect(screen.getByText("No release notes.")).toBeDefined();
  });

  it("opens the newest release's URL from the backend data when the GitHub button is clicked", async () => {
    render(<ChangelogModal isOpen releases={RELEASES} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "View on GitHub" }));

    expect(openUrl).toHaveBeenCalledWith("https://github.com/IgorKvasn/note-taker/releases/tag/v0.8.0");
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<ChangelogModal isOpen releases={RELEASES} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ChangelogModal isOpen releases={RELEASES} onClose={onClose} />);

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(<ChangelogModal isOpen releases={RELEASES} onClose={onClose} />);

    await userEvent.click(screen.getByTestId("changelog-backdrop"));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open when the dialog body itself is clicked", async () => {
    const onClose = vi.fn();
    render(<ChangelogModal isOpen releases={RELEASES} onClose={onClose} />);

    await userEvent.click(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog mounted after isOpen goes false, until the exit transition ends", () => {
    const { rerender } = render(<ChangelogModal isOpen releases={RELEASES} onClose={vi.fn()} />);

    rerender(<ChangelogModal isOpen={false} releases={RELEASES} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.transitionEnd(screen.getByTestId("changelog-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unmounts via a fallback timer if no transition event ever arrives", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ChangelogModal isOpen releases={RELEASES} onClose={vi.fn()} />);

      rerender(<ChangelogModal isOpen={false} releases={RELEASES} onClose={vi.fn()} />);
      act(() => vi.advanceTimersByTime(1000));

      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
