/** Pure geometry for the ROI editor. All boxes are normalised to the frame (0-1). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Point = { x: number; y: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_SIZE = 0.005;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pointer position -> normalised point inside a rendered image rectangle. */
export function pointerToNorm(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}

/** Box spanned by a drag from ``a`` to ``b`` (either direction). */
export function boxFromDrag(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Translate a box by (dx, dy) without letting it leave the frame. */
export function moveBox(box: Box, dx: number, dy: number): Box {
  return {
    ...box,
    x: clamp(box.x + dx, 0, 1 - box.w),
    y: clamp(box.y + dy, 0, 1 - box.h),
  };
}

/** Drag one handle by (dx, dy); the opposite edges stay put, size never drops below MIN_SIZE. */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number): Box {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_SIZE);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_SIZE, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_SIZE, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function roundBox(b: Box): Box {
  return { x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) };
}

export function sameBox(a: Box, b: Box): boolean {
  const ra = roundBox(a);
  const rb = roundBox(b);
  return ra.x === rb.x && ra.y === rb.y && ra.w === rb.w && ra.h === rb.h;
}

/** CSS percentage style for an absolutely-positioned overlay of ``box``. */
export function boxStyle(b: Box) {
  return {
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  };
}
