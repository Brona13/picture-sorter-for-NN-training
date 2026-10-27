import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import ValueGrid, { ValueRow } from "./ValueGrid";

beforeEach(() => localStorage.clear());

const ROWS: ValueRow[] = [
  { frame: "a.png", value: 1.2, verdict: "pass" },
  { frame: "b.png", value: 9.9, verdict: "fail" },
  { frame: "c.png", value: null, verdict: "undetermined" },
];

test("a page can give the card picture; without it the camera's square thumbnail is used", () => {
  const { unmount } = render(<ValueGrid camera="cam" rows={ROWS} />);
  expect(screen.getByAltText("a.png").getAttribute("src")).toContain("variant=square");
  unmount();
  render(<ValueGrid camera="cam" rows={ROWS} thumb={(f) => `/whole/${f}`} />);
  expect(screen.getByAltText("a.png").getAttribute("src")).toBe("/whole/a.png");
});

test("a card of a pass or fail picture has a green or red edge, any other card keeps the plain one", () => {
  render(<ValueGrid camera="cam" rows={ROWS} />);
  expect(screen.getByTestId("value-card-a.png").style.border).toContain("rgb(60, 207, 110)");
  expect(screen.getByTestId("value-card-b.png").style.border).toContain("rgb(255, 91, 91)");
  expect(screen.getByTestId("value-card-c.png").style.border).toContain("var(--border)");
});
