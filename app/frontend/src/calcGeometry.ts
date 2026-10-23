/** The drawing that shows how a Calculate box got its number from two points (picture pixels, y down). */
export type Pt = { x: number; y: number };
export interface Geometry {
  dots: { x: number; y: number; name: string }[];
  segments: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean; strong?: boolean }[];
  /** SVG path data of an arc. */
  arcs: { d: string }[];
  labels: { x: number; y: number; text: string; anchor: "start" | "middle" | "end" }[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The shapes of `op` between A and B, mirroring `flow.compute`: the angle is that of the vector A to B, 0° pointing
 * right, counter-clockwise on screen unless `clockwise`, drawn as an arc from the dashed right-pointing reference ray;
 * the distance is the line itself; dx and dy are the legs of the right triangle (the measured one solid, the other
 * dashed). `u` is one drawing unit (about 1 % of the picture) that sizes the arc, dots and labels.
 */
export function calcShapes(op: string, a: Pt, b: Pt, names: [string, string], clockwise: boolean, value: number | null, unit: string, u: number): Geometry {
  const g: Geometry = { dots: [{ ...a, name: names[0] }, { ...b, name: names[1] }], segments: [], arcs: [], labels: [] };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const text = value === null ? "" : `${r1(value)}${unit ? ` ${unit}` : ""}`;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (op === "distance") {
    g.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, strong: true });
    g.labels.push({ x: mid.x, y: mid.y - 1.5 * u, text, anchor: "middle" });
  } else if (op === "offset") {
    g.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: a.y, strong: true }, { x1: b.x, y1: a.y, x2: b.x, y2: b.y, strong: true }, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, dashed: true });
    g.labels.push({ x: mid.x, y: mid.y - 1.5 * u, text: `dx ${r1(dx)}, dy ${r1(dy)} px`, anchor: "middle" });
  } else if (op === "dx") {
    g.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: a.y, strong: true }, { x1: b.x, y1: a.y, x2: b.x, y2: b.y, dashed: true });
    g.labels.push({ x: (a.x + b.x) / 2, y: a.y - 1.5 * u, text: `dx ${text}`, anchor: "middle" });
  } else if (op === "dy") {
    g.segments.push({ x1: a.x, y1: a.y, x2: a.x, y2: b.y, strong: true }, { x1: a.x, y1: b.y, x2: b.x, y2: b.y, dashed: true });
    g.labels.push({ x: a.x + 1.5 * u, y: (a.y + b.y) / 2, text: `dy ${text}`, anchor: "start" });
  } else if (op === "angle") {
    g.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, strong: true });
    const radius = Math.max(4 * u, Math.min(dist * 0.3, 10 * u));
    g.segments.push({ x1: a.x, y1: a.y, x2: a.x + radius * 1.4, y2: a.y, dashed: true });
    const theta = value ?? ((Math.atan2(clockwise ? dy : -dy, dx) * 180) / Math.PI + 360) % 360;
    if (theta > 0.5 && theta < 359.5) {
      const rad = (theta * Math.PI) / 180;
      const sign = clockwise ? 1 : -1; // screen y points down: counter-clockwise on screen is a negative y turn
      const end = { x: a.x + radius * Math.cos(rad), y: a.y + sign * radius * Math.sin(rad) };
      // SVG sweep-flag 1 turns clockwise on screen
      g.arcs.push({ d: `M ${r1(a.x + radius)} ${r1(a.y)} A ${r1(radius)} ${r1(radius)} 0 ${theta > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${r1(end.x)} ${r1(end.y)}` });
      const half = rad / 2;
      g.labels.push({ x: a.x + (radius + 1.5 * u) * Math.cos(half), y: a.y + sign * (radius + 1.5 * u) * Math.sin(half), text, anchor: Math.cos(half) >= 0 ? "start" : "end" });
    } else {
      g.labels.push({ x: a.x + radius, y: a.y - 1.5 * u, text, anchor: "start" });
    }
  }
  return g;
}
