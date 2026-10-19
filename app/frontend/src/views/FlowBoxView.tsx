import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, FlowBox, FlowDetector, FlowNodeDetail, FlowValues, frameImageUrl, frameThumbUrl } from "../api";
import SidePanel from "../SidePanel";
import FlowBoxPanel, { ToleranceHistogram } from "./FlowBoxPanel";

const COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#c2255c", "#5c940d"];
const STRIP_WINDOW = 60;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Rectangle of a drag in picture pixels, from two corners. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number] {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return [Math.round(x), Math.round(y), Math.round(Math.abs(a.x - b.x)), Math.round(Math.abs(a.y - b.y))];
}

const TITLES = { detector: "Detector", calc: "Calculate", tolerance: "Tolerance" } as const;

export type FlowFocus = { nodeId: string; onBack: () => void };

/**
 * The page of one measurement box, opened from the Chain like the ROI editor: the options on the right, the work on the
 * pictures in the middle. A detector: draw example crops and review the boxes it found. Calculate and Tolerance: the
 * measured value of every picture (and the nominal and tolerance against the histogram).
 */
export default function FlowBoxView({ camera, focus }: { camera: string; focus: FlowFocus }) {
  const { nodeId } = focus;
  const [detail, setDetail] = useState<FlowNodeDetail | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api.flowNode(camera, nodeId).then(setDetail).catch((e) => setError(msg(e)));
    api.chain(camera).then((c) => setLabel(c.nodes.find((n) => n.id === nodeId)?.label ?? nodeId)).catch(() => setLabel(nodeId));
  }, [camera, nodeId]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const title = detail ? TITLES[detail.kind] : "Measurement box";

  const panel = detail ? (
    <FlowBoxPanel camera={camera} nodeId={nodeId} detail={detail} onDetail={setDetail} onChanged={changed} />
  ) : (
    <p className="muted">{error ?? "Loading…"}</p>
  );

  return (
    <SidePanel panel={panel} wide>
      <section className="flow-view">
        <h2>
          {title} — {camera} › {label}
        </h2>
        <p>
          <button type="button" onClick={focus.onBack}>← Back to chain</button>
        </p>
        {error && <p role="alert">{error}</p>}
        {detail?.kind === "detector" && <DetectorWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} version={version} onChanged={changed} onError={setError} />}
        {detail && detail.kind !== "detector" && (
          <ValuesWork camera={camera} nodeId={nodeId} detail={detail} setDetail={setDetail} version={version} onError={setError} />
        )}
      </section>
    </SidePanel>
  );
}

function DetectorWork(p: {
  camera: string;
  nodeId: string;
  detail: FlowDetector;
  setDetail: (d: FlowNodeDetail) => void;
  version: number;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const { camera, nodeId, detail } = p;
  const [frames, setFrames] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"draw" | "place">("draw");
  const [onlyReview, setOnlyReview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ frame: string; box: [number, number, number, number] } | null>(null);
  const [newName, setNewName] = useState("");
  const [boxes, setBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [review, setReview] = useState<string[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);

  const loadBoxes = useCallback(
    () => api.flowBoxes(camera, nodeId).then((b) => { setBoxes(b.boxes); setReview(b.review); }).catch((e) => p.onError(msg(e))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, nodeId],
  );
  useEffect(() => { api.frames(camera).then((r) => setFrames(r.frames)).catch((e) => p.onError(msg(e))); }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadBoxes(); }, [loadBoxes, p.version]);

  const names = detail.targets.map((t) => t.name);
  const chosen = names.includes(target) ? target : names[0] ?? "";
  // With no target yet (or "+ New target" picked) a drag starts a new target: the rectangle first, its name next.
  const naming = mode === "draw" && (names.length === 0 || creating);
  const shown = useMemo(() => (onlyReview ? frames.filter((f) => review.includes(f)) : frames), [frames, review, onlyReview]);
  const at = Math.min(index, Math.max(0, shown.length - 1));
  const frame = shown[at];
  useEffect(() => setIndex(0), [onlyReview]);
  useEffect(() => setSize(null), [frame]);
  useEffect(() => {
    (strip.current?.querySelector('[aria-current="true"]') as HTMLElement | null)?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [frame]);

  const start = Math.max(0, Math.min(at - STRIP_WINDOW / 2, shown.length - STRIP_WINDOW));
  const strip60 = shown.slice(start, start + STRIP_WINDOW);
  const found = frame ? boxes[frame] ?? {} : {};
  const missing = names.filter((n) => !(n in found));
  const examplesHere = detail.targets.flatMap((t, ti) => t.examples.filter((e) => e.frame === frame).map((e) => ({ name: t.name, ti, box: e.box })));
  const statusOf = (f: string) => (detail.status === "none" ? "" : review.includes(f) ? "review" : f in boxes ? "ok" : "");

  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size!.w, y: ((e.clientY - r.top) / r.height) * size!.h };
  };

  const finish = async (to: { x: number; y: number }) => {
    if (!drag || !frame) return;
    const from = drag.from;
    setDrag(null);
    if (naming) {
      const box = rectOf(from, to);
      if (box[2] < 5 || box[3] < 5) { p.onError("Drag a rectangle around what to find."); return; }
      p.onError(null);
      setPending({ frame, box });
      return;
    }
    if (!chosen) return;
    try {
      if (mode === "place") {
        await api.flowSetBox(camera, nodeId, frame, chosen, Math.round(to.x * 10) / 10, Math.round(to.y * 10) / 10);
        await loadBoxes();
      } else {
        const box = rectOf(from, to);
        if (box[2] < 5 || box[3] < 5) { p.onError("Drag a rectangle around what to find."); return; }
        p.setDetail(await api.flowAddExample(camera, nodeId, chosen, frame, box));
      }
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  const saveNew = async () => {
    const name = newName.trim();
    if (!pending || !name) return;
    try {
      if (!names.includes(name)) await api.flowAddTarget(camera, nodeId, name);
      p.setDetail(await api.flowAddExample(camera, nodeId, name, pending.frame, pending.box));
      setTarget(name);
      setCreating(false);
      setPending(null);
      setNewName("");
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  return (
    <div className="flow-work">
      <div className="flow-toolbar">
        <div className="flow-segment" role="group" aria-label="What a drag does">
          <button type="button" aria-pressed={mode === "draw"} onClick={() => setMode("draw")}>Draw example</button>
          <button type="button" aria-pressed={mode === "place"} onClick={() => setMode("place")}>Place box</button>
        </div>
        <div className="flow-chips" role="group" aria-label="Target">
          {detail.targets.map((t, i) => (
            <button key={t.name} type="button" className="flow-chip" aria-pressed={!naming && t.name === chosen} onClick={() => { setTarget(t.name); setCreating(false); setPending(null); }}>
              <span className="flow-dot" style={{ background: COLORS[i % COLORS.length] }} />
              {t.name}
              <small>{t.examples.length} ex.{detail.status === "fresh" ? ` · ${detail.summary.found[t.name] ?? 0} found` : ""}</small>
            </button>
          ))}
          {mode === "draw" && (
            <button type="button" className="flow-chip" aria-pressed={naming} onClick={() => { setCreating(true); setPending(null); }}>
              + New target
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        {naming
          ? "Drag a rectangle around what to find (one hole, say) and include the geometry that tells it from its twin. You name it next."
          : mode === "draw"
            ? `Drag a rectangle around the “${chosen}”. Include the geometry that tells it from its twin.`
            : chosen
              ? `Click where the centre of “${chosen}” is. Your box stays when the detector runs again.`
              : "Draw an example of a target first."}
      </p>
      {pending && naming && (
        <form className="flow-name" onSubmit={(e) => { e.preventDefault(); void saveNew(); }}>
          <label>
            What is this? (the name of the target)
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="left hole" />
          </label>
          <button type="submit" disabled={!newName.trim()}>Save target</button>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
        </form>
      )}

      {frame ? (
        <div className="flow-stage">
          <img src={frameImageUrl(camera, frame)} alt={frame} draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && (
            <svg
              ref={svg}
              viewBox={`0 0 ${size.w} ${size.h}`}
              data-testid="flow-overlay"
              onPointerDown={(e) => { const q = point(e); setDrag({ from: q, to: q }); (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId); }}
              onPointerMove={(e) => drag && setDrag({ from: drag.from, to: point(e) })}
              onPointerUp={(e) => void finish(point(e))}
            >
              {examplesHere.map((e, i) => (
                <rect key={`ex${i}`} x={e.box[0]} y={e.box[1]} width={e.box[2]} height={e.box[3]} fill="none" stroke={COLORS[e.ti % COLORS.length]} strokeDasharray="4 3" />
              ))}
              {names.map((n, i) => {
                const b = found[n];
                if (!b) return null;
                const color = COLORS[i % COLORS.length];
                return (
                  <g key={n} transform={`translate(${b.x} ${b.y}) rotate(${-b.angle})`}>
                    <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} fill="none" stroke={color} strokeWidth={2} />
                    <circle r={2} fill={color} />
                    <text x={-b.w / 2} y={-b.h / 2 - 3} fontSize={12} fill={color}>{n}{b.source === "human" ? " ✎" : ""}</text>
                  </g>
                );
              })}
              {pending && pending.frame === frame && (
                <rect x={pending.box[0]} y={pending.box[1]} width={pending.box[2]} height={pending.box[3]} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="5 3" />
              )}
              {drag && mode === "draw" && (() => { const r = rectOf(drag.from, drag.to); return <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="rgba(255,255,255,.15)" stroke="#fff" />; })()}
            </svg>
          )}
        </div>
      ) : (
        <p className="muted">{onlyReview ? "Nothing to review." : "This camera has no pictures yet."}</p>
      )}

      <div className="flow-nav">
        <button type="button" disabled={at <= 0} onClick={() => setIndex(at - 1)}>‹ Previous</button>
        <button type="button" disabled={at >= shown.length - 1} onClick={() => setIndex(at + 1)}>Next ›</button>
        <span className="muted">{shown.length ? `${at + 1} / ${shown.length} · ${frame}` : ""}</span>
        {missing.length > 0 && detail.status === "fresh" && frame && <span role="status" className="flow-missing">Not found here: {missing.join(", ")}</span>}
        <label className="flow-check flow-nav-right">
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> Only pictures to review ({review.length})
        </label>
      </div>

      <div className="flow-strip" ref={strip} aria-label="Pictures">
        {strip60.map((f) => (
          <button key={f} type="button" aria-label={`Show ${f}`} aria-current={f === frame} title={f} className={`flow-thumb ${statusOf(f)}`} onClick={() => setIndex(shown.indexOf(f))}>
            <img src={frameThumbUrl(camera, f)} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

function ValuesWork(p: {
  camera: string;
  nodeId: string;
  detail: Exclude<FlowNodeDetail, FlowDetector>;
  setDetail: (d: FlowNodeDetail) => void;
  version: number;
  onError: (e: string | null) => void;
}) {
  const { camera, nodeId, detail } = p;
  const [data, setData] = useState<FlowValues | null>(null);
  const [show, setShow] = useState<"all" | "pass" | "fail" | "undetermined">("all");
  const tolerance = detail.kind === "tolerance" ? detail : null;
  const stamp = JSON.stringify(detail);

  useEffect(() => {
    api.flowValues(camera, nodeId).then(setData).catch((e) => p.onError(msg(e)));
  }, [camera, nodeId, stamp, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.values)
      .map(([frame, value]) => ({ frame, value, verdict: data.verdicts?.[frame] }))
      .filter((r) => show === "all" || r.verdict === show)
      .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity) || a.frame.localeCompare(b.frame));
  }, [data, show]);

  const useAsNominal = async (value: number) => {
    try {
      p.setDetail(await api.flowUpdate(camera, nodeId, { nominal: Number(value.toFixed(2)) }));
      p.onError(null);
    } catch (e) { p.onError(msg(e)); }
  };

  if (detail.kind === "calc" && detail.points.length < 2) {
    return <p className="flow-empty">Connect a detector with two named targets to this box on the Chain; its values then appear here.</p>;
  }
  if (tolerance && !tolerance.calc) {
    return <p className="flow-empty">Connect a Calculate box to this box on the Chain; its values then appear here.</p>;
  }
  const unit = data?.unit ?? "";
  return (
    <div className="flow-work">
      {tolerance && <ToleranceHistogram detail={tolerance} onPick={(v) => void useAsNominal(v)} />}
      <div className="flow-nav">
        {tolerance && (
          <label>
            Show{" "}
            <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
              <option value="all">All</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
              <option value="undetermined">Undetermined</option>
            </select>
          </label>
        )}
        <span className="muted">{rows.length} picture{rows.length === 1 ? "" : "s"}, sorted by value</span>
      </div>
      <table className="flow-table">
        <thead>
          <tr><th>Picture</th><th>Value</th>{tolerance && <th>Result</th>}{tolerance && <th />}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.frame}>
              <td><img src={frameThumbUrl(camera, r.frame, 48)} alt="" loading="lazy" /> {r.frame}</td>
              <td>{r.value === null ? "not measured" : `${r.value.toFixed(2)}${unit ? ` ${unit}` : ""}`}</td>
              {tolerance && <td><span className={`flow-verdict ${r.verdict}`}>{r.verdict}</span></td>}
              {tolerance && (
                <td>
                  <button type="button" disabled={r.value === null} onClick={() => r.value !== null && void useAsNominal(r.value)}>Use as nominal</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <p className="muted">Showing the first 200.</p>}
    </div>
  );
}
