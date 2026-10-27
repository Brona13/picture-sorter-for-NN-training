import { fireEvent, render, screen } from "@testing-library/react";
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

test("in the viewer, holding Space shows the reference picture and releasing goes back to the selected one", () => {
  render(<ValueGrid camera="cam" rows={ROWS} viewer={{ reference: ROWS[1] }} />);
  fireEvent.click(screen.getByAltText("a.png"));
  const shown = () => screen.getByTestId("value-viewer").querySelector("img[alt$='.png']")?.getAttribute("alt");
  expect(shown()).toBe("a.png");
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(shown()).toBe("b.png");
  expect(screen.getByTestId("viewer-reference").textContent).toContain("b.png");
  fireEvent.keyUp(window, { code: "Space", key: " " });
  expect(shown()).toBe("a.png");
  expect(screen.queryByTestId("viewer-reference")).toBeNull();
});

test("without a reference picture Space does nothing", () => {
  render(<ValueGrid camera="cam" rows={ROWS} viewer={{ reference: null }} />);
  fireEvent.click(screen.getByAltText("a.png"));
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(screen.queryByTestId("viewer-reference")).toBeNull();
});
