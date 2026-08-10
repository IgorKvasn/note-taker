import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDismissableMenu } from "./useDismissableMenu";

describe("useDismissableMenu", () => {
  it("closes on a pointerdown outside the attached element", () => {
    const onClose = vi.fn();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const { result } = renderHook(() => useDismissableMenu<HTMLDivElement>(onClose));
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    result.current.current = menu;

    fireEvent.mouseDown(outside);

    expect(onClose).toHaveBeenCalledOnce();

    outside.remove();
    menu.remove();
  });

  it("does not close on a pointerdown inside the attached element", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDismissableMenu<HTMLDivElement>(onClose));
    const menu = document.createElement("div");
    const child = document.createElement("button");
    menu.appendChild(child);
    document.body.appendChild(menu);
    result.current.current = menu;

    fireEvent.mouseDown(child);

    expect(onClose).not.toHaveBeenCalled();

    menu.remove();
  });

  it("closes on Escape regardless of where it's pressed", () => {
    const onClose = vi.fn();
    renderHook(() => useDismissableMenu<HTMLDivElement>(onClose));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores non-Escape keys", () => {
    const onClose = vi.fn();
    renderHook(() => useDismissableMenu<HTMLDivElement>(onClose));

    fireEvent.keyDown(document, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useDismissableMenu<HTMLDivElement>(onClose));

    unmount();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});
