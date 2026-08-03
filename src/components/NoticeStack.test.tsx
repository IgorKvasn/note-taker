import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticeStack } from "./NoticeStack";

describe("NoticeStack", () => {
  it("renders nothing when there are no children", () => {
    const { container } = render(<NoticeStack>{null}</NoticeStack>);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when children is an empty array", () => {
    const { container } = render(<NoticeStack>{[]}</NoticeStack>);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the only child is a false conditional expression", () => {
    const showNotice = false;
    const { container } = render(<NoticeStack>{showNotice && <div>Hidden notice</div>}</NoticeStack>);

    expect(container.firstChild).toBeNull();
  });

  it("stacks its children in a column, with the first child anchored nearest the corner", () => {
    render(
      <NoticeStack>
        <div>Anchor notice</div>
        <div>Above notice</div>
      </NoticeStack>,
    );

    const stack = screen.getByTestId("notice-stack");
    expect(stack.children).toHaveLength(2);
    expect(stack.children[0].textContent).toBe("Anchor notice");
    expect(stack.children[1].textContent).toBe("Above notice");
    expect(stack.className).toBe("notice-stack");
  });
});
