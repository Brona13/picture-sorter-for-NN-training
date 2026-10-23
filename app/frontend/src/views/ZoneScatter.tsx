import { useRef, useState } from "react";
import { dragZone, edgeHandle, judgeZone, plotBounds, Pt2, Verdict, Zone } from "../zoneGeometry";

const COLOUR: Record<Verdict, string> = { pass: "#1a7f37", fail: "#c62828", undetermined: "#888" };

/**
 * The offsets (dx, dy of B from A, pixels, y down like the picture) of every picture as dots, with the zone drawn over
 * them: green inside, red outside, grey where a point is missing or the zone has no centre yet. A is the cross at
 * (0, 0). Drag the zone's centre dot to move it and the square handle on its edge to resize it (saved on release through
 * `onZone`); click a dot, or the empty chart when there is no centre yet, to put the centre there.
 */
export default function ZoneScatter({ points, zone, onZone, onCentre }: {
  points: Record<string, Pt2 | null>;
  zone: Zone;
  onZone: (zone: Zone) => void;
  onCentre: (at: Pt2) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Zone | null>(null);
  const shown = drag ?? zone;
  const entries = Object.entries(points);
  const view = plotBounds(entries.map(([, p]) => p), shown);
  const u = view.w / 100; // one drawing unit: dots and handles keep about the same size on screen
  const handle = edgeHandle(shown);
  const at = (clientX: number, clientY: number): Pt2 => {
    const r = svg.current!.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / (r.width || 1)) * view.w, view.y + ((clientY - r.top) / (r.height || 1)) * view.h];
  };
  const grab = (which: "centre" | "edge") => (e: React.PointerEvent) => {
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
      setTimeout(() => { swallowClick.current = false; }, 0);
      setDrag(null);
      onZone(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const place = (p: Pt2) => {
    if (swallowClick.current) return;
    onCentre([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  };
  const c = shown.center;
  return (
    <div className="flow-zone">
      <svg
        ref={svg}
        data-testid="zone-scatter"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ width: "100%", maxWidth: 520, aspectRatio: "1 / 1", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--panel)", touchAction: "none" }}
        onClick={(e) => { if (!c) place(at(e.clientX, e.clientY)); }}
      >
        <line x1={view.x} y1={0} x2={view.x + view.w} y2={0} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={view.y} x2={0} y2={view.y + view.h} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {c && shown.shape === "circle" && (
          <circle data-testid="zone-shape" cx={c[0]} cy={c[1]} r={shown.radius} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
        {c && shown.shape === "rect" && (
          <rect data-testid="zone-shape" x={c[0] - shown.half[0]} y={c[1] - shown.half[1]} width={2 * shown.half[0]} height={2 * shown.half[1]} fill="rgba(40,160,110,.12)" stroke="#2a7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
        {entries.map(([frame, p]) => p && (
          <circle
            key={frame}
            data-testid="zone-dot"
            cx={p[0]}
            cy={p[1]}
            r={0.9 * u}
            fill={COLOUR[judgeZone(p, shown)]}
            fillOpacity={0.75}
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); place(p); }}
          >
            <title>{`${frame}: dx ${p[0].toFixed(1)}, dy ${p[1].toFixed(1)} px · click to put the zone centre here`}</title>
          </circle>
        ))}
        <g stroke="var(--text, #333)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }}>
          <line x1={-1.6 * u} y1={0} x2={1.6 * u} y2={0} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={-1.6 * u} x2={0} y2={1.6 * u} vectorEffect="non-scaling-stroke" />
        </g>
        <text x={2 * u} y={-2 * u} fontSize={3 * u} fill="var(--text, #333)" style={{ pointerEvents: "none" }}>A</text>
        {c && (
          <circle data-testid="zone-centre" cx={c[0]} cy={c[1]} r={1.6 * u} fill="#2a7" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} onPointerDown={grab("centre")}>
            <title>Drag to move the zone</title>
          </circle>
        )}
        {handle && (
          <rect data-testid="zone-edge" x={handle[0] - 1.5 * u} y={handle[1] - 1.5 * u} width={3 * u} height={3 * u} fill="#2a7" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "nwse-resize" }} onPointerDown={grab("edge")}>
            <title>Drag to resize the zone</title>
          </rect>
        )}
      </svg>
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        {c ? "Drag the dot to move the zone and the square to resize it." : "Click a dot (or the chart) to put the zone centre there."} A is the cross; x to the right, y downwards, pixels.
      </p>
    </div>
  );
}
