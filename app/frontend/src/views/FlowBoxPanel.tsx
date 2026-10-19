import { useCallback, useEffect, useState } from "react";
import { api, ChainNode, FlowCalc, FlowDetector, FlowNodeDetail, FlowTolerance } from "../api";
import { useJob } from "../useJob";

/** Signed distance from the nominal; an angle wraps around (359 and 1 degrees are 2 degrees apart). */
export function deviation(value: number, nominal: number, wrap: boolean): number {
  const d = value - nominal;
  return wrap ? ((((d + 180) % 360) + 360) % 360) - 180 : d;
}

/** Histogram of the measured values; the bars inside nominal +- tolerance are drawn as passing. Click a bar to take its value as the nominal. */
export function ToleranceHistogram({ detail, onPick }: { detail: FlowTolerance; onPick: (value: number) => void }) {
  const h = detail.histogram;
  if (!h) return <p className="muted">No measured values yet. Run the detectors.</p>;
  const width = (h.high - h.low) / h.bins.length;
  const max = Math.max(1, ...h.bins);
  return (
    <div className="flow-histogram" role="img" aria-label="Histogram of the measured values">
      {h.bins.map((count, i) => {
        const centre = h.low + (i + 0.5) * width;
        const inside = detail.nominal != null && Math.abs(deviation(centre, detail.nominal, detail.wrap)) <= detail.tolerance + width / 2;
        return (
          <button
            key={i}
            type="button"
            className={`flow-bar${inside ? " inside" : ""}`}
            title={`${centre.toFixed(1)} ${detail.unit}: ${count}`}
            aria-label={`Use ${centre.toFixed(1)} as nominal`}
            style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
            onClick={() => onPick(Number(centre.toFixed(2)))}
          />
        );
      })}
    </div>
  );
}

type Props = {
  camera: string;
  node: ChainNode;
  onChanged: () => void;
  onOpenPage: (nodeId: string, target?: string) => void;
};

/** Settings of the selected detector, Calculate or Tolerance box (the data lives in `flow.py`). */
export default function FlowBoxPanel({ camera, node, onChanged, onOpenPage }: Props) {
  const [detail, setDetail] = useState<FlowNodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [newTarget, setNewTarget] = useState("");
  const job = useJob(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  const load = useCallback(() => {
    api.flowNode(camera, node.id).then(setDetail).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [camera, node.id]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setJobId(null);
    load();
  }, [load]);

  useEffect(() => {
    if (job?.status === "done") { setJobId(null); load(); onChanged(); }
    if (job?.status === "error") { setError(job.error ?? "The run failed."); setJobId(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  const act = async (fn: () => Promise<FlowNodeDetail>) => {
    try {
      setDetail(await fn());
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const update = (body: Record<string, unknown>) => act(() => api.flowUpdate(camera, node.id, body));
  const run = async () => {
    try {
      setError(null);
      setJobId((await api.flowRun(camera, node.id)).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!detail) return <p className="muted">{error ?? "Loading…"}</p>;
  return (
    <div className="flow-panel">
      {error && <p role="alert">{error}</p>}
      {detail.kind === "detector" && (
        <DetectorSettings
          detail={detail}
          newTarget={newTarget}
          setNewTarget={setNewTarget}
          running={running}
          progress={job?.progress as { done?: number; total?: number } | undefined}
          onAdd={() => { const name = newTarget.trim(); if (name) { setNewTarget(""); void act(() => api.flowAddTarget(camera, node.id, name)); } }}
          onRemoveTarget={(name) => void act(() => api.flowRemoveTarget(camera, node.id, name))}
          onRemoveExample={(name, i) => void act(() => api.flowRemoveExample(camera, node.id, name, i))}
          onUpdate={update}
          onRun={() => void run()}
          onOpenPage={(target) => onOpenPage(node.id, target)}
        />
      )}
      {detail.kind === "calc" && <CalcSettings detail={detail} onUpdate={update} />}
      {detail.kind === "tolerance" && <ToleranceSettings detail={detail} onUpdate={update} />}
    </div>
  );
}

function DetectorSettings(p: {
  detail: FlowDetector;
  newTarget: string;
  setNewTarget: (v: string) => void;
  running: boolean;
  progress?: { done?: number; total?: number };
  onAdd: () => void;
  onRemoveTarget: (name: string) => void;
  onRemoveExample: (name: string, index: number) => void;
  onUpdate: (body: Record<string, unknown>) => void;
  onRun: () => void;
  onOpenPage: (target?: string) => void;
}) {
  const d = p.detail;
  const cascade = d.input !== null && d.input !== "ingest";
  const ready = d.targets.some((t) => t.examples.length > 0);
  return (
    <>
      <p className="muted">
        {cascade
          ? `Searches inside the boxes of ${d.input}: target “A” here looks inside the box named “A” there.`
          : "Searches the whole picture for each target. Draw an example of what to find; the identity of a target comes from its name."}
      </p>
      <h4>Targets</h4>
      {d.targets.length === 0 && <p className="muted">No target yet. Name the first one (for example “left hole”).</p>}
      {d.targets.map((t) => (
        <div key={t.name} className="flow-target">
          <strong>{t.name}</strong>
          <div className="flow-examples">
            {t.examples.map((e, i) => (
              <button key={i} type="button" className="flow-example" title="Remove this example" aria-label={`Remove example ${i + 1} of ${t.name}`} onClick={() => p.onRemoveExample(t.name, i)}>
                <img src={e.png} alt={`Example ${i + 1} of ${t.name}`} />
              </button>
            ))}
          </div>
          <button type="button" onClick={() => p.onOpenPage(t.name)}>Draw example…</button>{" "}
          <button type="button" className="danger" onClick={() => p.onRemoveTarget(t.name)}>Remove</button>
        </div>
      ))}
      <form className="chain-form" onSubmit={(e) => { e.preventDefault(); p.onAdd(); }}>
        <label>
          New target name
          <input value={p.newTarget} onChange={(e) => p.setNewTarget(e.target.value)} placeholder="left hole" />
        </label>
        <button type="submit" disabled={!p.newTarget.trim()}>Add target</button>
      </form>
      <label>
        <input type="checkbox" checked={d.rotate} onChange={(e) => p.onUpdate({ rotate: e.target.checked })} /> The part can be turned (search every angle)
      </label>
      {cascade && (
        <label>
          Search area around each input box (× its size)
          <input type="number" min={0} max={2} step={0.1} defaultValue={d.pad} key={d.pad} onBlur={(e) => p.onUpdate({ pad: Number(e.target.value) })} />
        </label>
      )}
      <div className="flow-actions">
        <button type="button" disabled={!ready || p.running} onClick={p.onRun}>
          {p.running ? `Searching… ${p.progress?.done ?? 0}/${p.progress?.total ?? "?"}` : d.status === "fresh" ? "Run again" : "Run"}
        </button>
        <button type="button" disabled={!ready} onClick={() => p.onOpenPage()}>Open page (review)</button>
      </div>
      <p className="muted" role="status">
        {d.status === "none" && "Not run yet."}
        {d.status === "stale" && "Settings changed since the last run; run again."}
        {d.status === "fresh" && `${d.summary.complete} of ${d.summary.frames} pictures have every target; ${d.summary.review} to review.`}
      </p>
    </>
  );
}

function CalcSettings({ detail, onUpdate }: { detail: FlowCalc; onUpdate: (body: Record<string, unknown>) => void }) {
  if (detail.points.length < 2) {
    return <p className="muted">Draw an arrow from a detector with two named targets into this box.</p>;
  }
  return (
    <>
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
      {detail.op === "angle" && (
        <fieldset className="flow-direction">
          <legend>Positive direction</legend>
          <label>
            <input type="radio" name="direction" checked={!detail.clockwise} onChange={() => onUpdate({ clockwise: false })} /> ↺ Counter-clockwise
          </label>
          <label>
            <input type="radio" name="direction" checked={detail.clockwise} onChange={() => onUpdate({ clockwise: true })} /> ↻ Clockwise
          </label>
          <p className="muted">0° points to the right of A; the angle is that of the line from the centre of A to the centre of B, 0–360°.</p>
        </fieldset>
      )}
      <p className="muted" role="status">{detail.measured} picture{detail.measured === 1 ? "" : "s"} measured.</p>
    </>
  );
}

function ToleranceSettings({ detail, onUpdate }: { detail: FlowTolerance; onUpdate: (body: Record<string, unknown>) => void }) {
  if (!detail.calc) return <p className="muted">Draw an arrow from a Calculate box into this box.</p>;
  return (
    <>
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
      <p className="muted">Click a bar to take its value as the nominal{detail.wrap ? "; 359° and 1° are 2° apart" : ""}.</p>
      <ToleranceHistogram detail={detail} onPick={(value) => onUpdate({ nominal: value })} />
      <p role="status">
        <strong>{detail.counts.pass}</strong> pass · <strong>{detail.counts.fail}</strong> fail · <strong>{detail.counts.undetermined}</strong> undetermined
      </p>
      {detail.features.length === 0 ? (
        <p className="muted">Draw an arrow from this box to a feature’s Classify box to see the result there.</p>
      ) : (
        <p className="muted">Shown in Classify of {detail.features.join(", ")} (Show → Measurement).</p>
      )}
    </>
  );
}
