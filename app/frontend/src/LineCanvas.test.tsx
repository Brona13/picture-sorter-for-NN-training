import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import LineCanvas from "./LineCanvas";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});

function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target, { pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target, ev);
}

function click(target: Element, clientX: number, clientY: number) {
  fireEvent.click(target, { clientX, clientY });
}

function loaded() {
  const img = screen.getByAltText("Crop to measure");
  Object.defineProperty(img, "naturalWidth", { value: 200 });
  Object.defineProperty(img, "naturalHeight", { value: 100 });
  fireEvent.load(img);
}

test("two clicks place the line; it follows the cursor in between", () => {
  const onChange = vi.fn();
  render(<LineCanvas imageUrl="/c.png" line={null} halfWidth={0.05} onChange={onChange} />);
  loaded();
  const area = screen.getByTestId("line-canvas");
  click(area, 20, 50); // (0.1, 0.5)
  expect(screen.getByTestId("first-point")).toBeInTheDocument();
  pointer(area, "pointerMove", 100, 50);
  expect(screen.getByTestId("drawn-line")).toHaveAttribute("x2", "0.5");
  expect(onChange).not.toHaveBeenCalled();
  click(area, 180, 50); // (0.9, 0.5)
  expect(onChange).toHaveBeenCalledTimes(1);
  const [line, hw] = onChange.mock.calls[0];
  expect(line.p1).toEqual({ x: 0.1, y: 0.5 });
  expect(line.p2).toEqual({ x: 0.9, y: 0.5 });
  expect(hw).toBe(0.05);
});

test("a second click on top of the first does not make a line", () => {
  const onChange = vi.fn();
  render(<LineCanvas imageUrl="/c.png" line={null} halfWidth={0.05} onChange={onChange} />);
  loaded();
  const area = screen.getByTestId("line-canvas");
  click(area, 100, 50);
  click(area, 101, 50);
  expect(onChange).not.toHaveBeenCalled();
});

test("dragging an end moves that point only; the band handle sets the half-width", () => {
  const onChange = vi.fn();
  const line = { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
  render(<LineCanvas imageUrl="/c.png" line={line} halfWidth={0.1} onChange={onChange} />);
  loaded();
  const area = screen.getByTestId("line-canvas");
  pointer(screen.getByTestId("handle-p2"), "pointerDown", 160, 50);
  pointer(area, "pointerMove", 170, 30); // (0.85, 0.3)
  let [moved, hw] = onChange.mock.calls.at(-1)!;
  expect(moved.p1).toEqual(line.p1);
  expect(moved.p2.x).toBeCloseTo(0.85);
  expect(moved.p2.y).toBeCloseTo(0.3);
  expect(hw).toBe(0.1);
  pointer(area, "pointerUp", 170, 30);

  pointer(screen.getByTestId("handle-band"), "pointerDown", 100, 60);
  pointer(area, "pointerMove", 100, 80); // 30 px below the line = 0.3 of the shorter side
  [moved, hw] = onChange.mock.calls.at(-1)!;
  expect(moved).toEqual(line);
  expect(hw).toBeCloseTo(0.3);
});

test("Draw a new line clears the line; the overlay shows the fitted line and edge points", () => {
  const onChange = vi.fn();
  const line = { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
  const overlay = { points: [{ x: 0.3, y: 0.5 }, { x: 0.6, y: 0.51 }], fitted: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.51 }] };
  render(<LineCanvas imageUrl="/c.png" line={line} halfWidth={0.1} overlay={overlay} onChange={onChange} />);
  expect(screen.getAllByTestId("edge-point")).toHaveLength(2);
  expect(screen.getByTestId("fitted-line")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Draw a new line" }));
  expect(onChange).toHaveBeenCalledWith(null, 0.1);
});
