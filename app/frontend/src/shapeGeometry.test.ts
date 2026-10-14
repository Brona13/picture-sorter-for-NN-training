import { expect, test } from "vitest";
import { addVertex, defaultShape, dragHandle, handlesOf, moveShape, removeVertex } from "./shapeGeometry";

test("rectangle handles resize, move keeps it inside", () => {
  const rect = defaultShape("rect");
  expect(handlesOf(rect)).toHaveLength(8);
  const grown = dragHandle(rect, "se", { x: 0.75, y: 0.75 }, { x: 0.95, y: 0.9 });
  expect(grown).toMatchObject({ shape: "rect", x: 0.25, y: 0.25 });
  expect((grown as any).w).toBeCloseTo(0.7);
  const moved = moveShape(rect, 5, 5) as any;
  expect(moved.x + moved.w).toBeCloseTo(1);
  expect(moved.y + moved.h).toBeCloseTo(1);
});

test("circle: radius handle sets r in width units, centre handle moves", () => {
  const circle = defaultShape("circle");
  const bigger = dragHandle(circle, "radius", { x: 0.75, y: 0.5 }, { x: 0.8, y: 0.5 }) as any;
  expect(bigger.r).toBeCloseTo(0.3);
  // vertical drag on a 2:1 image: dy of 0.2 is 0.2 / 2 = 0.1 width units
  const vertical = dragHandle(circle, "radius", { x: 0.75, y: 0.5 }, { x: 0.5, y: 0.7 }, 2) as any;
  expect(vertical.r).toBeCloseTo(0.1);
  const centred = dragHandle(circle, "center", { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }) as any;
  expect(centred.cx).toBeCloseTo(0.6);
});

test("polygon: vertex drag, add and remove (never below three points)", () => {
  const poly = defaultShape("polygon") as any;
  expect(handlesOf(poly).map((h) => h.id)).toEqual(["v0", "v1", "v2"]);
  const dragged = dragHandle(poly, "v1", { x: 0.85, y: 0.8 }, { x: 2, y: -1 }) as any;
  expect(dragged.points[1]).toEqual({ x: 1, y: 0 });
  const four = addVertex(poly) as any;
  expect(four.points).toHaveLength(4);
  expect(removeVertex(four, 1)).toMatchObject({ points: expect.any(Array) });
  expect((removeVertex(poly, 0) as any).points).toHaveLength(3);
  const moved = moveShape(poly, 5, 0) as any;
  expect(Math.max(...moved.points.map((p: any) => p.x))).toBeCloseTo(1);
});
