import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";

describe("DeleteConfirmDialog", () => {
  it("asks to confirm deleting a note by name, with no content counts", () => {
    render(
      <DeleteConfirmDialog
        itemName="my-note.md"
        isDirectory={false}
        contents={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(/my-note\.md/)).toBeDefined();
    expect(screen.queryByText(/note/i, { selector: "p" })).toBeNull();
  });

  it("states the recursive note and subfolder counts for a folder", () => {
    render(
      <DeleteConfirmDialog
        itemName="my-folder"
        isDirectory
        contents={{ noteCount: 200, folderCount: 3 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/200 notes/)).toBeDefined();
    expect(screen.getByText(/3 subfolders/)).toBeDefined();
  });

  it("says a folder is empty when it has no contents", () => {
    render(
      <DeleteConfirmDialog
        itemName="empty-folder"
        isDirectory
        contents={{ noteCount: 0, folderCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/is empty/i)).toBeDefined();
  });

  it("calls onConfirm when the Delete button is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog itemName="note.md" isDirectory={false} contents={null} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when the Cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog itemName="note.md" isDirectory={false} contents={null} onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel on Escape", async () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog itemName="note.md" isDirectory={false} contents={null} onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    await userEvent.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalled();
  });
});
