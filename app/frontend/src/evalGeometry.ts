/**
 * The drawing of an Evaluation box over a picture: the pass region of its rule, so the verdict of a picture can be read
 * off the picture itself. Picture pixels, y down; A is the first point of the Calculate box behind the evaluation.
 *  - zone (an Offset): the circle or rectangle at A + the zone centre, with a cross at the centre (the nominal place of B);
 *  - angle: a wedge from A around the nominal direction, nominal ± tolerance (turning as the Calculate box turns);
 *  - distance: the ring around A between nominal - tolerance and nominal + tolerance;
 *  - dx / dy: the band between two vertical / horizontal lines.
 * Mirrors `flow.judge_zone` and `flow.judge`. Nothing is drawn while the rule has no nominal (or no zone centre).
 */
import type { Pt } from "./calcGeometry";
import type { Zone } from "./zoneGeometry";

export interface EvalSpec {
  mode: "tolerance" | "zone";
  op: string;
  zone: Zone;
  nominal: number | null;
  tolerance: number;
  clockwise: boolean;
  unit: string;
}
export interface EvalLayer {
  /** Filled regions (the pass region), as SVG path data; `evenodd` for a ring. */
  regions: { d: string; evenodd?: boolean }[];
  /** Region edges and the nominal line / cross. */
  segments: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }[];
  paths: { d: string; dashed?: boolean }[];
  labels: { x: number; y: number; text: string; anchor: "start" | "middle" | "end" }[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const circlePath = (cx: number, cy: number, r: number) => `M ${r1(cx - r)} ${r1(cy)} a ${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0 a ${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0 Z`;

export function evalLayer(spec: EvalSpec, a: Pt, b: Pt, size: { w: number; h: number }, value: number | null, u: number): EvalLayer | null {
  const layer: EvalLayer = { regions: [], segments: [], paths: [], labels: [] };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (spec.mode === "zone") {
    const c = spec.zone.center;
    if (!c) return null;
    const cx = a.x + c[0];
    const cy = a.y + c[1];
    if (spec.zone.shape === "circle") {
      const r = spec.zone.radius;
      layer.regions.push({ d: circlePath(cx, cy, r) });
      layer.paths.push({ d: circlePath(cx, cy, r) });
      layer.labels.push({ x: cx, y: cy - r - 1.5 * u, text: `${value === null ? "?" : r1(value)} / ${r1(r)} px`, anchor: "middle" });
    } else {
      const [hw, hh] = spec.zone.half;
      const d = `M ${r1(cx - hw)} ${r1(cy - hh)} h ${r1(2 * hw)} v ${r1(2 * hh)} h ${r1(-2 * hw)} Z`;
      layer.regions.push({ d });
      layer.paths.push({ d });
      layer.labels.push({ x: cx, y: cy - hh - 1.5 * u, text: `off ${r1(dx - c[0])}, ${r1(dy - c[1])} of ±${r1(hw)}, ±${r1(hh)} px`, anchor: "middle" });
    }
    layer.segments.push({ x1: cx - 1.5 * u, y1: cy, x2: cx + 1.5 * u, y2: cy }, { x1: cx, y1: cy - 1.5 * u, x2: cx, y2: cy + 1.5 * u });
    return layer;
  }
  if (spec.nominal === null) return null;
  const { nominal, tolerance } = spec;
  const range = `${r1(nominal)} ± ${r1(tolerance)}${spec.unit ? ` ${spec.unit}` : ""}`;
  if (spec.op === "angle") {
    const sign = spec.clockwise ? 1 : -1; // screen y points down: counter-clockwise on screen is a negative y turn
    const reach = Math.max(Math.hypot(dx, dy) * 1.25, 12 * u);
    const at = (deg: number, r: number): Pt => ({ x: a.x + r * Math.cos((deg * Math.PI) / 180), y: a.y + sign * r * Math.sin((deg * Math.PI) / 180) });
    if (tolerance >= 180) {
      layer.regions.push({ d: circlePath(a.x, a.y, reach) });
    } else {
      const p1 = at(nominal - tolerance, reach);
      const p2 = at(nominal + tolerance, reach);
      // SVG sweep-flag 1 turns clockwise on screen; the angle grows counter-clockwise unless `clockwise`
      const wedge = `M ${r1(a.x)} ${r1(a.y)} L ${r1(p1.x)} ${r1(p1.y)} A ${r1(reach)} ${r1(reach)} 0 ${2 * tolerance > 180 ? 1 : 0} ${spec.clockwise ? 1 : 0} ${r1(p2.x)} ${r1(p2.y)} Z`;
      layer.regions.push({ d: wedge });
      layer.paths.push({ d: wedge, dashed: true });
    }
    const n = at(nominal, reach);
    layer.segments.push({ x1: a.x, y1: a.y, x2: n.x, y2: n.y, dashed: true });
    const t = at(nominal, reach + 1.5 * u);
    layer.labels.push({ x: t.x, y: t.y, text: range, anchor: t.x >= a.x ? "start" : "end" });
    return layer;
  }
  if (spec.op === "distance") {
    const outer = nominal + tolerance;
    if (outer <= 0) return null;
    const inner = Math.max(0, nominal - tolerance);
    layer.regions.push({ d: inner > 0 ? `${circlePath(a.x, a.y, outer)} ${circlePath(a.x, a.y, inner)}` : circlePath(a.x, a.y, outer), evenodd: true });
    layer.paths.push({ d: circlePath(a.x, a.y, outer), dashed: true });
    if (inner > 0) layer.paths.push({ d: circlePath(a.x, a.y, inner), dashed: true });
    if (nominal > 0) layer.paths.push({ d: circlePath(a.x, a.y, nominal) });
    layer.labels.push({ x: a.x, y: a.y - outer - 1.5 * u, text: range, anchor: "middle" });
    return layer;
  }
  if (spec.op === "dx") {
    const lo = a.x + nominal - tolerance;
    const hi = a.x + nominal + tolerance;
    layer.regions.push({ d: `M ${r1(lo)} 0 H ${r1(hi)} V ${size.h} H ${r1(lo)} Z` });
    layer.segments.push({ x1: lo, y1: 0, x2: lo, y2: size.h, dashed: true }, { x1: hi, y1: 0, x2: hi, y2: size.h, dashed: true }, { x1: a.x + nominal, y1: 0, x2: a.x + nominal, y2: size.h });
    layer.labels.push({ x: a.x + nominal, y: 3 * u, text: `dx ${range}`, anchor: "middle" });
    return layer;
  }
  if (spec.op === "dy") {
    const lo = a.y + nominal - tolerance;
    const hi = a.y + nominal + tolerance;
    layer.regions.push({ d: `M 0 ${r1(lo)} V ${r1(hi)} H ${size.w} V ${r1(lo)} Z` });
    layer.segments.push({ x1: 0, y1: lo, x2: size.w, y2: lo, dashed: true }, { x1: 0, y1: hi, x2: size.w, y2: hi, dashed: true }, { x1: 0, y1: a.y + nominal, x2: size.w, y2: a.y + nominal });
    layer.labels.push({ x: 1.5 * u, y: a.y + nominal - 1.5 * u, text: `dy ${range}`, anchor: "start" });
    return layer;
  }
  return null;
}
