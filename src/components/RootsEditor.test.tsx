import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootsEditor } from "./RootsEditor";
import type { Config, DeletedAttachment, RootConfig, RootValidation } from "../ipc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const EXISTING_ROOT: RootConfig = {
  id: "01EXISTING",
  path: "/home/user/notes",
  auto_sync: true,
  remote_url: "git@example.com:user/notes.git",
};

function emptyValidation(overrides: Partial<RootValidation> = {}): RootValidation {
  return {
    exists: true,
    is_writable: true,
    is_git_repo: false,
    has_remote: false,
    remote_url: null,
    ...overrides,
  };
}

describe("RootsEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the initial roots", () => {
    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    expect(screen.getByText(EXISTING_ROOT.path)).toBeDefined();
  });

  it("adds a root after a folder is picked, prefilling auto-detected remote", async () => {
    const newPath = "/home/user/new-root";
    invoke.mockImplementation((command: string) => {
      if (command === "pick_folder") return Promise.resolve(newPath);
      if (command === "validate_root_path") {
        return Promise.resolve(
          emptyValidation({ is_git_repo: true, has_remote: true, remote_url: "git@example.com:x.git" }),
        );
      }
      return Promise.resolve(undefined);
    });

    render(<RootsEditor initialRoots={[]} canCancel={false} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Add root…" }));

    expect(await screen.findByText(newPath)).toBeDefined();
    expect(screen.getByDisplayValue("git@example.com:x.git")).toBeDefined();
  });

  it("does not add a row when the folder picker is cancelled", async () => {
    invoke.mockResolvedValue(null);
    render(<RootsEditor initialRoots={[]} canCancel={false} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Add root…" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("pick_folder"));
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("re-points a root's path via the folder picker", async () => {
    const newPath = "/home/user/repointed-notes";
    invoke.mockImplementation((command: string) => {
      if (command === "pick_folder") return Promise.resolve(newPath);
      if (command === "validate_root_path") {
        return Promise.resolve(emptyValidation({ is_git_repo: true, has_remote: false }));
      }
      return Promise.resolve(undefined);
    });

    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: `Change ${EXISTING_ROOT.path}` }));

    expect(await screen.findByText(newPath)).toBeDefined();
    expect(screen.queryByText(EXISTING_ROOT.path)).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("validate_root_path", { path: newPath }));
  });

  it("keeps the existing path when re-pointing is cancelled", async () => {
    invoke.mockResolvedValue(null);
    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: `Change ${EXISTING_ROOT.path}` }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("pick_folder"));
    expect(screen.getByText(EXISTING_ROOT.path)).toBeDefined();
  });

  it("removes a row without calling the backend", async () => {
    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: `Remove ${EXISTING_ROOT.path}` }));

    expect(screen.queryByText(EXISTING_ROOT.path)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves the edited draft and reports the resulting config", async () => {
    const savedConfig: Config = { version: 1, roots: [EXISTING_ROOT] };
    invoke.mockResolvedValue(savedConfig);
    const onSaved = vi.fn();

    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={onSaved} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_config", {
        drafts: [
          {
            id: EXISTING_ROOT.id,
            path: EXISTING_ROOT.path,
            auto_sync: EXISTING_ROOT.auto_sync,
            remote_url: EXISTING_ROOT.remote_url,
            create_if_missing: false,
          },
        ],
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(savedConfig);
  });

  it("shows the backend error and keeps the draft editable when save fails", async () => {
    invoke.mockRejectedValue(new Error("validation failed, no changes were made: bad path"));

    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("validation failed");
    expect(screen.getByText(EXISTING_ROOT.path)).toBeDefined();
  });

  it("disables Save when two roots share the same path", async () => {
    const secondPath = "/home/user/notes-2";
    invoke.mockImplementation((command: string) => {
      if (command === "pick_folder") return Promise.resolve(EXISTING_ROOT.path);
      if (command === "validate_root_path") return Promise.resolve(emptyValidation());
      return Promise.resolve(undefined);
    });

    render(
      <RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add root…" }));
    await screen.findAllByText(EXISTING_ROOT.path);

    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    void secondPath;
  });

  it("calls onCancel when cancel is available and clicked", async () => {
    const onCancel = vi.fn();
    render(
      <RootsEditor
        initialRoots={[EXISTING_ROOT]}
        canCancel
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hides cancel when first-run setup cannot be dismissed", () => {
    render(<RootsEditor initialRoots={[]} canCancel={false} onSaved={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("disables Save with no roots", () => {
    render(<RootsEditor initialRoots={[]} canCancel={false} onSaved={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not offer attachment cleanup for a root added this session", () => {
    render(<RootsEditor initialRoots={[]} canCancel={false} onSaved={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Clean up unused attachments/ })).toBeNull();
  });

  describe("attachment cleanup", () => {
    const candidates: DeletedAttachment[] = [
      { file_name: "01A-orphan.png", size_bytes: 1024 * 1024 },
      { file_name: "01B-orphan.png", size_bytes: 512 * 1024 },
    ];

    it("shows a toast directly when a dry run finds nothing to delete", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "cleanup_unused_attachments") return Promise.resolve([]);
        return Promise.resolve(undefined);
      });

      render(<RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />);

      await userEvent.click(
        screen.getByRole("button", { name: `Clean up unused attachments in ${EXISTING_ROOT.path}` }),
      );

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("cleanup_unused_attachments", {
          rootId: EXISTING_ROOT.id,
          openBufferContent: null,
          dryRun: true,
        }),
      );
      expect(await screen.findByText("No unused attachments found.")).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows a confirmation dialog with count and size when the dry run finds candidates", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "cleanup_unused_attachments") return Promise.resolve(candidates);
        return Promise.resolve(undefined);
      });

      render(<RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />);

      await userEvent.click(
        screen.getByRole("button", { name: `Clean up unused attachments in ${EXISTING_ROOT.path}` }),
      );

      expect(await screen.findByRole("dialog")).toBeDefined();
      expect(screen.getByText("2 unused attachments, 1.5 MB — Delete?")).toBeDefined();
    });

    it("re-invokes with dryRun false on confirm and reports the deleted count", async () => {
      invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
        if (command === "cleanup_unused_attachments") {
          return Promise.resolve(args?.dryRun === true ? candidates : candidates);
        }
        return Promise.resolve(undefined);
      });

      render(<RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />);

      await userEvent.click(
        screen.getByRole("button", { name: `Clean up unused attachments in ${EXISTING_ROOT.path}` }),
      );
      await screen.findByRole("dialog");

      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("cleanup_unused_attachments", {
          rootId: EXISTING_ROOT.id,
          openBufferContent: null,
          dryRun: false,
        }),
      );
      expect(await screen.findByText("Deleted 2 unused attachments (1.5 MB).")).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes the dialog without deleting when cancelled", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "cleanup_unused_attachments") return Promise.resolve(candidates);
        return Promise.resolve(undefined);
      });

      render(<RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />);

      await userEvent.click(
        screen.getByRole("button", { name: `Clean up unused attachments in ${EXISTING_ROOT.path}` }),
      );
      await screen.findByRole("dialog");
      invoke.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    });

    it("shows an error and does not open the dialog when the dry run fails", async () => {
      invoke.mockImplementation((command: string) => {
        if (command === "cleanup_unused_attachments") return Promise.reject(new Error("root not found"));
        return Promise.resolve(undefined);
      });

      render(<RootsEditor initialRoots={[EXISTING_ROOT]} canCancel={false} onSaved={vi.fn()} />);

      await userEvent.click(
        screen.getByRole("button", { name: `Clean up unused attachments in ${EXISTING_ROOT.path}` }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("root not found");
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
