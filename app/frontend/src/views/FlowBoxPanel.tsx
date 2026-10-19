import { useEffect, useState } from "react";
import { api, FlowCalc, FlowDetector, FlowNodeDetail, FlowTolerance } from "../api";
import { PanelSection } from "../SidePanel";
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
    <div>
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
      <div className="flow-histogram-axis">
        <span>{h.low}</span>
        <span>{h.high} {detail.unit}</span>
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

/** The options of a detector, Calculate or Tolerance box, as sections of the page's right-hand panel (data in `flow.py`). */
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
      {detail.kind === "detector" && (
        <DetectorOptions
          detail={detail}
          newTarget={newTarget}
          setNewTarget={setNewTarget}
          running={running}
          progress={job?.progress as { done?: number; total?: number } | undefined}
          onAdd={() => { const name = newTarget.trim(); if (name) { setNewTarget(""); void act(() => api.flowAddTarget(camera, nodeId, name)); } }}
          onRemoveTarget={(name) => void act(() => api.flowRemoveTarget(camera, nodeId, name))}
          onRemoveExample={(name, i) => void act(() => api.flowRemoveExample(camera, nodeId, name, i))}
          onUpdate={update}
          onRun={() => void run()}
        />
      )}
      {detail.kind === "calc" && <CalcOptions detail={detail} onUpdate={update} />}
      {detail.kind === "tolerance" && <ToleranceOptions detail={detail} onUpdate={update} />}
    </>
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
            ? `Searches inside the boxes of ${d.input}: target “A” here looks inside the box named “A” there.`
            : "Name what to find and draw an example of it on a picture. The name is the identity of the target."}
        </p>
        {d.targets.map((t) => (
          <div key={t.name} className="flow-target">
            <div className="flow-target-head">
              <strong>{t.name}</strong>
              <button type="button" className="danger" onClick={() => p.onRemoveTarget(t.name)} aria-label={`Remove target ${t.name}`}>Remove</button>
            </div>
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

function ToleranceOptions({ detail, onUpdate }: { detail: FlowTolerance; onUpdate: (body: Record<string, unknown>) => void }) {
  if (!detail.calc) {
    return (
      <PanelSection title="Tolerance">
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
        <p className="muted">Type it, click a bar of the histogram, or use “Use as nominal” on a picture in the list.{detail.wrap ? " 359° and 1° are 2° apart." : ""}</p>
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
