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
          { id: 1, message: "Copied to clipboard" },
          { id: 2, message: "Failed to copy" },
        ]}
      />,
    );

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(screen.getByText("Copied to clipboard")).toBeDefined();
    expect(screen.getByText("Failed to copy")).toBeDefined();
  });
});
