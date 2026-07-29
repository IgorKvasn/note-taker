import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom implements neither Range.getClientRects nor Range.getBoundingClientRect,
// which CodeMirror 6 calls during its internal layout measurement. Without these,
// CM6's measure pass throws inside a requestAnimationFrame callback on every
// render, producing unhandled-exception noise in otherwise-passing tests.
document.createRange = () => {
  const range = new Range();
  range.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => {},
  });
  range.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* (): ArrayIterator<DOMRect> {},
  });
  return range;
};
