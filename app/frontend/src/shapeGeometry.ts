/** Pure geometry for the mask editor. Coordinates are normalised to the ROI crop (0-1). */
import { Box, MIN_SIZE, moveBox, Point, resizeBox } from "./roiGeometry";

export type MaskShape =
  | ({ shape: "rect" } & Box)
  | { shape: "circle"; cx: number; cy: number; r: number }
  | { shape: "polygon"; points: Point[] };
export type ShapeKind = MaskShape["shape"];

export interface HandleSpec {
  id: string;
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampPoint = (p: Point): Point => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) });

export const MIN_POLYGON_POINTS = 3;

export function defaultShape(kind: ShapeKind): MaskShape {
  if (kind === "rect") return { shape: "rect", x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  if (kind === "circle") return { shape: "circle", cx: 0.5, cy: 0.5, r: 0.25 };
  return {
    shape: "polygon",
    points: [
      { x: 0.5, y: 0.15 },
      { x: 0.85, y: 0.8 },
      { x: 0.15, y: 0.8 },
    ],
  };
}

/** Circle radius is a fraction of the crop width; ``aspect`` is width / height in pixels. */
export function handlesOf(shape: MaskShape): HandleSpec[] {
  if (shape.shape === "rect") {
    const { x, y, w, h } = shape;
    const mx = x + w / 2;
    const my = y + h / 2;
    return [
      { id: "nw", x, y },
      { id: "n", x: mx, y },
      { id: "ne", x: x + w, y },
      { id: "e", x: x + w, y: my },
      { id: "se", x: x + w, y: y + h },
      { id: "s", x: mx, y: y + h },
      { id: "sw", x, y: y + h },
      { id: "w", x, y: my },
    ];
  }
  if (shape.shape === "circle") {
    return [
      { id: "center", x: shape.cx, y: shape.cy },
      { id: "radius", x: clamp(shape.cx + shape.r, 0, 1), y: shape.cy },
    ];
  }
  return shape.points.map((p, i) => ({ id: `v${i}`, x: p.x, y: p.y }));
}

/** Translate the whole shape by (dx, dy), keeping it inside the crop. */
export function moveShape(shape: MaskShape, dx: number, dy: number, aspect = 1): MaskShape {
  if (shape.shape === "rect") return { shape: "rect", ...moveBox(shape, dx, dy) };
  if (shape.shape === "circle") {
    const ry = shape.r * aspect;
    return {
      ...shape,
      cx: clamp(shape.cx + dx, Math.min(shape.r, 0.5), Math.max(1 - shape.r, 0.5)),
      cy: clamp(shape.cy + dy, Math.min(ry, 0.5), Math.max(1 - ry, 0.5)),
    };
  }
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const sx = clamp(dx, -Math.min(...xs), 1 - Math.max(...xs));
  const sy = clamp(dy, -Math.min(...ys), 1 - Math.max(...ys));
  return { shape: "polygon", points: shape.points.map((p) => ({ x: p.x + sx, y: p.y + sy })) };
}

/** Drag handle ``id`` of ``origin`` to pointer position ``p`` (or by the delta for rectangles). */
export function dragHandle(
  origin: MaskShape,
  id: string,
  start: Point,
  p: Point,
  aspect = 1,
): MaskShape {
  if (origin.shape === "rect") {
    return {
      shape: "rect",
      ...resizeBox(origin, id as Parameters<typeof resizeBox>[1], p.x - start.x, p.y - start.y),
    };
  }
  if (origin.shape === "circle") {
    if (id === "center") return moveShape(origin, p.x - start.x, p.y - start.y, aspect);
    const dx = p.x - origin.cx;
    const dy = (p.y - origin.cy) / aspect; // y distance expressed in crop-width units
    return { ...origin, r: clamp(Math.hypot(dx, dy), MIN_SIZE, 1) };
  }
  const i = Number(id.slice(1));
  return {
    shape: "polygon",
    points: origin.points.map((q, j) => (j === i ? clampPoint(p) : q)),
  };
}

/** Insert a vertex at the midpoint of the longest edge. */
export function addVertex(shape: MaskShape): MaskShape {
  if (shape.shape !== "polygon") return shape;
  const pts = shape.points;
  let best = 0;
  let bestLen = -1;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  });
  const a = pts[best];
  const b = pts[(best + 1) % pts.length];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { shape: "polygon", points: [...pts.slice(0, best + 1), mid, ...pts.slice(best + 1)] };
}

export function removeVertex(shape: MaskShape, index: number): MaskShape {
  if (shape.shape !== "polygon" || shape.points.length <= MIN_POLYGON_POINTS) return shape;
  return { shape: "polygon", points: shape.points.filter((_, i) => i !== index) };
}
