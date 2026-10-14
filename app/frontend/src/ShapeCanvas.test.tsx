import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ShapeCanvas from "./ShapeCanvas";
import { defaultShape } from "./shapeGeometry";

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

test("dragging a circle's radius handle reports a larger circle", () => {
  const onChange = vi.fn();
  render(<ShapeCanvas imageUrl="/c.png" shape={defaultShape("circle")} onChange={onChange} />);
  const area = screen.getByTestId("shape-canvas");
  pointer(screen.getByTestId("handle-radius"), "pointerDown", 150, 50); // (0.75, 0.5)
  pointer(area, "pointerMove", 170, 50); // (0.85, 0.5)
  pointer(area, "pointerUp", 170, 50);
  expect(onChange.mock.calls.at(-1)![0].r).toBeCloseTo(0.35);
});

test("dragging the outline moves a rectangle; polygon vertex double-click removes it", () => {
  const onChange = vi.fn();
  const { rerender } = render(<ShapeCanvas imageUrl="/c.png" shape={defaultShape("rect")} onChange={onChange} />);
  const area = screen.getByTestId("shape-canvas");
  pointer(screen.getByTestId("mask-outline"), "pointerDown", 100, 50);
  pointer(area, "pointerMove", 120, 60); // +0.1, +0.1
  expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ x: expect.closeTo(0.35), y: expect.closeTo(0.35) });

  const four = { shape: "polygon" as const, points: [...(defaultShape("polygon") as any).points, { x: 0.5, y: 0.5 }] };
  rerender(<ShapeCanvas imageUrl="/c.png" shape={four} onChange={onChange} />);
  fireEvent.doubleClick(screen.getByTestId("handle-v3"));
  expect(onChange.mock.calls.at(-1)![0].points).toHaveLength(3);
});
