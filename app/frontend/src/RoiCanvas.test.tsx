import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import RoiCanvas from "./RoiCanvas";

// jsdom has no layout: pretend the canvas is 200x100 at (10, 20).
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON() {},
  } as DOMRect);
});

function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target, { clientX, clientY, pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target, ev);
}

test("draw mode: dragging creates a normalised box", () => {
  const onChange = vi.fn();
  render(<RoiCanvas imageUrl="/f.png" mode="draw" box={null} onChange={onChange} />);
  const area = screen.getByTestId("roi-canvas");
  pointer(area, "pointerDown", 10 + 20, 20 + 10); // (0.1, 0.1)
  pointer(area, "pointerMove", 10 + 120, 20 + 60); // (0.6, 0.6)
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  const last = onChange.mock.calls.at(-1)![0];
  expect(last.x).toBeCloseTo(0.1);
  expect(last.y).toBeCloseTo(0.1);
  expect(last.w).toBeCloseTo(0.5);
  expect(last.h).toBeCloseTo(0.5);
  // after release, moving does nothing
  const calls = onChange.mock.calls.length;
  pointer(area, "pointerMove", 10 + 150, 20 + 80);
  expect(onChange.mock.calls.length).toBe(calls);
});

test("edit mode: dragging the box moves it, dragging a handle resizes it", () => {
  const onChange = vi.fn();
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  render(<RoiCanvas imageUrl="/f.png" mode="edit" box={box} onChange={onChange} />);
  const area = screen.getByTestId("roi-canvas");

  pointer(screen.getByTestId("roi-box"), "pointerDown", 10 + 100, 20 + 50);
  pointer(area, "pointerMove", 10 + 120, 20 + 60); // +0.1 x, +0.1 y
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  const moved = onChange.mock.calls.at(-1)![0];
  expect(moved.x).toBeCloseTo(0.3);
  expect(moved.y).toBeCloseTo(0.3);
  expect(moved.w).toBeCloseTo(0.4);

  onChange.mockClear();
  pointer(screen.getByTestId("handle-se"), "pointerDown", 10 + 120, 20 + 60);
  pointer(area, "pointerMove", 10 + 160, 20 + 80); // +0.2 x, +0.2 y
  pointer(area, "pointerUp", 10 + 160, 20 + 80);
  const resized = onChange.mock.calls.at(-1)![0];
  expect(resized.x).toBeCloseTo(0.2);
  expect(resized.w).toBeCloseTo(0.6);
  expect(resized.h).toBeCloseTo(0.6);
});

test("draw mode shows no handles; other ROIs are outlined", () => {
  render(
    <RoiCanvas
      imageUrl="/f.png"
      mode="draw"
      box={{ x: 0, y: 0, w: 0.5, h: 0.5 }}
      onChange={() => {}}
      others={[{ name: "cap", box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }]}
    />,
  );
  expect(screen.queryByTestId("handle-se")).toBeNull();
  expect(screen.getByTitle("cap")).toBeInTheDocument();
});
