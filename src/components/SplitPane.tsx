import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clampPaneRatio,
  DEFAULT_PANE_RATIO,
  KEYBOARD_RATIO_STEP,
  MAXIMUM_PANE_RATIO,
  MINIMUM_PANE_RATIO,
  ratioFromPointerPosition,
} from "./splitRatio";
import "./SplitPane.css";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
}

export function SplitPane({ left, right }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftRatio, setLeftRatio] = useState(DEFAULT_PANE_RATIO);
  const [isDragging, setIsDragging] = useState(false);

  // Suppressing the default mousedown stops the browser starting a text
  // selection that would otherwise highlight pane content during the drag.
  const startDragging = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const adjustByKeyboard = useCallback((event: ReactKeyboardEvent) => {
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) {
      return;
    }

    event.preventDefault();
    setLeftRatio((currentRatio) =>
      clampPaneRatio(currentRatio + direction * KEYBOARD_RATIO_STEP),
    );
  }, []);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    // Movement is tracked on the window rather than the divider so the drag
    // survives the pointer outrunning the 6px handle.
    const handleMove = (event: MouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const bounds = container.getBoundingClientRect();
      setLeftRatio((currentRatio) =>
        ratioFromPointerPosition(event.clientX, bounds, currentRatio),
      );
    };

    const stopDragging = () => setIsDragging(false);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", stopDragging);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", stopDragging);
    };
  }, [isDragging]);

  return (
    <div
      className="split-pane"
      data-testid="split-pane"
      ref={containerRef}
      data-dragging={isDragging || undefined}
    >
      <div
        className="split-pane__side"
        data-testid="split-pane-left"
        style={{ flexBasis: `${leftRatio * 100}%` }}
      >
        {left}
      </div>
      <div
        className="split-pane__divider"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={Math.round(leftRatio * 100)}
        aria-valuemin={Math.round(MINIMUM_PANE_RATIO * 100)}
        aria-valuemax={Math.round(MAXIMUM_PANE_RATIO * 100)}
        onMouseDown={startDragging}
        onKeyDown={adjustByKeyboard}
      />
      <div className="split-pane__side" data-testid="split-pane-right">
        {right}
      </div>
    </div>
  );
}
