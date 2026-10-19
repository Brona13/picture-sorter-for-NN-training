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

export type Rect = [number, number, number, number];
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The rectangle after dragging one of its handles by (dx, dy) picture pixels; it never gets smaller than `min`. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, min = 5): Rect {
  let [x0, y0, x1, y1] = [r[0], r[1], r[0] + r[2], r[1] + r[3]];
  if (handle.includes("w")) x0 = Math.min(x0 + dx, x1 - min);
  if (handle.includes("e")) x1 = Math.max(x1 + dx, x0 + min);
  if (handle.includes("n")) y0 = Math.min(y0 + dy, y1 - min);
  if (handle.includes("s")) y1 = Math.max(y1 + dy, y0 + min);
  return [x0, y0, x1 - x0, y1 - y0];
}

const handlePoint = (r: Rect, h: Handle) => ({
  x: h.includes("w") ? r[0] : h.includes("e") ? r[0] + r[2] : r[0] + r[2] / 2,
  y: h.includes("n") ? r[1] : h.includes("s") ? r[1] + r[3] : r[1] + r[3] / 2,
});

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
  const [sel, setSel] = useState<{ name: string; index: number } | null>(null);
  const [edit, setEdit] = useState<{ kind: "move" | Handle; start: { x: number; y: number }; orig: Rect; cur: Rect } | null>(null);
  const [pending, setPending] = useState<{ frame: string; box: [number, number, number, number] } | null>(null);
  const [newName, setNewName] = useState("");
  const [boxes, setBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [parentBoxes, setParentBoxes] = useState<Record<string, Record<string, FlowBox>>>({});
  const [parentNames, setParentNames] = useState<string[]>([]);
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

  // A cascade (its input is another detector) works on the boxes that detector found: one picture per found box.
  const parentId = detail.input && detail.input !== "ingest" ? detail.input : null;
  useEffect(() => {
    if (!parentId) { setParentBoxes({}); setParentNames([]); return; }
    api.flowBoxes(camera, parentId).then((b) => setParentBoxes(b.boxes)).catch((e) => p.onError(msg(e)));
    api.flowNode(camera, parentId).then((d) => setParentNames(d.kind === "detector" ? d.targets.filter((t) => t.examples.length > 0).map((t) => t.name) : [])).catch(() => setParentNames([]));
  }, [camera, parentId, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = detail.targets.map((t) => t.name);
  const chipNames = parentId ? parentNames : names;
  const chosen = chipNames.includes(target) ? target : chipNames[0] ?? "";
  // With no target yet (or "+ New target" picked) a drag starts a new target: the rectangle first, its name next.
  const naming = !parentId && mode === "draw" && (names.length === 0 || creating);
  const candidates = useMemo(() => (parentId ? frames.filter((f) => parentBoxes[f]?.[chosen]) : frames), [frames, parentId, parentBoxes, chosen]);
  const shown = useMemo(() => (onlyReview ? candidates.filter((f) => review.includes(f)) : candidates), [candidates, review, onlyReview]);
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
  const examplesHere = detail.targets.flatMap((t, ti) =>
    t.examples.flatMap((e, index) => (e.frame === frame ? [{ name: t.name, ti, index, box: e.box as Rect }] : [])),
  );
  const statusOf = (f: string) => (detail.status === "none" ? "" : review.includes(f) ? "review" : f in boxes ? "ok" : "");

  // The part of the picture on show: all of it, or (cascade) the padded box the input detector found for this target.
  const view = useMemo(() => {
    if (!size) return null;
    const b = parentId && frame ? parentBoxes[frame]?.[chosen] : undefined;
    if (!b) return { x: 0, y: 0, w: size.w, h: size.h, crop: false };
    const t = (b.angle * Math.PI) / 180;
    const hw = (Math.abs(b.w * Math.cos(t)) + Math.abs(b.h * Math.sin(t))) / 2;
    const hh = (Math.abs(b.w * Math.sin(t)) + Math.abs(b.h * Math.cos(t))) / 2;
    const x0 = Math.max(0, Math.floor(b.x - hw * (1 + 2 * detail.pad)));
    const y0 = Math.max(0, Math.floor(b.y - hh * (1 + 2 * detail.pad)));
    const x1 = Math.min(size.w, Math.ceil(b.x + hw * (1 + 2 * detail.pad)));
    const y1 = Math.min(size.h, Math.ceil(b.y + hh * (1 + 2 * detail.pad)));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), crop: true };
  }, [size, parentId, frame, parentBoxes, chosen, detail.pad]);

  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const v = view!;
    return { x: v.x + ((e.clientX - r.left) / r.width) * v.w, y: v.y + ((e.clientY - r.top) / r.height) * v.h };
  };

  useEffect(() => { setSel(null); setEdit(null); }, [frame, mode]);
  const selected = sel ? examplesHere.find((e) => e.name === sel.name && e.index === sel.index) : undefined;
  const handleSize = view ? view.w / 70 : 4;
  const boxOf = (e: { name: string; index: number; box: Rect }): Rect => (edit && sel && sel.name === e.name && sel.index === e.index ? edit.cur : e.box);

  // What a press at q hits in draw mode: a handle of the selected example, else the inside of an example.
  const hitExample = (q: { x: number; y: number }) => {
    if (selected) {
      const r = selected.box;
      for (const h of HANDLES) {
        const c = handlePoint(r, h);
        if (Math.abs(q.x - c.x) <= handleSize && Math.abs(q.y - c.y) <= handleSize) return { e: selected, kind: h as "move" | Handle };
      }
    }
    for (const e of [...examplesHere].reverse()) {
      if (q.x >= e.box[0] && q.x <= e.box[0] + e.box[2] && q.y >= e.box[1] && q.y <= e.box[1] + e.box[3]) return { e, kind: "move" as "move" | Handle };
    }
    return null;
  };

  const commitEdit = async () => {
    if (!edit || !sel) return;
    const done = edit;
    setEdit(null);
    const [x, y, w, h] = done.cur;
    const changed = done.cur.some((v, i) => Math.round(v) !== Math.round(done.orig[i]));
    if (!changed || !size) return;
    const box = [Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.round(w), Math.round(h)];
    try {
      p.setDetail(await api.flowUpdateExample(camera, nodeId, sel.name, sel.index, box));
      p.onError(null);
      p.onChanged();
    } catch (e) { p.onError(msg(e)); }
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const q = point(e);
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
    const hit = mode === "draw" ? hitExample(q) : null;
    if (hit) {
      setSel({ name: hit.e.name, index: hit.e.index });
      setEdit({ kind: hit.kind, start: q, orig: hit.e.box, cur: hit.e.box });
      return;
    }
    setSel(null);
    setDrag({ from: q, to: q });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (edit) {
      const q = point(e);
      const [dx, dy] = [q.x - edit.start.x, q.y - edit.start.y];
      const [ox, oy, ow, oh] = edit.orig;
      const cur: Rect = edit.kind === "move"
        ? [Math.min(Math.max(0, ox + dx), (size?.w ?? Infinity) - ow), Math.min(Math.max(0, oy + dy), (size?.h ?? Infinity) - oh), ow, oh]
        : resizeRect(edit.orig, edit.kind, dx, dy);
      setEdit({ ...edit, cur });
    } else if (drag) {
      setDrag({ from: drag.from, to: point(e) });
    }
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (edit) void commitEdit();
    else void finish(point(e));
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
        if (parentId && !names.includes(chosen)) await api.flowAddTarget(camera, nodeId, chosen);
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
          {chipNames.map((name, i) => {
            const t = detail.targets.find((x) => x.name === name);
            return (
              <button key={name} type="button" className="flow-chip" aria-pressed={!naming && name === chosen} onClick={() => { setTarget(name); setCreating(false); setPending(null); }}>
                <span className="flow-dot" style={{ background: COLORS[i % COLORS.length] }} />
                {name}
                <small>{t?.examples.length ?? 0} ex.{detail.status === "fresh" ? ` · ${detail.summary.found[name] ?? 0} found` : ""}</small>
              </button>
            );
          })}
          {mode === "draw" && !parentId && (
            <button type="button" className="flow-chip" aria-pressed={naming} onClick={() => { setCreating(true); setPending(null); }}>
              + New target
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        {parentId && chipNames.length === 0
          ? "Run the detector before this one first (and give it a target): the pictures here are the boxes it finds."
          : parentId && candidates.length === 0
            ? `The detector before this one has no box named “${chosen}” on any picture yet. Run it first.`
            : parentId && mode === "draw"
              ? `Each picture is the “${chosen}” box found by ${parentId}, with its surroundings. Drag a rectangle around the hole (or whatever this detector looks for) in it. Click an example rectangle to move or resize it.`
              : naming
          ? "Drag a rectangle around what to find (one hole, say) and include the geometry that tells it from its twin. You name it next."
          : mode === "draw"
            ? `Drag a rectangle around the “${chosen}”. Include the geometry that tells it from its twin. Click a rectangle to move or resize it; run again afterwards.`
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
        <div className={`flow-stage${view?.crop ? " crop" : ""}`}>
          <img
            src={frameImageUrl(camera, frame)}
            alt={frame}
            draggable={false}
            style={view?.crop ? { display: "none" } : undefined}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {size && view && (
            <svg
              ref={svg}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              style={view.crop ? { aspectRatio: `${view.w} / ${view.h}` } : undefined}
              data-testid="flow-overlay"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              {view.crop && <image href={frameImageUrl(camera, frame)} x={0} y={0} width={size.w} height={size.h} />}
              {examplesHere.map((e) => {
                const b = boxOf(e);
                const active = sel?.name === e.name && sel.index === e.index;
                return (
                  <g key={`ex${e.name}${e.index}`}>
                    <rect x={b[0]} y={b[1]} width={b[2]} height={b[3]} fill={active ? "rgba(255,255,255,.08)" : "none"} stroke={COLORS[e.ti % COLORS.length]} strokeWidth={active ? 2 : 1} strokeDasharray={active ? undefined : "4 3"} vectorEffect="non-scaling-stroke" data-testid="example-rect" />
                    {active && HANDLES.map((h) => {
                      const c = handlePoint(b, h);
                      return <rect key={h} data-testid={`handle-${h}`} x={c.x - handleSize / 2} y={c.y - handleSize / 2} width={handleSize} height={handleSize} fill="#fff" stroke={COLORS[e.ti % COLORS.length]} vectorEffect="non-scaling-stroke" />;
                    })}
                  </g>
                );
              })}
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
