import { expect, test } from "vitest";
import { drawn, stored } from "./pixelCentre";

test("a detector's centre pixel index is drawn half a pixel right and down, and a click is stored back", () => {
  // a 36 px box starting at pixel 52 has its centre at index 69.5; as pixel edges that is 70
  expect(drawn({ x: 69.5, y: 119.5, angle: 3 })).toEqual({ x: 70, y: 120, angle: 3 });
  expect(stored(70)).toBe(69.5);
  expect(stored(drawn({ x: 10.2, y: 0 }).x)).toBeCloseTo(10.2);
});
