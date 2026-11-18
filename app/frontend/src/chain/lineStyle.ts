import type { Edge } from "@xyflow/react";

/**
 * How the Chain draws its lines. A viewing choice kept in this browser (nothing about the chain's data): the defaults are the
 * look the Chain always had (right angles with slightly rounded corners).
 */
export type LineShape = "rounded" | "right-angle" | "curved" | "straight";

export interface LineStyle {
  shape: LineShape;
  /** Rounded: the radius of each corner in pixels. */
  radius: number;
  /** Right angle and rounded: how far a line leaves its dot before it turns, in pixels. */
  offset: number;
  /** Curved: how strongly the line bends, 0 (almost straight) to 1. */
  curvature: number;
}

export const DEFAULT_LINE_STYLE: LineStyle = { shape: "rounded", radius: 5, offset: 20, curvature: 0.25 };

export const LINE_SHAPES: { value: LineShape; label: string; hint: string }[] = [
  { value: "rounded", label: "Rounded", hint: "Right angles with round corners" },
  { value: "right-angle", label: "Right angle", hint: "Right angles with sharp corners" },
  { value: "curved", label: "Curved", hint: "Smooth S-curves" },
  { value: "straight", label: "Straight", hint: "A direct line from dot to dot" },
];

export const RADIUS_RANGE = { min: 0, max: 40, step: 1 };
export const OFFSET_RANGE = { min: 5, max: 80, step: 5 };
export const CURVATURE_RANGE = { min: 0.05, max: 1, step: 0.05 };

const KEY = "picturesorter.chain.lineStyle";

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** What this browser remembered, repaired field by field (an unknown or damaged value falls back to the default). */
export function loadLineStyle(): LineStyle {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LineStyle> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_LINE_STYLE;
    const d = DEFAULT_LINE_STYLE;
    return {
      shape: LINE_SHAPES.some((s) => s.value === raw.shape) ? (raw.shape as LineShape) : d.shape,
      radius: clamp(raw.radius, RADIUS_RANGE.min, RADIUS_RANGE.max, d.radius),
      offset: clamp(raw.offset, OFFSET_RANGE.min, OFFSET_RANGE.max, d.offset),
      curvature: clamp(raw.curvature, CURVATURE_RANGE.min, CURVATURE_RANGE.max, d.curvature),
    };
  } catch {
    return DEFAULT_LINE_STYLE; // storage unavailable or damaged
  }
}

export function saveLineStyle(style: LineStyle): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(style));
  } catch {
    /* storage unavailable: the style lasts until the page is closed */
  }
}

/** The React Flow edge type and path options that draw a line in this style. */
export function edgeLook(style: LineStyle): Pick<Edge, "type"> & { pathOptions?: Record<string, number> } {
  switch (style.shape) {
    case "right-angle":
      return { type: "smoothstep", pathOptions: { borderRadius: 0, offset: style.offset } };
    case "curved":
      return { type: "default", pathOptions: { curvature: style.curvature } };
    case "straight":
      return { type: "straight" };
    default:
      return { type: "smoothstep", pathOptions: { borderRadius: style.radius, offset: style.offset } };
  }
}
