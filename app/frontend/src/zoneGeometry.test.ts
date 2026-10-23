import { expect, test } from "vitest";
import { dragZone, edgeHandle, judgeZone, plotBounds, Zone } from "./zoneGeometry";

const circle: Zone = { shape: "circle", center: [100, 0], radius: 5, half: [10, 10] };
const rect: Zone = { shape: "rect", center: [0, 0], radius: 5, half: [10, 2] };

test("judgeZone: the edge is inside, a missing point or centre is undetermined", () => {
  expect(judgeZone([103, 4], circle)).toBe("pass");
  expect(judgeZone([103, 5], circle)).toBe("fail");
  expect(judgeZone(null, circle)).toBe("undetermined");
  expect(judgeZone([1, 1], { ...circle, center: null })).toBe("undetermined");
  expect(judgeZone([-10, 2], rect)).toBe("pass");
  expect(judgeZone([0, 2.5], rect)).toBe("fail");
});

test("dragZone moves the centre and resizes from the edge handle", () => {
  expect(dragZone("centre", [101.04, -2.26], circle).center).toEqual([101, -2.3]);
  expect(dragZone("edge", [100, 8], circle).radius).toBe(8);
  expect(dragZone("edge", [100, 0], circle).radius).toBe(0.5); // never zero
  expect(dragZone("edge", [-7, 3], rect).half).toEqual([7, 3]);
  expect(dragZone("edge", [7, 3], { ...rect, center: null }).center).toBeNull(); // no centre, nothing to resize
});

test("edgeHandle sits right of a circle and at the corner of a rectangle", () => {
  expect(edgeHandle(circle)).toEqual([105, 0]);
  expect(edgeHandle(rect)).toEqual([10, 2]);
  expect(edgeHandle({ ...rect, center: null })).toBeNull();
});

test("plotBounds is square, holds A, the points and the zone", () => {
  const b = plotBounds([[90, -10], null, [110, 10]], circle);
  expect(b.w).toBeCloseTo(b.h);
  expect(b.x).toBeLessThan(0);
  expect(b.x + b.w).toBeGreaterThan(110);
  expect(b.y).toBeLessThan(-10);
  expect(b.y + b.h).toBeGreaterThan(10);
});
