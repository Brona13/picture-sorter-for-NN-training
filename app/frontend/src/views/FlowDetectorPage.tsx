import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, FlowBox, FlowDetector, frameImageUrl } from "../api";

const COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#c2255c", "#5c940d"];

/** Rectangle of a drag in picture pixels, from two corners. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number] {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return [Math.round(x), Math.round(y), Math.round(Math.abs(a.x - b.x)), Math.round(Math.abs(a.y - b.y))];
}

type Props = {
  camera: string;
  nodeId: string;
  /** The target to draw an example for, when the page was opened from a target's button. */
  target?: string;
  onClose: () => void;
  onChanged: () => void;
};

/**
 * The focused page of a detector: draw example crops of a target on a picture, and review what the detector found.
 * A found box is drawn turned as the part is; a target that was not found can be placed by a click.
 */
export default function FlowDetectorPage({ camera, nodeId, target: initialTarget, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<FlowDetector | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState(initialTarget ?? "");
  const [mode, setMode] = useState<"draw" | "place">(initialTarget ? "draw" : "place");
  const [onlyReview, setOnlyReview] = useState(false);
  const [boxes, setBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [review, setReview] = useState<string[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const loadDetail = useCallback(() => api.flowNode(camera, nodeId).then((d) => d.kind === "detector" && setDetail(d)).catch(fail), [camera, nodeId]);
  const loadBoxes = useCallback(
    () => api.flowBoxes(camera, nodeId).then((b) => { setBoxes(b.boxes); setReview(b.review); }).catch(fail),
    [camera, nodeId],
  );

  useEffect(() => {
    void loadDetail();
    void loadBoxes();
    api.frames(camera).then((r) => setFrames(r.frames)).catch(fail);
  }, [camera, nodeId, loadDetail, loadBoxes]);

  const shown = useMemo(() => (onlyReview ? frames.filter((f) => review.includes(f)) : frames), [frames, review, onlyReview]);
  const frame = shown[Math.min(index, Math.max(0, shown.length - 1))];
  const names = detail?.targets.map((t) => t.name) ?? [];
  const chosen = target || names[0] || "";

  useEffect(() => setIndex(0), [onlyReview]);
  useEffect(() => setSize(null), [frame]);

  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size!.w, y: ((e.clientY - r.top) / r.height) * size!.h };
  };

  const finish = async (to: { x: number; y: number }) => {
    if (!drag || !frame) return;
    const from = drag.from;
    setDrag(null);
    if (mode === "place") {
      try {
        await api.flowSetBox(camera, nodeId, frame, chosen, Math.round(to.x * 10) / 10, Math.round(to.y * 10) / 10);
        setError(null);
        await loadBoxes();
        onChanged();
      } catch (e) { fail(e); }
      return;
    }
    const box = rectOf(from, to);
    if (box[2] < 5 || box[3] < 5) { setError("Drag a rectangle around what to find."); return; }
    try {
      const next = await api.flowAddExample(camera, nodeId, chosen, frame, box);
      if (next.kind === "detector") setDetail(next);
      setError(null);
      onChanged();
    } catch (e) { fail(e); }
  };

  const found = frame ? boxes[frame] ?? {} : {};
  const missing = names.filter((n) => !(n in found));
  const examplesHere = (detail?.targets ?? []).flatMap((t, ti) => t.examples.filter((e) => e.frame === frame).map((e) => ({ name: t.name, ti, box: e.box })));

  return (
    <div className="flow-page" data-testid="flow-detector-page">
      <div className="flow-page-bar">
        <button type="button" onClick={onClose}>← Back to the chain</button>
        <strong>{nodeId}</strong>
        <label>
          Target{" "}
          <select value={chosen} onChange={(e) => setTarget(e.target.value)} aria-label="Target">
            {names.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label><input type="radio" name="flow-mode" checked={mode === "draw"} onChange={() => setMode("draw")} /> Draw example</label>
        <label><input type="radio" name="flow-mode" checked={mode === "place"} onChange={() => setMode("place")} /> Place the box</label>
        <label><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> Only pictures to review ({review.length})</label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="flow-page-nav">
        <button type="button" disabled={index <= 0} onClick={() => setIndex(index - 1)}>‹ Previous</button>
        <select value={frame ?? ""} onChange={(e) => setIndex(Math.max(0, shown.indexOf(e.target.value)))} aria-label="Picture">
          {shown.map((f) => <option key={f}>{f}</option>)}
        </select>
        <button type="button" disabled={index >= shown.length - 1} onClick={() => setIndex(index + 1)}>Next ›</button>
        <span className="muted">{shown.length ? `${Math.min(index, shown.length - 1) + 1} / ${shown.length}` : "no pictures"}</span>
        {missing.length > 0 && detail?.status === "fresh" && <span role="status">Not found here: {missing.join(", ")}</span>}
      </div>
      <p className="muted">
        {mode === "draw" ? `Drag a rectangle around the “${chosen}” in the picture. Include the geometry that tells it from its twin.` : `Click where the centre of “${chosen}” is.`}
      </p>
      {frame && (
        <div className="flow-stage">
          <img src={frameImageUrl(camera, frame)} alt={frame} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && (
            <svg
              ref={svg}
              viewBox={`0 0 ${size.w} ${size.h}`}
              data-testid="flow-overlay"
              onPointerDown={(e) => { const p = point(e); setDrag({ from: p, to: p }); (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId); }}
              onPointerMove={(e) => drag && setDrag({ from: drag.from, to: point(e) })}
              onPointerUp={(e) => void finish(point(e))}
            >
              {examplesHere.map((e, i) => (
                <rect key={`ex${i}`} x={e.box[0]} y={e.box[1]} width={e.box[2]} height={e.box[3]} fill="none" stroke={COLORS[e.ti % COLORS.length]} strokeDasharray="4 3" />
              ))}
              {names.map((n, i) => {
                const b = found[n];
                if (!b) return null;
                return (
                  <g key={n} transform={`translate(${b.x} ${b.y}) rotate(${-b.angle})`}>
                    <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={2} />
                    <circle r={2} fill={COLORS[i % COLORS.length]} />
                    <text x={-b.w / 2} y={-b.h / 2 - 3} fontSize={12} fill={COLORS[i % COLORS.length]} transform={`rotate(${b.angle})`}>
                      {n}{b.source === "human" ? " ✎" : ""}
                    </text>
                  </g>
                );
              })}
              {drag && mode === "draw" && (() => { const r = rectOf(drag.from, drag.to); return <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="rgba(255,255,255,.15)" stroke="#fff" />; })()}
            </svg>
          )}
        </div>
      )}
    </div>
  );
}
