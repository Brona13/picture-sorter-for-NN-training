import { useEffect, useMemo, useRef, useState } from "react";
import { api, SimilarResult } from "../api";
import { useJob } from "../useJob";
import { thumbUrl } from "./Card";
import { classColor } from "./colors";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LIMITS = [30, 60, 120, 250];

/**
 * "Find similar": the unlabeled frames closest to a labeled seed in embedding space, nearest first.
 * The distance slider ticks everything up to that distance; pictures can still be ticked or
 * unticked one by one. Only a click on the label button writes anything, and only the seed's own
 * label is applied. Goldens are never created here.
 */
export default function SimilarPanel({
  camera,
  feature,
  seed,
  methods,
  classes,
  onLabeled,
  onClose,
  onError,
}: {
  camera: string;
  feature: string;
  seed: { frame: string; label: string };
  /** Embedding methods that can be searched (the ResNet backbones). */
  methods: string[];
  classes: string[];
  onLabeled: (labeled: number, skipped: number, cls: string, counts: Record<string, number>) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [method, setMethod] = useState(methods.includes("resnet50") ? "resnet50" : methods[0] ?? "");
  const [limit, setLimit] = useState(60);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<SimilarResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState(0);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLElement>(null);
  const job = useJob<SimilarResult>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  useEffect(() => {
    root.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [seed.frame]);

  // A new seed starts over.
  useEffect(() => {
    setJobId(null);
    setResult(null);
    setPicked(new Set());
  }, [seed.frame, feature, camera]);

  useEffect(() => {
    if (job?.status === "done" && job.result) {
      setResult(job.result);
      setPicked(new Set());
      setThreshold(0);
    } else if (job?.status === "error") onError(job.error ?? "Find similar failed.");
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const near = result?.neighbors ?? [];
  const maxDist = near.length ? near[near.length - 1].distance : 0;
  const progress = job?.progress ?? {};
  const label = seed.label;
  const canLabel = classes.includes(label);

  const ticked = useMemo(() => near.filter((n) => picked.has(n.frame)).map((n) => n.frame), [near, picked]);

  function tickUpTo(t: number) {
    setThreshold(t);
    setPicked(new Set(near.filter((n) => n.distance <= t).map((n) => n.frame)));
  }

  function toggle(frame: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(frame)) next.add(frame);
      return next;
    });
  }

  async function apply() {
    if (ticked.length === 0) return;
    setSaving(true);
    try {
      const r = await api.classifyLabelFrames(camera, feature, ticked, label);
      onLabeled(r.labeled, r.skipped.length, label, r.counts);
      const done = new Set(ticked.filter((f) => !r.skipped.includes(f)));
      setResult((cur) => (cur ? { ...cur, neighbors: cur.neighbors.filter((n) => !done.has(n.frame)) } : cur));
      setPicked(new Set());
    } catch (e) {
      onError(msg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section ref={root} aria-label="Find similar" data-testid="similar-panel" style={{ border: "1px solid #bbb", borderRadius: 6, padding: 8, margin: "8px 0" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <img src={thumbUrl(camera, seed.frame, feature)} alt={`Seed ${seed.frame}`} width={64} style={{ borderRadius: 4 }} />
        <div>
          <strong>Find similar to {seed.frame.slice(0, 22)}</strong>{" "}
          <span style={{ background: classColor(label, classes), color: "#fff", padding: "1px 6px", borderRadius: 3 }}>{label}</span>
          <br />
          <small>Shows unlabeled frames only. You tick the ones that really look the same; only then are they labeled {label}.</small>
        </div>
        <label>
          Embedding{" "}
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Show up to{" "}
          <select aria-label="Show up to" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>{" "}
          frames
        </label>
        <button
          disabled={running || !method}
          onClick={() =>
            api
              .classifySimilar(camera, feature, seed.frame, method, limit)
              .then((j) => setJobId(j.id))
              .catch((e: unknown) => onError(msg(e)))
          }
        >
          Find similar
        </button>
        <button onClick={onClose} style={{ marginLeft: "auto" }}>
          Close
        </button>
      </div>
      {running && (
        <p aria-live="polite">
          <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Embedding {Number(progress.done ?? 0)}/{Number(progress.total ?? 0)}
        </p>
      )}
      {result && near.length === 0 && <p role="status">No unlabeled frames left to compare.</p>}
      {result && near.length > 0 && (
        <>
          <p style={{ margin: "8px 0 4px" }}>
            <label>
              Tick everything within distance{" "}
              <input
                type="range"
                aria-label="Distance"
                min={0}
                max={maxDist}
                step={Math.max(maxDist / 200, 1e-6)}
                value={threshold}
                onChange={(e) => tickUpTo(Number(e.target.value))}
              />{" "}
              {threshold.toFixed(3)}
            </label>{" "}
            <button onClick={() => tickUpTo(maxDist)}>Tick all</button> <button onClick={() => (setPicked(new Set()), setThreshold(0))}>Tick none</button>
          </p>
          <p style={{ margin: "0 0 4px", fontSize: 12 }}>
            Cosine distance to the seed: 0 = same direction, larger = less alike. It is a hint, so look at the pictures before labeling.
          </p>
          <ul style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, padding: 0, listStyle: "none" }}>
            {near.map((n) => (
              <li key={n.frame} style={{ border: picked.has(n.frame) ? `2px solid ${classColor(label, classes)}` : "2px solid transparent", borderRadius: 4, padding: 2 }}>
                <label style={{ display: "block", cursor: "pointer" }}>
                  <img src={thumbUrl(camera, n.frame, feature)} alt={n.frame} style={{ width: "100%", display: "block" }} />
                  <input type="checkbox" aria-label={`Tick ${n.frame}`} checked={picked.has(n.frame)} onChange={() => toggle(n.frame)} />{" "}
                  <small>
                    {n.frame.slice(0, 14)} · {n.distance.toFixed(3)}
                  </small>
                </label>
              </li>
            ))}
          </ul>
          <button disabled={saving || ticked.length === 0 || !canLabel} onClick={apply}>
            Label {ticked.length} ticked as {label}
          </button>
        </>
      )}
    </section>
  );
}
