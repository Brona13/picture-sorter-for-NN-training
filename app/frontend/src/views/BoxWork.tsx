import { useEffect, useMemo, useRef, useState } from "react";
import { api, BoxGeometry, BoxSide, flowPictureUrl, FlowBoxModule, FlowNodeDetail } from "../api";
import { PIXEL_CENTRE } from "../pixelCentre";

const COLORS = ["#ff9f1c", "#2ec4ff"];
type Point = [number, number];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The part's own axes on the picture for an angle in degrees (counter-clockwise on screen): x along the part, y "down" in the part. */
export function axesOf(angle: number): { u: Point; v: Point } {
  const t = (angle * Math.PI) / 180;
  return { u: [Math.cos(t), -Math.sin(t)], v: [Math.sin(t), Math.cos(t)] };
}

/**
 * The corners of the turned rectangle (left-top, right-top, right-bottom, left-bottom) after dragging one side by `shift`
 * picture pixels outwards, and the upright box round them. The page shows this while a side is dragged; the server makes the
 * real rectangle when the margin is saved.
 */
export function movedRect(corners: Point[], angle: number, side: BoxSide | null, shift: number): { corners: Point[]; upright: { x0: number; y0: number; x1: number; y1: number } } {
  const { u, v } = axesOf(angle);
  const out: Record<BoxSide, { dir: Point; at: number[] }> = {
    left: { dir: [-u[0], -u[1]], at: [0, 3] },
    right: { dir: u, at: [1, 2] },
    up: { dir: [-v[0], -v[1]], at: [0, 1] },
    down: { dir: v, at: [2, 3] },
  };
  const moved = corners.map((c, i) => (side && out[side].at.includes(i) ? ([c[0] + out[side].dir[0] * shift, c[1] + out[side].dir[1] * shift] as Point) : c));
  const xs = moved.map((c) => c[0]);
  const ys = moved.map((c) => c[1]);
  return { corners: moved, upright: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}

/**
 * The page of a Box (step 2): an example picture with the detector boxes it works from, the rectangle your four numbers make
 * (dashed, turned with the part) and the upright rectangle round it (solid), the one that goes downstream. Dragging the middle
 * of a dashed edge changes that margin, in the part's own direction; the numbers are in the right-hand panel.
 */
export default function BoxWork({ camera, nodeId, detail, setDetail, onError }: {
  camera: string;
  nodeId: string;
  detail: FlowBoxModule;
  setDetail: (d: FlowNodeDetail) => void;
  onError: (e: string | null) => void;
}) {
  const frames = detail.frames;
  const [index, setIndex] = useState(0);
  const [geometry, setGeometry] = useState<BoxGeometry | null>(null);
  const [drag, setDrag] = useState<{ side: BoxSide; start: Point; from: number; shift: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const latestDrag = useRef(drag); // the handlers below outlive a render: they read the drag as it is when the pointer is released
  latestDrag.current = drag;
  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))] ?? null;
  const settings = JSON.stringify([detail.margins, detail.measure_from, detail.mode, detail.holes]);

  useEffect(() => { if (index > 0 && index >= frames.length) setIndex(Math.max(0, frames.length - 1)); }, [frames.length, index]);
  useEffect(() => {
    if (!frame) { setGeometry(null); return; }
    let live = true;
    api.boxGeometry(camera, nodeId, frame).then((g) => live && setGeometry(g)).catch((e) => live && onError(msg(e)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, nodeId, frame, settings]);

  const size = geometry?.size ?? null;
  const rect = geometry?.rect ?? null;
  const at = (e: { clientX: number; clientY: number }): Point | null => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || !size || !r.width || !r.height) return null;
    return [((e.clientX - r.left) / r.width) * size.w, ((e.clientY - r.top) / r.height) * size.h];
  };
  useEffect(() => {
    if (!drag || !rect) return;
    const { u, v } = axesOf(rect.angle);
    const outward: Record<BoxSide, Point> = { left: [-u[0], -u[1]], right: u, up: [-v[0], -v[1]], down: v };
    const move = (e: PointerEvent) => {
      const p = at(e);
      if (p) setDrag((d) => (d ? { ...d, shift: (p[0] - d.start[0]) * outward[d.side][0] + (p[1] - d.start[1]) * outward[d.side][1] } : d));
    };
    const up = () => {
      const done = latestDrag.current;
      setDrag(null);
      if (!done) return;
      const value = Math.round(done.from + done.shift);
      if (value !== done.from) {
        api.flowUpdate(camera, nodeId, { margins: { [done.side]: value } }).then((d) => { onError(null); setDetail(d); }).catch((e) => onError(msg(e)));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.side, rect]);

  const shown = useMemo(() => (rect ? movedRect(rect.corners, rect.angle, drag?.side ?? null, drag?.shift ?? 0) : null), [rect, drag?.side, drag?.shift]);
  const u = size ? Math.max(size.w, size.h) / 100 : 1;
  const halo = { vectorEffect: "non-scaling-stroke" as const };
  const drawn = (c: Point): string => `${c[0] + PIXEL_CENTRE},${c[1] + PIXEL_CENTRE}`;
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2 + PIXEL_CENTRE, (a[1] + b[1]) / 2 + PIXEL_CENTRE];
  const handles: { side: BoxSide; p: Point }[] = shown
    ? [
        { side: "left", p: mid(shown.corners[0], shown.corners[3]) },
        { side: "right", p: mid(shown.corners[1], shown.corners[2]) },
        { side: "up", p: mid(shown.corners[0], shown.corners[1]) },
        { side: "down", p: mid(shown.corners[2], shown.corners[3]) },
      ]
    : [];
  const readyText = detail.holes.length < detail.needed
    ? `Choose ${detail.needed === 1 ? "a detector box" : "two detector boxes"} in the options panel.`
    : frames.length === 0
      ? "None of the pictures has every chosen box found: run the detector in step 1, or check the choice."
      : null;

  return (
    <div className="box-work" data-testid="box-work">
      {readyText && <p className="muted">{readyText}</p>}
      {frame && (
        <>
          <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" aria-label="Previous picture" disabled={index <= 0} onClick={() => setIndex(index - 1)}>◀</button>
            <label>
              Picture{" "}
              <input type="number" aria-label="Picture number" min={1} max={frames.length} value={Math.min(index, frames.length - 1) + 1} style={{ width: 70 }}
                onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 1) setIndex(Math.min(frames.length, Math.round(n)) - 1); }} />
              {" "}of {frames.length}
            </label>
            <button type="button" aria-label="Next picture" disabled={index >= frames.length - 1} onClick={() => setIndex(index + 1)}>▶</button>
            <span className="muted" data-testid="box-frame">{frame}</span>
          </p>
          <div style={{ position: "relative", maxWidth: "100%" }}>
            <img src={flowPictureUrl(camera, nodeId, frame, { size: 1024 })} alt={frame} style={{ width: "100%", display: "block" }} draggable={false} />
            {size && (
              <svg ref={svg} data-testid="box-overlay" viewBox={`0 0 ${size.w} ${size.h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", touchAction: "none" }}>
                {geometry!.holes.map((b, i) => (
                  <g key={`${b.detector}/${b.target}`} data-testid="box-hole" transform={`translate(${b.x + PIXEL_CENTRE} ${b.y + PIXEL_CENTRE}) rotate(${-b.angle})`}>
                    <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} {...halo} />
                    <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={COLORS[i % 2]} strokeWidth={2} {...halo} />
                  </g>
                ))}
                {shown && (
                  <>
                    <rect data-testid="box-upright" x={shown.upright.x0 + PIXEL_CENTRE} y={shown.upright.y0 + PIXEL_CENTRE} width={shown.upright.x1 - shown.upright.x0} height={shown.upright.y1 - shown.upright.y0} fill="rgba(60,207,110,.10)" stroke="rgba(0,0,0,.75)" strokeWidth={4} {...halo} />
                    <rect x={shown.upright.x0 + PIXEL_CENTRE} y={shown.upright.y0 + PIXEL_CENTRE} width={shown.upright.x1 - shown.upright.x0} height={shown.upright.y1 - shown.upright.y0} fill="none" stroke="#3ccf6e" strokeWidth={2} {...halo} />
                    <polygon data-testid="box-turned" points={shown.corners.map(drawn).join(" ")} fill="none" stroke="rgba(0,0,0,.75)" strokeWidth={4} strokeDasharray="6 4" {...halo} />
                    <polygon points={shown.corners.map(drawn).join(" ")} fill="none" stroke="#ffe066" strokeWidth={2} strokeDasharray="6 4" {...halo} />
                    {handles.map(({ side, p }) => (
                      <circle
                        key={side}
                        data-testid={`box-handle-${side}`}
                        cx={p[0]} cy={p[1]} r={1.1 * u}
                        fill="#ffe066" stroke="#000" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                        style={{ pointerEvents: "all", cursor: "grab" }}
                        onPointerDown={(e) => {
                          const start = at(e);
                          if (!start) return;
                          e.preventDefault();
                          setDrag({ side, start, from: detail.margins[side], shift: 0 });
                        }}
                      >
                        <title>{`Drag to change the ${side} margin`}</title>
                      </circle>
                    ))}
                  </>
                )}
              </svg>
            )}
          </div>
          {geometry && geometry.missing.length > 0 && <p role="status">The detector found no {geometry.missing.join(" or ")} on this picture, so it has no rectangle.</p>}
          {shown && rect && (
            <p data-testid="box-numbers">
              Upright rectangle (the one that goes downstream): x {Math.round(shown.upright.x0)}–{Math.round(shown.upright.x1)}, y {Math.round(shown.upright.y0)}–{Math.round(shown.upright.y1)} ·{" "}
              {Math.round(shown.upright.x1 - shown.upright.x0)} × {Math.round(shown.upright.y1 - shown.upright.y0)} px · part direction {Math.round(rect.angle * 10) / 10}°
            </p>
          )}
          <p className="muted">Orange and blue: the detector boxes. Dashed yellow: the rectangle your numbers make, turned with the part (drag the dot in the middle of an edge to change its margin). Green: the upright rectangle round it.</p>
        </>
      )}
    </div>
  );
}
