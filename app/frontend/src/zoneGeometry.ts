/** The zone of an Evaluation behind an Offset: pure maths for judging and dragging it (mirrors `flow.judge_zone`). */
export type Pt2 = [number, number];
export interface Zone {
  shape: "circle" | "rect";
  /** (dx, dy) of the centre from point A, pixels; null until it is set. */
  center: Pt2 | null;
  radius: number;
  /** Half width and half height of an upright rectangle. */
  half: Pt2;
}
export type Verdict = "pass" | "fail" | "undetermined";

const EPS = 1e-9;
const MIN_SIZE = 0.5;

/** Inside the zone (edge included) is pass, outside fail; no offset or no centre is undetermined. */
export function judgeZone(p: Pt2 | null, zone: Zone): Verdict {
  if (!p || !zone.center) return "undetermined";
  const dx = p[0] - zone.center[0];
  const dy = p[1] - zone.center[1];
  const inside = zone.shape === "circle" ? Math.hypot(dx, dy) <= zone.radius + EPS : Math.abs(dx) <= zone.half[0] + EPS && Math.abs(dy) <= zone.half[1] + EPS;
  return inside ? "pass" : "fail";
}

/** Where the resize handle sits: right of a circle, bottom-right corner of a rectangle. */
export function edgeHandle(zone: Zone): Pt2 | null {
  if (!zone.center) return null;
  return zone.shape === "circle" ? [zone.center[0] + zone.radius, zone.center[1]] : [zone.center[0] + zone.half[0], zone.center[1] + zone.half[1]];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The zone after dragging its centre or its edge handle to `at` (sizes never go below half a pixel). */
export function dragZone(handle: "centre" | "edge", at: Pt2, zone: Zone): Zone {
  if (handle === "centre") return { ...zone, center: [r1(at[0]), r1(at[1])] };
  if (!zone.center) return zone;
  const [cx, cy] = zone.center;
  if (zone.shape === "circle") return { ...zone, radius: Math.max(MIN_SIZE, r1(Math.hypot(at[0] - cx, at[1] - cy))) };
  return { ...zone, half: [Math.max(MIN_SIZE, r1(Math.abs(at[0] - cx))), Math.max(MIN_SIZE, r1(Math.abs(at[1] - cy)))] };
}

/**
 * The part of the plane to draw: the offsets, the zone and the reference point A at (0, 0), padded, and widened to the
 * same scale on both axes so a circle stays a circle.
 */
export function plotBounds(points: (Pt2 | null)[], zone: Zone): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [0];
  const ys: number[] = [0];
  for (const p of points) if (p) { xs.push(p[0]); ys.push(p[1]); }
  if (zone.center) {
    const [rx, ry] = zone.shape === "circle" ? [zone.radius, zone.radius] : zone.half;
    xs.push(zone.center[0] - rx, zone.center[0] + rx);
    ys.push(zone.center[1] - ry, zone.center[1] + ry);
  }
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 10);
  const pad = span * 0.08;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const side = span + 2 * pad;
  minX = cx - side / 2; minY = cy - side / 2; maxX = cx + side / 2; maxY = cy + side / 2;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
