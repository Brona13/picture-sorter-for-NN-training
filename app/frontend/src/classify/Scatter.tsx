import { useEffect, useMemo, useRef, useState } from "react";
import { ScatterPoint } from "../api";
import { classColor, clusterColor, scoreColor } from "./colors";
import { layoutPoints } from "./scatterLayout";

const W = 720;
const H = 420;
const MIN_DRAG_PX = 6;
const ZOOM_PAD = 1.08;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FULL: Box = { x: 0, y: 0, w: W, h: H };

/** Grow a rectangle to the chart's aspect ratio (so circles stay round) around its centre. */
export function fitView(r: Box): Box {
  const aspect = W / H;
  let w = r.w;
  let h = r.h;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  w *= ZOOM_PAD;
  h *= ZOOM_PAD;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

interface Drag {
  startClient: { x: number; y: number };
  start: { x: number; y: number };
  now: { x: number; y: number };
}

/**
 * 2D scatter of the feature's frames, coloured by cluster, label, outlier score or not at all. Drag a rectangle to zoom into it and report the points inside
 * (``onSelect``); right-click resets the view and clears the selection.
 */
export type ColourBy = "cluster" | "label" | "outlier" | "none";

const GREY = "rgba(120,120,120,.6)";
const UNLABELED = "rgba(150,150,150,.55)";
const PLAIN = "#2a78d6";

export default function Scatter({
  points,
  classes,
  onSelect,
  colourBy = "cluster",
  scores,
}: {
  points: ScatterPoint[];
  classes: string[];
  onSelect?: (selected: ScatterPoint[] | null) => void;
  colourBy?: ColourBy;
  /** Outlier score per frame in [0, 1], used when colouring by outlier score. */
  scores?: Record<string, number>;
}) {
  const fillOf = (p: ScatterPoint): string => {
    if (colourBy === "outlier") return scores && p.frame in scores ? scoreColor(scores[p.frame]) : GREY;
    if (colourBy === "label") return p.label ? classColor(p.label, classes) : UNLABELED;
    if (colourBy === "cluster") return p.cluster === null || p.cluster < 0 ? GREY : clusterColor(p.cluster);
    return PLAIN;
  };
  const isUnique = (p: ScatterPoint) => colourBy === "cluster" && (p.cluster === null || p.cluster < 0);
  const placed = useMemo(() => layoutPoints(points, W, H), [points]);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<Box>(FULL);
  const dragRef = useRef<Drag | null>(null);
  const [view, setView] = useState<Box>(FULL);
  const [sel, setSel] = useState<Box | null>(null);
  const [selFrames, setSelFrames] = useState<Set<string> | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = drag !== null;

  viewRef.current = view;

  const toChart = (cx: number, cy: number): { x: number; y: number } | null => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    const v = viewRef.current;
    return { x: v.x + ((cx - r.left) / r.width) * v.w, y: v.y + ((cy - r.top) / r.height) * v.h };
  };

  const reset = () => {
    dragRef.current = null;
    setDrag(null);
    setView(FULL);
    setSel(null);
    setSelFrames(null);
    onSelect?.(null);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      const p = toChart(e.clientX, e.clientY);
      if (!d || !p) return;
      d.now = p;
      setDrag({ ...d });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      const p = toChart(e.clientX, e.clientY);
      if (!d || !p) return;
      const moved = Math.max(Math.abs(e.clientX - d.startClient.x), Math.abs(e.clientY - d.startClient.y));
      if (moved < MIN_DRAG_PX) return;
      const box: Box = {
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w: Math.abs(p.x - d.start.x),
        h: Math.abs(p.y - d.start.y),
      };
      const inside = placed.filter((q) => q.px >= box.x && q.px <= box.x + box.w && q.py >= box.y && q.py <= box.y + box.h);
      setView(fitView(box));
      setSel(box);
      setSelFrames(new Set(inside.map((q) => q.frame)));
      onSelect?.(inside.map(({ px: _px, py: _py, ...pt }) => pt));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, placed, onSelect]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = toChart(e.clientX, e.clientY);
    if (!p) return;
    const d: Drag = { startClient: { x: e.clientX, y: e.clientY }, start: p, now: p };
    dragRef.current = d;
    setDrag(d);
  };

  const k = view.w / W; // keep marker sizes constant on screen while zoomed
  const zoomed = view !== FULL && view.w !== W;
  const dragBox = drag
    ? {
        x: Math.min(drag.start.x, drag.now.x),
        y: Math.min(drag.start.y, drag.now.y),
        w: Math.abs(drag.now.x - drag.start.x),
        h: Math.abs(drag.now.y - drag.start.y),
      }
    : null;

  return (
    <div>
      <svg
        ref={svgRef}
        role="img"
        aria-label="2D scatter of frames"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ width: "100%", height: "auto", display: "block", border: "1px solid #ddd", cursor: "crosshair", userSelect: "none" }}
        onMouseDown={onMouseDown}
        onContextMenu={(e) => {
          e.preventDefault();
          reset();
        }}
      >
        {placed.map((p) => (
          <g key={p.frame} data-testid={`pt-${p.frame}`} opacity={selFrames && !selFrames.has(p.frame) ? 0.2 : 1}>
            <title>{`${p.frame}${p.cluster === null ? "" : p.cluster < 0 ? " — unique" : ` — cluster ${p.cluster}`}${p.label ? ` — ${p.label}` : ""}${p.representative ? " (representative)" : ""}${p.golden ? ` — golden ${p.golden}` : ""}${scores && p.frame in scores ? ` — outlier ${(scores[p.frame]).toFixed(2)}` : ""}`}</title>
            {p.golden ? (
              <rect
                x={p.px - 6 * k}
                y={p.py - 6 * k}
                width={12 * k}
                height={12 * k}
                transform={`rotate(45 ${p.px} ${p.py})`}
                fill={classColor(p.golden, classes)}
                stroke="#fff"
                strokeWidth={1.5 * k}
              />
            ) : (
              <circle cx={p.px} cy={p.py} r={(isUnique(p) ? 3.5 : 4.5) * k} fill={fillOf(p)} stroke={colourBy === "outlier" ? "rgba(0,0,0,.35)" : undefined} strokeWidth={colourBy === "outlier" ? 0.6 * k : undefined} />
            )}
            {p.representative && <circle cx={p.px} cy={p.py} r={8 * k} fill="none" stroke="#111" strokeWidth={2 * k} />}
          </g>
        ))}
        {sel && <rect data-testid="scatter-selection-box" x={sel.x} y={sel.y} width={sel.w} height={sel.h} fill="none" stroke="#1a73e8" strokeWidth={1.5 * k} strokeDasharray={`${5 * k} ${3 * k}`} />}
        {dragBox && <rect data-testid="scatter-drag-box" x={dragBox.x} y={dragBox.y} width={dragBox.w} height={dragBox.h} fill="rgba(26,115,232,.12)" stroke="#1a73e8" strokeWidth={1.5 * k} />}
      </svg>
      <p style={{ fontSize: 12, margin: "4px 0" }}>
        Drag a rectangle to zoom in and list its frames · right-click to reset the view.{" "}
        {zoomed && (
          <button type="button" onClick={reset}>
            Reset view
          </button>
        )}
      </p>
    </div>
  );
}

/** What the colours mean, for the current "colour by" choice. */
export function ScatterLegend({ colourBy, classes }: { colourBy: ColourBy; classes: string[] }) {
  const chip = (color: string, text: string) => (
    <span key={text} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 }}>
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block" }} />
      {text}
    </span>
  );
  return (
    <p data-testid="scatter-legend" style={{ fontSize: 12, margin: "4px 0" }}>
      {colourBy === "label" && [...classes.map((c) => chip(classColor(c, classes), c)), chip(UNLABELED, "unlabeled")]}
      {colourBy === "cluster" && [chip(clusterColor(0), "a cluster (colour per cluster)"), chip(GREY, "unique")]}
      {colourBy === "outlier" && [chip(scoreColor(0), "typical"), chip(scoreColor(1), "most isolated")]}
      {colourBy === "none" && "Plain dots."} Diamonds are goldens; a ringed dot is a cluster's representative.
    </p>
  );
}
