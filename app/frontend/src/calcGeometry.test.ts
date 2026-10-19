import { expect, test } from "vitest";
import { calcShapes } from "./calcGeometry";

const A = { x: 100, y: 100 };

test("angle: the line A to B, a dashed reference to the right and an arc that turns counter-clockwise on screen", () => {
  // B is up and to the right of A: 45 deg counter-clockwise on screen (y points down)
  const g = calcShapes("angle", A, { x: 200, y: 0 }, ["left", "right"], false, 45, "deg", 10);
  expect(g.segments.filter((s) => s.dashed)).toHaveLength(1);
  expect(g.segments.some((s) => s.strong && s.x2 === 200 && s.y2 === 0)).toBe(true);
  expect(g.arcs).toHaveLength(1);
  const arc = g.arcs[0].d;
  expect(arc).toMatch(/A [\d.]+ [\d.]+ 0 0 0 /); // not a large arc, counter-clockwise sweep
  const end = arc.split("A ")[1].split(" ").slice(-2).map(Number);
  expect(end[0]).toBeGreaterThan(100);
  expect(end[1]).toBeLessThan(100); // the arc ends above the reference ray
  expect(g.labels[0].text).toBe("45 deg");
});

test("angle: the clockwise toggle turns the arc the other way, a reflex angle is a large arc", () => {
  const cw = calcShapes("angle", A, { x: 200, y: 200 }, ["l", "r"], true, 45, "deg", 10); // B down-right, clockwise 45 deg
  expect(cw.arcs[0].d).toMatch(/0 0 1 /);
  const end = cw.arcs[0].d.split("A ")[1].split(" ").slice(-2).map(Number);
  expect(end[1]).toBeGreaterThan(100); // clockwise on screen goes down
  const big = calcShapes("angle", A, { x: 0, y: 200 }, ["l", "r"], false, 225, "deg", 10);
  expect(big.arcs[0].d).toMatch(/0 1 0 /);
});

test("distance is the line and its length; dx and dy are the legs of the triangle, the measured one solid", () => {
  const d = calcShapes("distance", A, { x: 130, y: 140 }, ["l", "r"], false, 50, "px", 10);
  expect(d.segments).toHaveLength(1);
  expect(d.labels[0].text).toBe("50 px");
  const dx = calcShapes("dx", A, { x: 130, y: 140 }, ["l", "r"], false, 30, "px", 10);
  expect(dx.segments.find((s) => s.strong)).toMatchObject({ x1: 100, y1: 100, x2: 130, y2: 100 });
  expect(dx.segments.find((s) => s.dashed)).toMatchObject({ x1: 130, y1: 100, x2: 130, y2: 140 });
  const dy = calcShapes("dy", A, { x: 130, y: 140 }, ["l", "r"], false, 40, "px", 10);
  expect(dy.segments.find((s) => s.strong)).toMatchObject({ x1: 100, y1: 100, x2: 100, y2: 140 });
  expect(dy.labels[0].text).toBe("dy 40 px");
});

test("both points are marked with their names; a missing value still draws the geometry", () => {
  const g = calcShapes("angle", A, { x: 200, y: 100 }, ["left hole", "right hole"], false, null, "deg", 10);
  expect(g.dots.map((d) => d.name)).toEqual(["left hole", "right hole"]);
  expect(g.segments.length).toBeGreaterThan(0);
});
