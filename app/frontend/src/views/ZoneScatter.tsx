import { useMemo, useRef, useState } from "react";
import { autoBandwidth, density2d, heatPixels } from "../density";
import { dragZone, edgeHandle, judgeZone, plotBounds, Pt2, Verdict, Zone } from "../zoneGeometry";

const COLOUR: Record<Verdict, string> = { pass: "#1a7f37", fail: "#c62828", undetermined: "#888" };
const ORIGIN: Pt2 = [0, 0];

/**
 * Where B lies for every picture. `points` are B's (dx, dy) from A in pixels (y down like the picture).
 *
 * Until the nominal (the zone's centre: where B should lie relative to A) is set, the dots are drawn from A, which is
 * the cross at (0, 0), and a click on a dot or the empty chart sets the nominal. Once it is set, the chart is centred
 * on the nominal: each dot is its distance from it, the zone is drawn around the cross, green inside and red outside
 * (grey where B is missing), and the square handle on the zone's edge resizes it (saved on release through `onZone`).
 */
export default function ZoneScatter({ points, zone, onZone, onCentre, heat }: {
  points: Record<string, Pt2 | null>;
  /** Heat map instead of dots: the (dx, dy) of the pictures to count (the ones the grid shows) and the smoothing factor (1 = automatic). */
  heat?: { points: Pt2[]; smoothing: number } | null;
  zone: Zone;
  onZone: (zone: Zone) => void;
  onCentre: (at: Pt2) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Zone | null>(null);
  const nominal = zone.center;
  const origin = nominal ?? ORIGIN; // what the dots are measured from
  const rel = (p: Pt2): Pt2 => [p[0] - origin[0], p[1] - origin[1]];
  const shown: Zone = drag ?? { ...zone, center: nominal ? ORIGIN : null };
  const entries = Object.entries(points).map(([frame, p]) => [frame, p, p ? rel(p) : null] as const);
  const view = plotBounds(entries.map(([, , r]) => r), shown);
  const heatMap = useMemo(() => {
    if (!heat) return null;
    const rel0 = heat.points.map((p): Pt2 => [p[0] - origin[0], p[1] - origin[1]]);
    const d = density2d(rel0, view, autoBandwidth(rel0, view.w / 20) * heat.smoothing, 96);
    let url: string | null = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = d.n;
      canvas.height = d.n;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(new ImageData(heatPixels(d), d.n, d.n), 0, 0);
        url = canvas.toDataURL();
      }
    } catch { /* no canvas here: the legend still says where the pile is */ }
    return { url, max: d.max, count: heat.points.length };
  }, [heat, origin[0], origin[1], view.x, view.y, view.w, view.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const u = view.w / 100; // one drawing unit: dots and handles keep about the same size on screen
  const handle = edgeHandle(shown);
  const at = (clientX: number, clientY: number): Pt2 => {
    const r = svg.current!.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / (r.width || 1)) * view.w, view.y + ((clientY - r.top) / (r.height || 1)) * view.h];
  };
  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let last = shown;
    const move = (ev: PointerEvent) => {
      last = dragZone("edge", at(ev.clientX, ev.clientY), last);
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      swallowClick.current = true;
      setTimeout(() => { swallowClick.current = false; }, 0);
      setDrag(null);
      onZone({ ...last, center: nominal });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const place = (p: Pt2) => {
    if (swallowClick.current) return;
    onCentre([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  };
  return (
    <div className="flow-zone">
      <svg
        ref={svg}
        data-testid="zone-scatter"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ width: "100%", maxWidth: 520, aspectRatio: "1 / 1", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", touchAction: "none" }}
        onClick={(e) => { if (!nominal) place(at(e.clientX, e.clientY)); }}
      >
        <line x1={view.x} y1={0} x2={view.x + view.w} y2={0} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={view.y} x2={0} y2={view.y + view.h} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {heatMap?.url && <image data-testid="zone-heat" href={heatMap.url} x={view.x} y={view.y} width={view.w} height={view.h} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />}
        {nominal && shown.shape === "circle" && (
          <circle data-testid="zone-shape" cx={0} cy={0} r={shown.radius} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
        {nominal && shown.shape === "rect" && (
          <rect data-testid="zone-shape" x={-shown.half[0]} y={-shown.half[1]} width={2 * shown.half[0]} height={2 * shown.half[1]} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
        {!heat && entries.map(([frame, p, r]) => p && r && (
          <circle
            key={frame}
            data-testid="zone-dot"
            cx={r[0]}
            cy={r[1]}
            r={0.9 * u}
            fill={COLOUR[judgeZone(r, shown)]}
            fillOpacity={0.75}
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); place(p); }}
          >
            <title>{nominal
              ? `${frame}: dx ${r[0].toFixed(1)}, dy ${r[1].toFixed(1)} px from the nominal · click to take its position as the nominal`
              : `${frame}: dx ${p[0].toFixed(1)}, dy ${p[1].toFixed(1)} px from A · click to take it as the nominal`}</title>
          </circle>
        ))}
        <g stroke={nominal ? "#2a7" : "var(--text, #333)"} strokeWidth={2} style={{ pointerEvents: "none" }}>
          <line data-testid="zone-cross" x1={-1.6 * u} y1={0} x2={1.6 * u} y2={0} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={-1.6 * u} x2={0} y2={1.6 * u} vectorEffect="non-scaling-stroke" />
        </g>
        <text x={2 * u} y={-2 * u} fontSize={3 * u} fill="var(--text, #333)" style={{ pointerEvents: "none" }}>{nominal ? "nominal" : "A"}</text>
        {handle && (
          <rect data-testid="zone-edge" x={handle[0] - 1.5 * u} y={handle[1] - 1.5 * u} width={3 * u} height={3 * u} fill="#2a7" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "nwse-resize" }} onPointerDown={resize}>
            <title>Drag to resize the zone</title>
          </rect>
        )}
      </svg>
      {heatMap && (
        <p className="muted" data-testid="zone-heat-legend" style={{ margin: "4px 0 0", fontSize: 12 }}>
          Heat map of {heatMap.count} picture{heatMap.count === 1 ? "" : "s"}: blue is few, red is the densest spot, about {Math.round(heatMap.max)} pictures around it (within one smoothing width).
        </p>
      )}
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        {nominal
          ? "Each dot is how far B is from its nominal (the cross), in pixels: x to the right, y downwards. Drag the square to resize the zone; click a dot to take its position as the nominal."
          : "Dots are B's position from A (the cross), in pixels: x to the right, y downwards. Click a dot (or the chart) to set the nominal of B."}
      </p>
    </div>
  );
}
