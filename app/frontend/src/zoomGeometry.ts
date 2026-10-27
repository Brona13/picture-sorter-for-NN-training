/**
 * Pure maths for a zoomable, pannable picture inside a fixed viewport.
 *
 * The view is stored independently of pixel sizes: ``zoom`` (1 = the picture fitted into the
 * viewport) and ``(cx, cy)``, the point of the picture (normalised 0-1) that sits at the viewport's
 * centre. That keeps the view meaningful when the viewport is resized or the next frame has the
 * same shape, so zoom and position can survive a frame change.
 */
export interface View {
  zoom: number;
  cx: number;
  cy: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

export const FIT_VIEW: View = { zoom: 1, cx: 0.5, cy: 0.5 };
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 16;
/** Zoom factor of the zoom in / out buttons and keys. */
export const ZOOM_STEP = 1.25;
/** Wheel sensitivity: one 100-unit notch is about 1.16x. */
export const WHEEL_SENSITIVITY = 0.0015;
/** At least this many viewport pixels of the picture stay visible when panning. */
export const PAN_MARGIN = 60;
/** From this many screen pixels per picture pixel the picture is drawn without smoothing. */
export const PIXELATE_FROM = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const clampZoom = (z: number) => clamp(z, ZOOM_MIN, ZOOM_MAX);

/** The picture's size when fitted (zoom 1) into a ``vw`` x ``vh`` viewport, keeping its shape. */
export function fitSize(imgW: number, imgH: number, vw: number, vh: number): Size {
  const s = Math.min(vw / Math.max(imgW, 1), vh / Math.max(imgH, 1));
  return { w: Math.max(imgW, 1) * s, h: Math.max(imgH, 1) * s };
}

/** Where the picture is drawn inside the viewport (top-left corner and size, in viewport px). */
export function contentRect(view: View, base: Size, vw: number, vh: number): Rect {
  const w = base.w * view.zoom;
  const h = base.h * view.zoom;
  return { x: vw / 2 - view.cx * w, y: vh / 2 - view.cy * h, w, h };
}

function clampOrigin(origin: number, length: number, viewport: number): number {
  const margin = Math.min(PAN_MARGIN, length, viewport);
  return clamp(origin, margin - length, viewport - margin);
}

/** The view that draws the picture at ``zoom`` with its top-left corner at ``(x, y)`` (clamped so it cannot be lost). */
export function viewFromRect(zoom: number, x: number, y: number, base: Size, vw: number, vh: number): View {
  const z = clampZoom(zoom);
  const w = base.w * z;
  const h = base.h * z;
  const ox = clampOrigin(x, w, vw);
  const oy = clampOrigin(y, h, vh);
  return { zoom: z, cx: (vw / 2 - ox) / w, cy: (vh / 2 - oy) / h };
}

/** Zoom by ``factor`` keeping the picture point under the viewport position ``(px, py)`` where it is. */
export function zoomAt(view: View, factor: number, px: number, py: number, base: Size, vw: number, vh: number): View {
  const r = contentRect(view, base, vw, vh);
  const z = clampZoom(view.zoom * factor);
  const f = z / view.zoom;
  return viewFromRect(z, px - (px - r.x) * f, py - (py - r.y) * f, base, vw, vh);
}

/** Move the picture by ``(dx, dy)`` viewport pixels. */
export function panBy(view: View, dx: number, dy: number, base: Size, vw: number, vh: number): View {
  const r = contentRect(view, base, vw, vh);
  return viewFromRect(view.zoom, r.x + dx, r.y + dy, base, vw, vh);
}

/** The zoom at which one picture pixel is exactly one screen pixel (limited to the zoom range). */
export function oneToOneZoom(imgW: number, base: Size): number {
  return clampZoom(Math.max(imgW, 1) / base.w);
}

/** Screen pixels per picture pixel (1 = 100%). */
export function screenScale(view: View, base: Size, imgW: number): number {
  return (base.w * view.zoom) / Math.max(imgW, 1);
}

/**
 * Keeping one picture point (a reference point, in picture pixels) at the same place on screen from picture to picture:
 * `pointOffset` is how far the point lies from the view's centre (picture pixels) and `viewForOffset` is the view of
 * another picture that puts its own point at that same distance from the centre. The zoom is kept.
 */
export function pointOffset(view: View, p: { x: number; y: number }, img: Size): { x: number; y: number } {
  return { x: p.x - view.cx * img.w, y: p.y - view.cy * img.h };
}

const OUT = 1; // how far the view's centre may lie outside the picture, in picture sizes

export function viewForOffset(view: View, p: { x: number; y: number }, offset: { x: number; y: number }, img: Size): View {
  return {
    zoom: view.zoom,
    cx: clamp((p.x - offset.x) / Math.max(img.w, 1), -OUT, 1 + OUT),
    cy: clamp((p.y - offset.y) / Math.max(img.h, 1), -OUT, 1 + OUT),
  };
}
