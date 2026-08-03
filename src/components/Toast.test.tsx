import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Toast } from "./Toast";

describe("Toast", () => {
  it("renders nothing when there are no toasts", () => {
    const { container } = render(<Toast toasts={[]} />);

    expect(container.querySelectorAll('[role="status"]').length).toBe(0);
  });

  it("renders each toast's message with role=status", () => {
    render(
      <Toast
        toasts={[
          { id: 1, message: "Copied to clipboard", isExiting: false },
          { id: 2, message: "Failed to copy", isExiting: false },
        ]}
      />,
    );

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(screen.getByText("Copied to clipboard")).toBeDefined();
    expect(screen.getByText("Failed to copy")).toBeDefined();
  });

  it("applies the closing class to a toast marked isExiting", () => {
    render(<Toast toasts={[{ id: 1, message: "Copied to clipboard", isExiting: true }]} />);

    expect(screen.getByRole("status").className).toContain("toast-stack__toast--closing");
  });

  it("does not apply the closing class to a toast that isn't exiting", () => {
    render(<Toast toasts={[{ id: 1, message: "Copied to clipboard", isExiting: false }]} />);

    expect(screen.getByRole("status").className).not.toContain("toast-stack__toast--closing");
  });
});
