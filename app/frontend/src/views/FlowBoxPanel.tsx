import { useEffect, useRef, useState } from "react";
import { api, FlowCalc, FlowCrop, FlowDetector, FlowNodeDetail, FlowEvaluation } from "../api";
import { PanelSection } from "../SidePanel";
import { useJob } from "../useJob";

/** Signed distance from the nominal; an angle wraps around (359 and 1 degrees are 2 degrees apart). */
export function deviation(value: number, nominal: number, wrap: boolean): number {
  const d = value - nominal;
  return wrap ? ((((d + 180) % 360) + 360) % 360) - 180 : d;
}

/**
 * Nominal and tolerance after dragging one handle of the band to `value` (the tolerance never goes below 0). For an
 * angle (`wrap`) the nominal stays in 0-360 and the tolerance is the distance around the clock, at most 180, so a band
 * dragged over 360 -> 0 keeps working (355 +- 10 covers 345-360 and 0-5).
 */
export function dragBand(
  handle: "centre" | "low" | "high", value: number, nominal: number, tolerance: number, wrap = false,
): { nominal: number; tolerance: number } {
  if (handle === "centre") return { nominal: wrap ? ((value % 360) + 360) % 360 : value, tolerance };
  const distance = Math.abs(deviation(value, nominal, wrap));
  return { nominal, tolerance: wrap ? Math.min(180, distance) : Math.max(0, distance) };
}

/**
 * The pieces of the nominal +- tolerance band that fall inside the shown range `view`. An angle band that crosses
 * 360 -> 0 comes as two pieces (345-360 and 0-5 for 355 +- 10). `lowCut` / `highCut` say that the piece is cut by the
 * edge of the chart there (so that edge is not a real edge of the band). `shift` is 0 for the band itself, +-360 for
 * its copy on the other side of the clock.
 */
export function bandPieces(
  band: { nominal: number; tolerance: number }, view: [number, number], wrap: boolean,
): { shift: number; low: number; high: number; lowCut: boolean; highCut: boolean }[] {
  const pieces = [];
  for (const shift of wrap ? [0, -360, 360] : [0]) {
    const lo = band.nominal - band.tolerance + shift;
    const hi = band.nominal + band.tolerance + shift;
    if (hi < view[0] || lo > view[1]) continue;
    pieces.push({ shift, low: Math.max(lo, view[0]), high: Math.min(hi, view[1]), lowCut: lo < view[0], highCut: hi > view[1] });
  }
  return pieces;
}

type Band = { nominal: number; tolerance: number };
type Range = [number, number];

/** How many of `values` fall into each of `bins` equal bins of `[low, high]` (the top edge belongs to the last bin). */
export function rebin(values: number[], [low, high]: Range, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  if (high <= low) return out;
  for (const v of values) {
    if (v < low || v > high) continue;
    out[Math.min(bins - 1, Math.floor(((v - low) / (high - low)) * bins))] += 1;
  }
  return out;
}

const MIN_DRAG_PX = 4;

/**
 * Histogram of the measured values; the bars inside nominal +- tolerance are drawn as passing. Click a bar to take its
 * value as the nominal; drag the middle of the band to move the nominal and either edge to change the tolerance
 * (saved on release through `onBand`). Drag across the rest of the chart to zoom the x axis into that range (the
 * values in it are binned again, so a peak shows its detail; `onRange` tells the page, which narrows its grid too),
 * and right-click to see everything again.
 */
export function EvaluationHistogram({
  detail, onPick, onBand, values, range = null, onRange,
}: {
  detail: FlowEvaluation;
  onPick: (value: number) => void;
  onBand?: (band: Band) => void;
  /** The measured numbers, for binning again inside a zoomed range. */
  values?: number[];
  range?: Range | null;
  onRange?: (range: Range | null) => void;
}) {
  const h = detail.histogram;
  const box = useRef<HTMLDivElement>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Band | null>(null);
  const [sel, setSel] = useState<Range | null>(null);
  if (!h) return <p className="muted">No measured values yet. Run the detectors.</p>;
  const view: Range = range ?? [h.low, h.high];
  const counts = range && values ? rebin(values, view, h.bins.length) : h.bins;
  const width = (view[1] - view[0]) / counts.length;
  const max = Math.max(1, ...counts);
  const band: Band | null = drag ?? (detail.nominal != null ? { nominal: detail.nominal, tolerance: detail.tolerance } : null);
  const valueAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    return Number((view[0] + f * (view[1] - view[0])).toFixed(2));
  };
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - view[0]) / (view[1] - view[0])) * 100))}%`;
  const grab = (handle: "centre" | "low" | "high") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!band || !onBand) return;
    e.preventDefault();
    e.stopPropagation(); // not a zoom
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const start = band;
    let last: Band = start;
    const move = (ev: PointerEvent) => {
      const next = dragBand(handle, valueAt(ev.clientX), start.nominal, start.tolerance, detail.wrap);
      last = { nominal: next.nominal, tolerance: Number(next.tolerance.toFixed(2)) };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (last !== start) onBand(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startZoom = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onRange || e.button !== 0) return;
    swallowClick.current = false;
    const x0 = e.clientX;
    const from = valueAt(x0);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < MIN_DRAG_PX) return;
      moved = true;
      const to = valueAt(ev.clientX);
      setSel([Math.min(from, to), Math.max(from, to)]);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSel(null);
      if (!moved) return;
      swallowClick.current = true; // the bar under the pointer must not also take its value as the nominal
      const to = valueAt(ev.clientX);
      const lo = Math.min(from, to), hi = Math.max(from, to);
      if (hi - lo > (view[1] - view[0]) / 200) onRange([lo, hi]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div>
      <div
        className="flow-histogram"
        role="img"
        aria-label="Histogram of the measured values"
        ref={box}
        onPointerDown={startZoom}
        onContextMenu={(e) => { if (range && onRange) { e.preventDefault(); onRange(null); } }}
        title={onRange ? "Drag across the chart to zoom in; right-click to see everything" : undefined}
      >
        {counts.map((count, i) => {
          const centre = view[0] + (i + 0.5) * width;
          const inside = band != null && Math.abs(deviation(centre, band.nominal, detail.wrap)) <= band.tolerance + width / 2;
          return (
            <button
              key={i}
              type="button"
              className={`flow-bar${inside ? " inside" : ""}`}
              title={`${centre.toFixed(1)} ${detail.unit}: ${count}`}
              aria-label={`Use ${centre.toFixed(1)} as nominal`}
              style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
              onClick={() => {
                if (swallowClick.current) { swallowClick.current = false; return; }
                onPick(Number(centre.toFixed(2)));
              }}
            />
          );
        })}
        {band && onBand && bandPieces(band, view, detail.wrap).map((piece) => {
          const id = piece.shift === 0 ? "" : "-wrap"; // the copy on the other side of the clock has its own test ids
          return (
            <div
              key={piece.shift}
              className="flow-band"
              style={{
                left: pct(piece.low), right: `calc(100% - ${pct(piece.high)})`,
                ...(piece.lowCut ? { borderLeft: "none" } : {}), ...(piece.highCut ? { borderRight: "none" } : {}),
              }}
              data-testid={`tolerance-band${id}`}
            >
              {!piece.lowCut && <div className="flow-band-edge low" data-testid={`band-low${id}`} title="Drag to change the tolerance" onPointerDown={grab("low")} />}
              <div className="flow-band-mid" data-testid={`band-centre${id}`} title="Drag to move the nominal" onPointerDown={grab("centre")} />
              {!piece.highCut && <div className="flow-band-edge high" data-testid={`band-high${id}`} title="Drag to change the tolerance" onPointerDown={grab("high")} />}
            </div>
          );
        })}
        {sel && <div className="flow-zoom-sel" data-testid="zoom-selection" style={{ left: pct(sel[0]), right: `calc(100% - ${pct(sel[1])})` }} />}
      </div>
      <div className="flow-histogram-axis">
        <span>{view[0]}</span>
        <span>{view[1]} {detail.unit}</span>
      </div>
    </div>
  );
}

type Props = {
  camera: string;
  nodeId: string;
  detail: FlowNodeDetail;
  /** The detail as the server now has it (after any change). */
  onDetail: (d: FlowNodeDetail) => void;
  /** Something other pages draw from changed (a box, a setting): reload what depends on it. */
  onChanged: () => void;
};

/** The options of a detector, Calculate or Evaluation box, as sections of the page's right-hand panel (data in `flow.py`). */
export default function FlowBoxPanel({ camera, nodeId, detail, onDetail, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [newTarget, setNewTarget] = useState("");
  const job = useJob(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (job?.status === "done") {
      setJobId(null);
      api.flowNode(camera, nodeId).then(onDetail).catch((e) => setError(String(e instanceof Error ? e.message : e)));
      onChanged();
    }
    if (job?.status === "error") { setError(job.error ?? "The run failed."); setJobId(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  const act = async (fn: () => Promise<FlowNodeDetail>) => {
    try {
      onDetail(await fn());
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const update = (body: Record<string, unknown>) => act(() => api.flowUpdate(camera, nodeId, body));
  const run = async () => {
    try {
      setError(null);
      setJobId((await api.flowRun(camera, nodeId)).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {error && <p role="alert">{error}</p>}
      {detail.kind === "crop" && <CropOptions detail={detail} onUpdate={update} />}
      {detail.kind === "detector" && (
        <DetectorOptions
          detail={detail}
          newTarget={newTarget}
          setNewTarget={setNewTarget}
          running={running}
          progress={job?.progress as { done?: number; total?: number } | undefined}
          onAdd={() => { const name = newTarget.trim(); if (name) { setNewTarget(""); void act(() => api.flowAddTarget(camera, nodeId, name, detail.parent_targets?.[0])); } }}
          onRemoveTarget={(name) => void act(() => api.flowRemoveTarget(camera, nodeId, name))}
          onSetInside={(name, inside) => void act(() => api.flowSetTargetInside(camera, nodeId, name, inside))}
          onRemoveExample={(name, i) => void act(() => api.flowRemoveExample(camera, nodeId, name, i))}
          onUpdate={update}
          onRun={() => void run()}
        />
      )}
      {detail.kind === "calc" && <CalcOptions detail={detail} onUpdate={update} />}
      {detail.kind === "evaluation" && <EvaluationOptions detail={detail} onUpdate={update} />}
    </>
  );
}

function CropOptions({ detail, onUpdate }: { detail: FlowCrop; onUpdate: (body: Record<string, unknown>) => void }) {
  const r = detail.rect;
  return (
    <PanelSection title="Crop">
      <p className="muted">
        One rectangle cuts every picture before it goes on to the next box. It is stored as fractions of the picture, so
        pictures of another size are cut in the same relative place. Nothing is written to disk.
      </p>
      <p>
        {r
          ? `From ${(r[0] * 100).toFixed(1)} %, ${(r[1] * 100).toFixed(1)} % · ${(r[2] * 100).toFixed(1)} % wide, ${(r[3] * 100).toFixed(1)} % tall`
          : "No crop drawn yet: the picture passes on unchanged."}
      </p>
      {detail.crops.length > 0 && <p className="muted">This box reads a picture already cut by {detail.crops.length} Crop box{detail.crops.length === 1 ? "" : "es"} above it.</p>}
      <button type="button" disabled={!r} onClick={() => onUpdate({ rect: null })}>Clear crop</button>
    </PanelSection>
  );
}

function DetectorOptions(p: {
  detail: FlowDetector;
  newTarget: string;
  setNewTarget: (v: string) => void;
  running: boolean;
  progress?: { done?: number; total?: number };
  onAdd: () => void;
  onRemoveTarget: (name: string) => void;
  onSetInside: (name: string, inside: string) => void;
  onRemoveExample: (name: string, index: number) => void;
  onUpdate: (body: Record<string, unknown>) => void;
  onRun: () => void;
}) {
  const d = p.detail;
  const cascade = d.input !== null && d.input !== "ingest";
  const ready = d.targets.some((t) => t.examples.length > 0);
  return (
    <>
      <PanelSection title="Targets">
        <p className="muted">
          {cascade
            ? `Each target here searches inside the box of one target of ${d.input} (chosen below), widened by the search area.`
            : "Drag a rectangle around what to find on the picture, then name it. The name is the identity of the target."}
        </p>
        {d.targets.map((t) => (
          <div key={t.name} className="flow-target">
            <div className="flow-target-head">
              <strong>{t.name}</strong>
              <button type="button" className="danger" onClick={() => p.onRemoveTarget(t.name)} aria-label={`Remove target ${t.name}`}>Remove</button>
            </div>
            {cascade && (
              <label className="flow-inside">
                Searches inside
                <select
                  aria-label={`Searches inside, target ${t.name}`}
                  value={t.inside ?? t.name}
                  onChange={(e) => p.onSetInside(t.name, e.target.value)}
                >
                  {!(d.parent_targets ?? []).includes(t.inside ?? t.name) && <option value={t.inside ?? t.name}>{t.inside ?? t.name} (not a target there)</option>}
                  {(d.parent_targets ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            <div className="flow-examples">
              {t.examples.length === 0 && <span className="muted">No example yet</span>}
              {t.examples.map((e, i) => (
                <button key={i} type="button" className="flow-example" title="Remove this example" aria-label={`Remove example ${i + 1} of ${t.name}`} onClick={() => p.onRemoveExample(t.name, i)}>
                  <img src={e.png} alt={`Example ${i + 1} of ${t.name}`} />
                </button>
              ))}
            </div>
          </div>
        ))}
        <form className="flow-add" onSubmit={(e) => { e.preventDefault(); p.onAdd(); }}>
          <input aria-label="New target name" value={p.newTarget} onChange={(e) => p.setNewTarget(e.target.value)} placeholder="New target, e.g. left hole" />
          <button type="submit" disabled={!p.newTarget.trim()}>Add target</button>
        </form>
      </PanelSection>
      <PanelSection title="Search">
        <label className="flow-check">
          <input type="checkbox" checked={d.rotate} onChange={(e) => p.onUpdate({ rotate: e.target.checked })} /> The part can be turned (search every angle)
        </label>
        {cascade && (
          <label>
            Search area around each input box (× its size)
            <input type="number" min={0} max={2} step={0.1} defaultValue={d.pad} key={d.pad} onBlur={(e) => p.onUpdate({ pad: Number(e.target.value) })} />
          </label>
        )}
        <button type="button" disabled={!ready || p.running} onClick={p.onRun}>
          {p.running ? `Searching… ${p.progress?.done ?? 0}/${p.progress?.total ?? "?"}` : d.status === "fresh" ? "Run again" : "Run"}
        </button>
        <p className="muted" role="status">
          {d.status === "none" && "Not run yet."}
          {d.status === "stale" && "Settings changed since the last run; run again."}
          {d.status === "fresh" && `${d.summary.complete} of ${d.summary.frames} pictures have every target; ${d.summary.review} to review.`}
        </p>
      </PanelSection>
    </>
  );
}

function CalcOptions({ detail, onUpdate }: { detail: FlowCalc; onUpdate: (body: Record<string, unknown>) => void }) {
  if (detail.points.length < 2) {
    return (
      <PanelSection title="Calculate">
        <p className="muted">Draw an arrow from a detector with two named targets into this box (on the Chain).</p>
      </PanelSection>
    );
  }
  return (
    <>
      <PanelSection title="Calculation">
        <label>
          Operation
          <select value={detail.op} onChange={(e) => onUpdate({ op: e.target.value })}>
            {Object.entries(detail.operations).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>
          From point A
          <select value={detail.a ?? ""} onChange={(e) => onUpdate({ a: e.target.value })}>
            {detail.points.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label>
          To point B
          <select value={detail.b ?? ""} onChange={(e) => onUpdate({ b: e.target.value })}>
            {detail.points.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
      </PanelSection>
      {detail.op === "angle" && (
        <PanelSection title="Angle direction">
          <label className="flow-check">
            <input type="radio" name="direction" checked={!detail.clockwise} onChange={() => onUpdate({ clockwise: false })} /> ↺ Counter-clockwise
          </label>
          <label className="flow-check">
            <input type="radio" name="direction" checked={detail.clockwise} onChange={() => onUpdate({ clockwise: true })} /> ↻ Clockwise
          </label>
          <p className="muted">0° points to the right of A. The angle is that of the line from the centre of A to the centre of B, 0–360°.</p>
        </PanelSection>
      )}
    </>
  );
}

function EvaluationOptions({ detail, onUpdate }: { detail: FlowEvaluation; onUpdate: (body: Record<string, unknown>) => void }) {
  if (!detail.calc) {
    return (
      <PanelSection title="Evaluation">
        <p className="muted">Draw an arrow from a Calculate box into this box (on the Chain).</p>
      </PanelSection>
    );
  }
  return (
    <>
      <PanelSection title="Nominal and tolerance">
        <label>
          Nominal {detail.unit && `(${detail.unit})`}
          <input
            type="number"
            step="any"
            key={`n${detail.nominal}`}
            defaultValue={detail.nominal ?? ""}
            onBlur={(e) => onUpdate({ nominal: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
        <label>
          ± Tolerance
          <input type="number" step="any" min={0} key={`t${detail.tolerance}`} defaultValue={detail.tolerance} onBlur={(e) => onUpdate({ tolerance: Number(e.target.value) })} />
        </label>
        <p className="muted">Type it, click a bar of the histogram, drag the band on it (middle = nominal, edges = tolerance), or use “Use as nominal” on a picture in the list.{detail.wrap ? " 359° and 1° are 2° apart." : ""}</p>
      </PanelSection>
      <PanelSection title="Result">
        <p role="status">
          <strong>{detail.counts.pass}</strong> pass · <strong>{detail.counts.fail}</strong> fail · <strong>{detail.counts.undetermined}</strong> undetermined
        </p>
        {detail.features.length === 0 ? (
          <p className="muted">Draw an arrow from this box to a feature’s Classify box (on the Chain) to see the result there.</p>
        ) : (
          <p className="muted">Shown in Classify of {detail.features.join(", ")} (Show → Measurement).</p>
        )}
      </PanelSection>
    </>
  );
}
