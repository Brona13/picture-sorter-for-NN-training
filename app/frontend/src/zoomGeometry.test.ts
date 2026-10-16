import { expect, test } from "vitest";
import { clampZoom, contentRect, FIT_VIEW, fitSize, oneToOneZoom, panBy, screenScale, viewFromRect, ZOOM_MAX, ZOOM_MIN, zoomAt } from "./zoomGeometry";

const base = fitSize(400, 200, 300, 225); // 300 x 150, centred vertically in a 300 x 225 box

test("the picture is fitted into the viewport and centred at zoom 1", () => {
  expect(base).toEqual({ w: 300, h: 150 });
  expect(contentRect(FIT_VIEW, base, 300, 225)).toEqual({ x: 0, y: 37.5, w: 300, h: 150 });
});

test("zooming keeps the picture point under the cursor where it is", () => {
  const px = 220;
  const py = 90;
  const before = contentRect(FIT_VIEW, base, 300, 225);
  const u = { x: (px - before.x) / before.w, y: (py - before.y) / before.h };
  const view = zoomAt(FIT_VIEW, 2, px, py, base, 300, 225);
  expect(view.zoom).toBe(2);
  const r = contentRect(view, base, 300, 225);
  expect(r.x + u.x * r.w).toBeCloseTo(px);
  expect(r.y + u.y * r.h).toBeCloseTo(py);
});

test("zooming in then out by the same factor at the same spot returns to the start", () => {
  const a = zoomAt(FIT_VIEW, 1.5, 100, 80, base, 300, 225);
  const b = zoomAt(a, 1 / 1.5, 100, 80, base, 300, 225);
  expect(b.zoom).toBeCloseTo(1);
  expect(b.cx).toBeCloseTo(0.5);
  expect(b.cy).toBeCloseTo(0.5);
});

test("zoom is limited to its range", () => {
  expect(clampZoom(100)).toBe(ZOOM_MAX);
  expect(clampZoom(0.01)).toBe(ZOOM_MIN);
  expect(zoomAt(FIT_VIEW, 1000, 150, 112, base, 300, 225).zoom).toBe(ZOOM_MAX);
});

test("panning moves the picture and cannot lose it", () => {
  const moved = panBy(FIT_VIEW, 30, -10, base, 300, 225);
  const r = contentRect(moved, base, 300, 225);
  expect(r.x).toBeCloseTo(30);
  expect(r.y).toBeCloseTo(27.5);
  const far = panBy(FIT_VIEW, 5000, 5000, base, 300, 225);
  const f = contentRect(far, base, 300, 225);
  expect(f.x).toBeLessThan(300); // still partly inside the box
  expect(f.y).toBeLessThan(225);
  const gone = panBy(FIT_VIEW, -5000, -5000, base, 300, 225);
  const g = contentRect(gone, base, 300, 225);
  expect(g.x + g.w).toBeGreaterThan(0);
  expect(g.y + g.h).toBeGreaterThan(0);
});

test("the view is kept in picture terms, so a resized viewport shows the same spot", () => {
  const view = zoomAt(FIT_VIEW, 4, 250, 60, base, 300, 225);
  const big = fitSize(400, 200, 600, 450);
  const r = contentRect(view, big, 600, 450);
  // the picture point at the viewport centre is unchanged
  expect((600 / 2 - r.x) / r.w).toBeCloseTo(view.cx);
  expect((450 / 2 - r.y) / r.h).toBeCloseTo(view.cy);
});

test("1:1 and the zoom percentage refer to picture pixels", () => {
  expect(screenScale(FIT_VIEW, base, 400)).toBeCloseTo(0.75);
  const z = oneToOneZoom(400, base);
  expect(screenScale({ ...FIT_VIEW, zoom: z }, base, 400)).toBeCloseTo(1);
  expect(viewFromRect(2, 0, 0, base, 300, 225).zoom).toBe(2);
});
