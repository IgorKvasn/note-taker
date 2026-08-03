import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateNotice } from "./UpdateNotice";

describe("UpdateNotice", () => {
  it("names the available version with role=status", () => {
    render(<UpdateNotice version="v0.7.0" onDismiss={() => {}} onShowChangelog={() => {}} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("v0.7.0 available");
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    render(<UpdateNotice version="v0.7.0" onDismiss={onDismiss} onShowChangelog={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("calls onShowChangelog when the What's new button is clicked", async () => {
    const onShowChangelog = vi.fn();
    render(<UpdateNotice version="v0.7.0" onDismiss={() => {}} onShowChangelog={onShowChangelog} />);

    await userEvent.click(screen.getByRole("button", { name: "What's new" }));

    expect(onShowChangelog).toHaveBeenCalledOnce();
  });
});
