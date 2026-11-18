/**
 * Where one detector target was found on every picture (v1.169.0): one dot per picture at its box centre, in the picture
 * the detector works on (x to the right, y downwards, the same coordinates as the boxes drawn on the picture). No
 * reference is needed: the dense area is normal, and dots far from it are the pictures worth a look.
 *
 * The review zone is the area the box usually lies in: dots inside are green, outside red, and the count of pictures
 * outside follows the zone live while its square handle (size) or round handle (place) is dragged; the zone is saved on
 * release through `onZone`. A review aid only: it decides nothing further down the Chain. A click on the chart outside the
 * handles asks for the pictures found near that spot (`onSpot`).
 */
import { useMemo, useRef, useState } from "react";
import { judgeZone, dragZone, edgeHandle, Pt2, Zone } from "../zoneGeometry";
import { useHeatImage } from "./heatChoice";

const IN = "#1a7f37";
const OUT = "#c62828";
const PLAIN = "#2a6fdb";

/** The part of the picture to draw: the picture itself when its size is known, widened to every dot and the zone. */
export function mapBounds(points: Pt2[], extent: { w: number; h: number } | null, zone: Zone | null): { x: number; y: number; w: number; h: number } {
  const xs: number[] = extent ? [0, extent.w] : [];
  const ys: number[] = extent ? [0, extent.h] : [];
  for (const p of points) { xs.push(p[0]); ys.push(p[1]); }
  if (zone?.center) {
    const [rx, ry] = zone.shape === "circle" ? [zone.radius, zone.radius] : zone.half;
    xs.push(zone.center[0] - rx, zone.center[0] + rx);
    ys.push(zone.center[1] - ry, zone.center[1] + ry);
  }
  if (!xs.length) return { x: 0, y: 0, w: 100, h: 100 };
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 10), h = Math.max(maxY - minY, 10);
  const pad = Math.max(w, h) * 0.04;
  return { x: minX - pad, y: minY - pad, w: w + 2 * pad, h: h + 2 * pad };
}

/** A first zone radius round `centre`: one that holds about nine in ten of the pictures (never under 5 px). */
export function startRadius(points: Pt2[], centre: Pt2): number {
  if (!points.length) return 10;
  const d = points.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])).sort((a, b) => a - b);
  return Math.max(5, Math.round(d[Math.min(d.length - 1, Math.floor(d.length * 0.9))] * 10) / 10);
}

/** How many of `points` lie outside `zone` (none without a zone). */
export function countOutside(points: Pt2[], zone: Zone | null): number {
  if (!zone?.center) return 0;
  return points.filter((p) => judgeZone(p, zone) === "fail").length;
}

export default function PositionMap({ points, extent, zone, onZone, onSpot, heat, missing, label }: {
  /** The box centre of the target per picture; null where it was not found. */
  points: Record<string, Pt2 | null>;
  /** The size of the picture the detector works on, when known. */
  extent: { w: number; h: number } | null;
  zone: Zone | null;
  onZone: (zone: Zone) => void;
  /** A click on the chart: where, and the radius the "near" pictures lie within (chart units = picture pixels). */
  onSpot: (at: Pt2, radius: number) => void;
  /** Heat map instead of dots, with this smoothing factor (1 = automatic). */
  heat?: { smoothing: number } | null;
  /** Pictures where the target was not found (counted, not drawn). */
  missing: number;
  /** The target's name, for the texts. */
  label: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Zone | null>(null);
  const shown = drag ?? zone;
  const entries = useMemo(() => Object.entries(points).filter((e): e is [string, Pt2] => !!e[1]), [points]);
  const all = useMemo(() => entries.map(([, p]) => p), [entries]);
  const view = mapBounds(all, extent, zone);
  const heatMap = useHeatImage(heat ? all : null, view, heat?.smoothing ?? 1);
  const u = Math.max(view.w, view.h) / 100; // one drawing unit: dots and handles keep about the same size on screen
  const outside = countOutside(all, shown);
  const handle = shown ? edgeHandle(shown) : null;
  const at = (clientX: number, clientY: number): Pt2 => {
    const r = svg.current!.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / (r.width || 1)) * view.w, view.y + ((clientY - r.top) / (r.height || 1)) * view.h];
  };
  const startDrag = (which: "centre" | "edge") => (e: React.PointerEvent) => {
    if (!shown) return;
    e.preventDefault();
    e.stopPropagation();
    let last = shown;
    const move = (ev: PointerEvent) => {
      last = dragZone(which, at(ev.clientX, ev.clientY), last);
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      swallowClick.current = true;
      setTimeout(() => { swallowClick.current = false; }, 0); // the click that ends a drag is not a click on a spot
      setDrag(null);
      onZone(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const fill = (p: Pt2) => (shown?.center ? (judgeZone(p, shown) === "pass" ? IN : OUT) : PLAIN);
  return (
    <div className="flow-zone">
      <svg
        ref={svg}
        data-testid="position-map"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ width: "100%", maxWidth: 640, aspectRatio: `${view.w} / ${view.h}`, border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", touchAction: "none", cursor: "crosshair" }}
        onClick={(e) => { if (!swallowClick.current) onSpot(at(e.clientX, e.clientY), 2.5 * u); }}
      >
        {extent && <rect x={0} y={0} width={extent.w} height={extent.h} fill="none" stroke="var(--border)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        {heatMap?.url && <image data-testid="position-heat" href={heatMap.url} x={view.x} y={view.y} width={view.w} height={view.h} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />}
        {shown?.center && shown.shape === "circle" && (
          <circle data-testid="review-zone" cx={shown.center[0]} cy={shown.center[1]} r={shown.radius} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
        )}
        {shown?.center && shown.shape === "rect" && (
          <rect data-testid="review-zone" x={shown.center[0] - shown.half[0]} y={shown.center[1] - shown.half[1]} width={2 * shown.half[0]} height={2 * shown.half[1]} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
        )}
        {!heat && entries.map(([frame, p]) => (
          <circle key={frame} data-testid="position-dot" cx={p[0]} cy={p[1]} r={0.7 * u} fill={fill(p)} fillOpacity={0.7}>
            <title>{`${frame}: x ${p[0].toFixed(1)}, y ${p[1].toFixed(1)} px`}</title>
          </circle>
        ))}
        {shown?.center && (
          <circle data-testid="review-zone-centre" cx={shown.center[0]} cy={shown.center[1]} r={1.4 * u} fill="#2a7" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} onPointerDown={startDrag("centre")}>
            <title>Drag to move the zone</title>
          </circle>
        )}
        {handle && (
          <rect data-testid="review-zone-edge" x={handle[0] - 1.5 * u} y={handle[1] - 1.5 * u} width={3 * u} height={3 * u} fill="#2a7" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "nwse-resize" }} onPointerDown={startDrag("edge")}>
            <title>Drag to resize the zone</title>
          </rect>
        )}
      </svg>
      <p role="status" data-testid="position-count" style={{ margin: "4px 0 0" }}>
        {shown?.center ? <><strong>{outside}</strong> of {all.length} outside the zone</> : `${all.length} found`}
        {missing > 0 ? ` · ${missing} not found` : ""}
      </p>
      {heatMap && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
          Heat map of {heatMap.count} picture{heatMap.count === 1 ? "" : "s"}: blue is few, red is the densest spot, about {Math.round(heatMap.max)} pictures around it.
        </p>
      )}
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        Each dot is where “{label}” was found on one picture (its box centre, in pixels of the picture this detector works on).
        {shown?.center ? " Drag the round handle to move the zone, the square one to resize it." : " “Put the zone on the densest spot” draws the area the box usually lies in."}
        {" "}Click the chart to list the pictures found near that spot.
      </p>
    </div>
  );
}
