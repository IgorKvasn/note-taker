import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutModal } from "./AboutModal";

describe("AboutModal", () => {
  it("renders nothing while closed", () => {
    render(<AboutModal isOpen={false} version="1.2.3" onClose={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the version it was given", () => {
    render(<AboutModal isOpen version="1.2.3" onClose={vi.fn()} />);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("1.2.3")).toBeDefined();
  });

  it("shows a placeholder until the version has loaded", () => {
    render(<AboutModal isOpen version={null} onClose={vi.fn()} />);

    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<AboutModal isOpen version="1.2.3" onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<AboutModal isOpen version="1.2.3" onClose={onClose} />);

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(<AboutModal isOpen version="1.2.3" onClose={onClose} />);

    await userEvent.click(screen.getByTestId("about-backdrop"));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open when the dialog body itself is clicked", async () => {
    const onClose = vi.fn();
    render(<AboutModal isOpen version="1.2.3" onClose={onClose} />);

    await userEvent.click(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog mounted after isOpen goes false, until the exit transition ends", () => {
    const { rerender } = render(<AboutModal isOpen version="1.2.3" onClose={vi.fn()} />);

    rerender(<AboutModal isOpen={false} version="1.2.3" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.transitionEnd(screen.getByTestId("about-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unmounts via a fallback timer if no transition event ever arrives", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AboutModal isOpen version="1.2.3" onClose={vi.fn()} />);

      rerender(<AboutModal isOpen={false} version="1.2.3" onClose={vi.fn()} />);
      act(() => vi.advanceTimersByTime(1000));

      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
