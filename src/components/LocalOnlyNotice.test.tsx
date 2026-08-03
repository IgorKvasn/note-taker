import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LocalOnlyNotice } from "./LocalOnlyNotice";

describe("LocalOnlyNotice", () => {
  it("renders the notice text with role=status", () => {
    render(<LocalOnlyNotice onDismiss={() => {}} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/local/i);
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    render(<LocalOnlyNotice onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
