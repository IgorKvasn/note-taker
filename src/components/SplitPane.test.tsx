import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { SplitPane } from "./SplitPane";
import {
  DEFAULT_PANE_RATIO,
  MAXIMUM_PANE_RATIO,
  MINIMUM_PANE_RATIO,
} from "./splitRatio";

const CONTAINER_LEFT = 0;
const CONTAINER_WIDTH = 1000;

function renderSplitPane() {
  const view = render(
    <SplitPane left={<p>left pane</p>} right={<p>right pane</p>} />,
  );

  // jsdom has no layout, so the container reports a zero-width rect unless stubbed.
  const container = view.container.querySelector<HTMLElement>(
    "[data-testid='split-pane']",
  )!;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: CONTAINER_LEFT,
    width: CONTAINER_WIDTH,
    top: 0,
    height: 600,
    right: CONTAINER_WIDTH,
    bottom: 600,
    x: CONTAINER_LEFT,
    y: 0,
    toJSON: () => ({}),
  });

  return { container };
}

function leftPaneRatio(): number {
  const leftPane = screen.getByTestId("split-pane-left");
  return Number.parseFloat(leftPane.style.flexBasis);
}

function dragDividerTo(clientX: number) {
  const divider = screen.getByRole("separator");

  act(() => {
    divider.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 280 }),
    );
  });
  act(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX }));
  });
  act(() => {
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX }));
  });
}

describe("SplitPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders both panes", () => {
    renderSplitPane();

    expect(screen.getByText("left pane")).toBeDefined();
    expect(screen.getByText("right pane")).toBeDefined();
  });

  it("exposes a draggable separator", () => {
    renderSplitPane();

    const divider = screen.getByRole("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("is reachable and adjustable by keyboard", async () => {
    renderSplitPane();
    const divider = screen.getByRole("separator");
    const ratioBeforeKeys = leftPaneRatio();

    expect(divider.tabIndex).toBe(0);

    divider.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(leftPaneRatio()).toBeGreaterThan(ratioBeforeKeys);

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");

    expect(leftPaneRatio()).toBeLessThan(ratioBeforeKeys);
  });

  it("clamps keyboard adjustment at the bounds", async () => {
    renderSplitPane();
    const divider = screen.getByRole("separator");
    divider.focus();

    await userEvent.keyboard("{ArrowLeft>40/}");

    expect(leftPaneRatio()).toBeCloseTo(MINIMUM_PANE_RATIO * 100, 5);
  });

  it("exposes the current ratio to assistive technology", () => {
    renderSplitPane();
    const divider = screen.getByRole("separator");

    expect(divider.getAttribute("aria-valuenow")).toBe(
      String(Math.round(DEFAULT_PANE_RATIO * 100)),
    );
    expect(divider.getAttribute("aria-valuemin")).toBe(
      String(Math.round(MINIMUM_PANE_RATIO * 100)),
    );
    expect(divider.getAttribute("aria-valuemax")).toBe(
      String(Math.round(MAXIMUM_PANE_RATIO * 100)),
    );
  });

  it("resizes the left pane to where the divider was dragged", () => {
    renderSplitPane();

    dragDividerTo(600);

    expect(leftPaneRatio()).toBeCloseTo(60, 5);
  });

  it("clamps a drag past the left edge to the minimum ratio", () => {
    renderSplitPane();

    dragDividerTo(-500);

    expect(leftPaneRatio()).toBeCloseTo(MINIMUM_PANE_RATIO * 100, 5);
  });

  it("clamps a drag past the right edge to the maximum ratio", () => {
    renderSplitPane();

    dragDividerTo(5000);

    expect(leftPaneRatio()).toBeCloseTo(MAXIMUM_PANE_RATIO * 100, 5);
  });

  it("suppresses the default mousedown so dragging does not select pane text", () => {
    renderSplitPane();
    const divider = screen.getByRole("separator");
    const mousedown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 280,
    });

    act(() => {
      divider.dispatchEvent(mousedown);
    });

    expect(mousedown.defaultPrevented).toBe(true);
  });

  it("ignores pointer movement that happens without a drag in progress", () => {
    renderSplitPane();
    const ratioBeforeMove = leftPaneRatio();

    act(() => {
      window.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: 900 }),
      );
    });

    expect(leftPaneRatio()).toBe(ratioBeforeMove);
  });

  it("stops tracking movement after the drag ends", () => {
    renderSplitPane();

    dragDividerTo(600);
    act(() => {
      window.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: 200 }),
      );
    });

    expect(leftPaneRatio()).toBeCloseTo(60, 5);
  });
});
