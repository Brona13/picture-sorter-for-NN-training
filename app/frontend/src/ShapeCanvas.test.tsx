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

test("polygon: double-click on an edge inserts a point; right-click removes one", () => {
  const onChange = vi.fn();
  const four = { shape: "polygon" as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] };
  render(<ShapeCanvas imageUrl="/c.png" shape={four} onChange={onChange} />);
  const ev = createEvent.dblClick(screen.getByTestId("edge-0"), { clientX: 100, clientY: 22 });
  fireEvent(screen.getByTestId("edge-0"), ev);
  const added = onChange.mock.calls.at(-1)![0];
  expect(added.points).toHaveLength(5);
  expect(added.points[1].x).toBeCloseTo(0.5);
  expect(added.points[1].y).toBeCloseTo(0.2);
  fireEvent.contextMenu(screen.getByTestId("handle-v2"));
  expect(onChange.mock.calls.at(-1)![0].points).toHaveLength(3);
});

test("polygon: selecting a point enables Remove selected point", () => {
  const onChange = vi.fn();
  const four = { shape: "polygon" as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] };
  render(<ShapeCanvas imageUrl="/c.png" shape={four} onChange={onChange} />);
  const button = screen.getByRole("button", { name: "Remove selected point" });
  expect(button).toBeDisabled();
  pointer(screen.getByTestId("handle-v1"), "pointerDown", 160, 20);
  pointer(screen.getByTestId("shape-canvas"), "pointerUp", 160, 20);
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(onChange.mock.calls.at(-1)![0].points).toHaveLength(3);
});
