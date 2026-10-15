/**
 * Pure geometry for the edge-angle line and its band. Points are normalised to the ROI crop (0-1);
 * angles and distances need the crop's pixel size ``(w, h)``, because a normalised unit is not the
 * same length horizontally and vertically. The band maths mirrors ``edge_angle.py``.
 */
import { Point } from "./roiGeometry";

export type { Point };
export interface Line {
  p1: Point;
  p2: Point;
}

export const HALF_WIDTH_RANGE: [number, number] = [0.005, 0.5];
export const DEFAULT_HALF_WIDTH = 0.05;
/** A line shorter than this (as a fraction of the crop's shorter side) is not accepted. */
export const MIN_LINE = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const toPx = (p: Point, w: number, h: number) => ({ x: p.x * w, y: p.y * h });

/** Length of the line in pixels. */
export function lineLengthPx(line: Line, w: number, h: number): number {
  const a = toPx(line.p1, w, h);
  const b = toPx(line.p2, w, h);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Direction of the drawn line in degrees [0, 180), counter-clockwise on screen (same convention as the backend). */
export function lineAngle(line: Line, w: number, h: number): number {
  const a = toPx(line.p1, w, h);
  const b = toPx(line.p2, w, h);
  const deg = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
  const mod = ((deg % 180) + 180) % 180;
  return mod >= 180 - 1e-9 ? 0 : mod;
}

function frame(line: Line, w: number, h: number) {
  const a = toPx(line.p1, w, h);
  const b = toPx(line.p2, w, h);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  return { a, b, len, u, n: { x: -u.y, y: u.x } };
}

/** The band's four corners (normalised): both ends of the line, offset to each side. */
export function bandCorners(line: Line, halfWidth: number, w: number, h: number): Point[] {
  const { a, b, n } = frame(line, w, h);
  const hw = halfWidth * Math.min(w, h);
  return [
    { x: a.x - hw * n.x, y: a.y - hw * n.y },
    { x: b.x - hw * n.x, y: b.y - hw * n.y },
    { x: b.x + hw * n.x, y: b.y + hw * n.y },
    { x: a.x + hw * n.x, y: a.y + hw * n.y },
  ].map((p) => ({ x: p.x / w, y: p.y / h }));
}

/** Where the single resize handle sits: the middle of one long side of the band. */
export function bandHandle(line: Line, halfWidth: number, w: number, h: number): Point {
  const { a, b, n } = frame(line, w, h);
  const hw = halfWidth * Math.min(w, h);
  return { x: ((a.x + b.x) / 2 + hw * n.x) / w, y: ((a.y + b.y) / 2 + hw * n.y) / h };
}

/** Half-width implied by dragging the handle to ``pointer``: its distance from the line, clamped. */
export function halfWidthFromPointer(pointer: Point, line: Line, w: number, h: number): number {
  const { a, u } = frame(line, w, h);
  const p = toPx(pointer, w, h);
  const dist = Math.abs((p.x - a.x) * -u.y + (p.y - a.y) * u.x);
  return clamp(dist / Math.min(w, h), HALF_WIDTH_RANGE[0], HALF_WIDTH_RANGE[1]);
}

/** True when two points are far enough apart to make a line. */
export function longEnough(p1: Point, p2: Point, w: number, h: number): boolean {
  return lineLengthPx({ p1, p2 }, w, h) >= MIN_LINE * Math.min(w, h);
}
