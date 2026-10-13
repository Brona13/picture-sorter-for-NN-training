import { expect, test } from "vitest";
import {
  boxFromDrag,
  boxStyle,
  MIN_SIZE,
  moveBox,
  pointerToNorm,
  resizeBox,
  roundBox,
  sameBox,
} from "./roiGeometry";

test("pointerToNorm maps into 0-1 and clamps outside the image", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  expect(pointerToNorm(200, 100, rect)).toEqual({ x: 0.5, y: 0.5 });
  expect(pointerToNorm(0, 0, rect)).toEqual({ x: 0, y: 0 });
  expect(pointerToNorm(999, 999, rect)).toEqual({ x: 1, y: 1 });
});

test("boxFromDrag works in every direction", () => {
  const a = { x: 0.6, y: 0.7 };
  const b = { x: 0.2, y: 0.3 };
  expect(boxFromDrag(a, b)).toEqual(boxFromDrag(b, a));
  const r = boxFromDrag(a, b);
  expect(r.x).toBeCloseTo(0.2);
  expect(r.y).toBeCloseTo(0.3);
  expect(r.w).toBeCloseTo(0.4);
  expect(r.h).toBeCloseTo(0.4);
});

test("moveBox keeps the box inside the frame and its size", () => {
  const box = { x: 0.5, y: 0.5, w: 0.3, h: 0.2 };
  expect(moveBox(box, 0.1, -0.1)).toEqual({ x: 0.6, y: 0.4, w: 0.3, h: 0.2 });
  const far = moveBox(box, 5, 5);
  expect(far.x).toBeCloseTo(0.7);
  expect(far.y).toBeCloseTo(0.8);
  expect(moveBox(box, -5, -5)).toEqual({ x: 0, y: 0, w: 0.3, h: 0.2 });
});

test("resizeBox moves only the grabbed edges", () => {
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const se = resizeBox(box, "se", 0.1, 0.2);
  expect(se.x).toBe(0.2);
  expect(se.y).toBe(0.2);
  expect(se.w).toBeCloseTo(0.5);
  expect(se.h).toBeCloseTo(0.6);
  const nw = resizeBox(box, "nw", 0.1, 0.1);
  expect(nw.x).toBeCloseTo(0.3);
  expect(nw.w).toBeCloseTo(0.3); // right edge stayed at 0.6
  expect(nw.y + nw.h).toBeCloseTo(0.6);
  const e = resizeBox(box, "e", 0.1, 9);
  expect(e.h).toBeCloseTo(0.4); // vertical drag ignored for an east handle
  expect(e.w).toBeCloseTo(0.5);
});

test("resizeBox clamps to the frame and refuses to invert or collapse", () => {
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const big = resizeBox(box, "se", 5, 5);
  expect(big.x + big.w).toBeCloseTo(1);
  expect(big.y + big.h).toBeCloseTo(1);
  const crushed = resizeBox(box, "e", -5, 0);
  expect(crushed.x).toBe(0.2);
  expect(crushed.w).toBeCloseTo(MIN_SIZE);
  const crushedW = resizeBox(box, "w", 5, 0);
  expect(crushedW.x + crushedW.w).toBeCloseTo(0.6);
  expect(crushedW.w).toBeCloseTo(MIN_SIZE);
});

test("rounding helpers and css style", () => {
  expect(roundBox({ x: 0.123456, y: 0.1, w: 0.2, h: 0.30004 })).toEqual({ x: 0.1235, y: 0.1, w: 0.2, h: 0.3 });
  expect(sameBox({ x: 0.10001, y: 0, w: 1, h: 1 }, { x: 0.1, y: 0, w: 1, h: 1 })).toBe(true);
  expect(sameBox({ x: 0.11, y: 0, w: 1, h: 1 }, { x: 0.1, y: 0, w: 1, h: 1 })).toBe(false);
  expect(boxStyle({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 })).toEqual({
    left: "25%",
    top: "50%",
    width: "50%",
    height: "25%",
  });
});
