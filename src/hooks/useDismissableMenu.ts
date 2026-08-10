import { useEffect, useRef } from "react";

/**
 * Shared dismissal behavior for a floating menu/popover: closes on a
 * pointerdown outside the menu's DOM subtree, or on Escape anywhere.
 * Extracted from `TreeContextMenu`'s original inline effect (issue #76) so
 * every dismissible menu in the app -- the tree context menu and the
 * toolbar's image menu alike -- shares one implementation rather than each
 * re-registering its own listeners.
 */
export function useDismissableMenu<T extends HTMLElement>(onClose: () => void) {
  const menuRef = useRef<T>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return menuRef;
}
