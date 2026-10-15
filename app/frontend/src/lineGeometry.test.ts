import { expect, test } from "vitest";
import { bandCorners, bandHandle, halfWidthFromPointer, lineAngle, lineLengthPx, longEnough } from "./lineGeometry";

const W = 200;
const H = 100;

test("angle is counter-clockwise on screen and does not depend on the drawing order", () => {
  expect(lineAngle({ p1: { x: 0.1, y: 0.5 }, p2: { x: 0.9, y: 0.5 } }, W, H)).toBeCloseTo(0);
  expect(lineAngle({ p1: { x: 0.9, y: 0.5 }, p2: { x: 0.1, y: 0.5 } }, W, H)).toBeCloseTo(0);
  expect(lineAngle({ p1: { x: 0.5, y: 0.9 }, p2: { x: 0.5, y: 0.1 } }, W, H)).toBeCloseTo(90);
  expect(lineAngle({ p1: { x: 0.5, y: 0.1 }, p2: { x: 0.5, y: 0.9 } }, W, H)).toBeCloseTo(90);
  // rising to the right on screen (y decreases): 45 degrees in pixels even though the crop is 2:1
  expect(lineAngle({ p1: { x: 0.25, y: 0.75 }, p2: { x: 0.75, y: 0.25 } }, W, W)).toBeCloseTo(45);
  expect(lineAngle({ p1: { x: 0.25, y: 0.75 }, p2: { x: 0.5, y: 0.25 } }, W, H)).toBeCloseTo(Math.atan2(50, 50) * 180 / Math.PI);
});

test("length is measured in pixels, not normalised units", () => {
  expect(lineLengthPx({ p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, W, H)).toBeCloseTo(200);
  expect(lineLengthPx({ p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } }, W, H)).toBeCloseTo(100);
});

test("band corners sit half-width (of the shorter side) on both sides of the line", () => {
  const line = { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
  const c = bandCorners(line, 0.1, W, H); // 0.1 * 100 px = 10 px = 0.1 of the height
  expect(c).toHaveLength(4);
  const ys = c.map((p) => p.y).sort();
  expect(ys[0]).toBeCloseTo(0.4);
  expect(ys[3]).toBeCloseTo(0.6);
  expect(c[0].x).toBeCloseTo(0.2);
  expect(c[1].x).toBeCloseTo(0.8);
});

test("the handle is mid-side and dragging it sets the half-width from the distance to the line", () => {
  const line = { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
  const hdl = bandHandle(line, 0.1, W, H);
  expect(hdl.x).toBeCloseTo(0.5);
  expect(Math.abs(hdl.y - 0.5)).toBeCloseTo(0.1);
  expect(halfWidthFromPointer({ x: 0.5, y: 0.7 }, line, W, H)).toBeCloseTo(0.2);
  expect(halfWidthFromPointer({ x: 0.5, y: 0.5 }, line, W, H)).toBeCloseTo(0.005); // clamped to the minimum
  expect(halfWidthFromPointer({ x: 0.5, y: 0.0 }, { p1: { x: 0.2, y: 0.9 }, p2: { x: 0.8, y: 0.9 } }, W, H)).toBeCloseTo(0.5); // clamped to the maximum
});

test("a click pair that is too close together is not a line", () => {
  expect(longEnough({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }, W, H)).toBe(false);
  expect(longEnough({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, W, H)).toBe(true);
});
