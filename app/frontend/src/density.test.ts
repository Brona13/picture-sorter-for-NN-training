import { expect, test } from "vitest";
import { autoBandwidth, density2d, densestSpot, densestValue, heatColour, heatPixels, peak } from "./density";
import type { Pt2 } from "./zoneGeometry";

const cluster = (cx: number, cy: number, n: number): Pt2[] => Array.from({ length: n }, (_, i) => [cx + ((i % 5) - 2) * 0.2, cy + ((i % 3) - 1) * 0.2]);

test("the densest spot is where the pictures pile up, not the average", () => {
  const points = [...cluster(10, -5, 30), [100, 80], [90, 70], [-60, 40]] as Pt2[]; // a few far ones drag the mean away
  const spot = densestSpot(points)!;
  expect(Math.abs(spot[0] - 10)).toBeLessThan(5);
  expect(Math.abs(spot[1] + 5)).toBeLessThan(5);
});

test("the density near a pile is higher than near a lone picture, and its peak is about the number of pictures around it", () => {
  const points = [...cluster(0, 0, 20), [40, 40]] as Pt2[];
  const box = { x: -50, y: -50, w: 100, h: 100 };
  const d = density2d(points, box, 2);
  const at = (x: number, y: number) => d.values[Math.floor(((y - box.y) / box.h) * d.n) * d.n + Math.floor(((x - box.x) / box.w) * d.n)];
  expect(at(0, 0)).toBeGreaterThan(5 * at(40, 40));
  expect(d.max).toBeGreaterThan(10);
  expect(Math.abs(peak(d)![0])).toBeLessThan(2);
});

test("a wider smoothing merges two piles into one hill between them, a narrower one keeps them apart", () => {
  const points = [...cluster(-10, 0, 20), ...cluster(10, 0, 20)] as Pt2[];
  const narrow = densestSpot(points, 0.3)!;
  const wide = densestSpot(points, 6)!;
  expect(Math.abs(narrow[0])).toBeGreaterThan(5);
  expect(Math.abs(wide[0])).toBeLessThan(3);
});

test("one picture, equal pictures and no pictures do not break it", () => {
  expect(densestSpot([])).toBeNull();
  expect(densestSpot([[3, 4]])).not.toBeNull();
  expect(autoBandwidth([[1, 1], [1, 1]], 2)).toBe(2);
  const same = densestSpot([[5, 5], [5, 5], [5, 5]])!;
  expect(Math.abs(same[0] - 5)).toBeLessThan(1);
});

test("one number: the densest value, and an angle goes around the clock", () => {
  expect(densestValue([1, 2, 2.1, 2.2, 2.3, 9, 10], false)!).toBeCloseTo(2.2, 0);
  const angles = [358, 359, 0, 1, 2, 3, 180];
  const v = densestValue(angles, true)!;
  expect(Math.min(v, 360 - v)).toBeLessThan(5);
  expect(densestValue([], false)).toBeNull();
  expect(densestValue([7, 7], false)).toBe(7);
});

test("colours run blue to red, the weakest density is transparent and the densest is opaque red", () => {
  expect(heatColour(0)[3]).toBe(0);
  const hot = heatColour(1);
  expect(hot[0]).toBeGreaterThan(200);
  expect(hot[2]).toBeLessThan(60);
  expect(hot[3]).toBeGreaterThan(200);
  const mid = heatColour(0.5);
  expect(mid[1]).toBeGreaterThan(mid[0]); // green in the middle
  const px = heatPixels(density2d([[0, 0]], { x: -1, y: -1, w: 2, h: 2 }, 0.2, 8));
  expect(px.length).toBe(8 * 8 * 4);
});
