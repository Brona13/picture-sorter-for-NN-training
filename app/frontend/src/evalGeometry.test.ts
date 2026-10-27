import { expect, test } from "vitest";
import { evalLayer, EvalSpec } from "./evalGeometry";

const A = { x: 100, y: 100 };
const SIZE = { w: 400, h: 300 };
const base: EvalSpec = { mode: "tolerance", op: "angle", zone: { shape: "circle", center: null, radius: 5, half: [5, 5] }, nominal: null, tolerance: 3, clockwise: false, unit: "°" };

test("zone, circle: the circle sits at A plus the zone centre with a cross at the centre and the distance over the radius", () => {
  const spec: EvalSpec = { ...base, mode: "zone", op: "offset", zone: { shape: "circle", center: [20, -10], radius: 5, half: [5, 5] }, unit: "px" };
  const l = evalLayer(spec, A, { x: 123, y: 91 }, SIZE, 3.2, 10)!;
  expect(l.regions).toHaveLength(1);
  expect(l.regions[0].d).toMatch(/^M 115 90 a 5 5 0 1 0 10 0/); // centre (120, 90), radius 5
  expect(l.segments).toHaveLength(2); // the cross
  expect(l.segments[0]).toMatchObject({ y1: 90, y2: 90 });
  expect(l.labels[0].text).toBe("3.2 / 5 px");
});

test("zone, rectangle: the upright rectangle around the centre; the label tells how far B is off", () => {
  const spec: EvalSpec = { ...base, mode: "zone", op: "offset", zone: { shape: "rect", center: [20, 10], radius: 5, half: [6, 4] }, unit: "px" };
  const l = evalLayer(spec, A, { x: 123, y: 108 }, SIZE, 3.6, 10)!;
  expect(l.regions[0].d).toBe("M 114 106 h 12 v 8 h -12 Z");
  expect(l.labels[0].text).toBe("off 3, -2 of ±6, ±4 px");
});

test("zone with no centre yet and a rule with no nominal draw nothing", () => {
  expect(evalLayer({ ...base, mode: "zone", op: "offset", zone: { shape: "circle", center: null, radius: 5, half: [5, 5] } }, A, { x: 1, y: 1 }, SIZE, null, 10)).toBeNull();
  expect(evalLayer(base, A, { x: 1, y: 1 }, SIZE, null, 10)).toBeNull();
});

test("angle: a wedge from A around the nominal direction, counter-clockwise on screen, a dashed nominal ray", () => {
  const l = evalLayer({ ...base, nominal: 90, tolerance: 10 }, A, { x: 100, y: 0 }, SIZE, 90, 10)!;
  const d = l.regions[0].d;
  expect(d).toMatch(/^M 100 100 L /);
  expect(d).toMatch(/A [\d.]+ [\d.]+ 0 0 0 /); // small arc, counter-clockwise sweep
  const ray = l.segments[0];
  expect(ray.dashed).toBe(true);
  expect(ray.x2).toBeCloseTo(100, 5);
  expect(ray.y2).toBeLessThan(100); // 90 deg counter-clockwise points up on screen
  expect(l.labels[0].text).toBe("90 ± 10 °");
});

test("angle: clockwise turns the other way, a wide tolerance is a large arc, 180 or more is the whole disc, and 355 ± 10 wraps", () => {
  const cw = evalLayer({ ...base, nominal: 90, tolerance: 10, clockwise: true }, A, { x: 100, y: 200 }, SIZE, 90, 10)!;
  expect(cw.regions[0].d).toMatch(/0 0 1 /);
  expect(cw.segments[0].y2).toBeGreaterThan(100); // 90 deg clockwise points down
  expect(evalLayer({ ...base, nominal: 90, tolerance: 100 }, A, { x: 200, y: 100 }, SIZE, 90, 10)!.regions[0].d).toMatch(/0 1 0 /);
  expect(evalLayer({ ...base, nominal: 90, tolerance: 180 }, A, { x: 200, y: 100 }, SIZE, 90, 10)!.regions[0].d).toMatch(/^M [\d.-]+ 100 a /);
  const wrap = evalLayer({ ...base, nominal: 355, tolerance: 10 }, A, { x: 200, y: 100 }, SIZE, 355, 10)!;
  expect(wrap.segments[0].x2).toBeGreaterThan(100); // 355 deg points almost right
});

test("distance: a ring between nominal - tolerance and nominal + tolerance, a plain disc when the inner radius is zero", () => {
  const ring = evalLayer({ ...base, op: "distance", nominal: 50, tolerance: 5, unit: "px" }, A, { x: 150, y: 100 }, SIZE, 50, 10)!;
  expect(ring.regions[0].evenodd).toBe(true);
  expect(ring.regions[0].d.match(/ a /g)).toHaveLength(4); // two circles
  expect(ring.paths).toHaveLength(3); // outer, inner, nominal
  const disc = evalLayer({ ...base, op: "distance", nominal: 3, tolerance: 5, unit: "px" }, A, { x: 150, y: 100 }, SIZE, 50, 10)!;
  expect(disc.regions[0].d.match(/ a /g)).toHaveLength(2);
});

test("dx and dy: a vertical or horizontal band across the picture", () => {
  const dx = evalLayer({ ...base, op: "dx", nominal: 40, tolerance: 5, unit: "px" }, A, { x: 140, y: 100 }, SIZE, 40, 10)!;
  expect(dx.regions[0].d).toBe("M 135 0 H 145 V 300 H 135 Z");
  expect(dx.segments).toHaveLength(3);
  const dy = evalLayer({ ...base, op: "dy", nominal: -20, tolerance: 4, unit: "px" }, A, { x: 100, y: 80 }, SIZE, -20, 10)!;
  expect(dy.regions[0].d).toBe("M 0 76 V 84 H 400 V 76 Z");
});
