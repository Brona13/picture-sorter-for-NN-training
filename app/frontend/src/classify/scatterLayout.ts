import { ScatterPoint } from "../api";

export interface Placed extends ScatterPoint {
  px: number;
  py: number;
}

/** Fit projected coordinates into a ``width`` x ``height`` box with ``pad`` margins. */
export function layoutPoints(points: ScatterPoint[], width: number, height: number, pad = 16): Placed[] {
  if (points.length === 0) return [];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = x1 > x0 ? (width - 2 * pad) / (x1 - x0) : 0;
  const sy = y1 > y0 ? (height - 2 * pad) / (y1 - y0) : 0;
  return points.map((p) => ({
    ...p,
    px: sx ? pad + (p.x - x0) * sx : width / 2,
    py: sy ? pad + (p.y - y0) * sy : height / 2,
  }));
}
