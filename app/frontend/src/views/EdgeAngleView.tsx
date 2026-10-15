import { useCallback, useEffect, useRef, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, EdgeAngleSettings, EdgeAngleState, EdgeExpected, EdgePreview } from "../api";
import LineCanvas from "../LineCanvas";
import { DEFAULT_HALF_WIDTH, Line } from "../lineGeometry";
import { useJob } from "../useJob";
import { usePreview } from "../usePreview";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PREVIEW_DEBOUNCE_MS = 200;
const round = (v: number) => Math.round(v * 10000) / 10000;

interface Draft {
  line: Line | null;
  halfWidth: number;
  points: number;
  expected: EdgeExpected | null;
}

const EMPTY: Draft = { line: null, halfWidth: DEFAULT_HALF_WIDTH, points: 10, expected: null };

function toSettings(d: Draft): EdgeAngleSettings | null {
  if (!d.line) return null;
  return {
    p1: { x: round(d.line.p1.x), y: round(d.line.p1.y) },
    p2: { x: round(d.line.p2.x), y: round(d.line.p2.y) },
    half_width: round(d.halfWidth),
    points: d.points,
    expected: d.expected && { angle: round(d.expected.angle), tolerance: round(d.expected.tolerance), polarity: d.expected.polarity },
  };
}

function fromSettings(s: EdgeAngleSettings | null, defaults: Draft = EMPTY): Draft {
  return s ? { line: { p1: s.p1, p2: s.p2 }, halfWidth: s.half_width, points: s.points, expected: s.expected } : defaults;
}

const VERDICT_COLOUR = { pass: "#1a7f37", fail: "#c62828", undetermined: "#777" } as const;

/**
 * Rule-based tool: draw a line along an edge, size the band around it, and check the measured angle
 * and direction against what an OK frame looks like. Direction comes from which side is brighter, not
 * from the order the points were clicked. The result is its own opinion (Classify shows it as a badge
 * and a filter) and is never blended with the embedding scores.
 */
export default function EdgeAngleView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [saved, setSaved] = useState<EdgeAngleState | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [preview, setPreview] = useState<EdgePreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<{ total: number; pass: number; fail: number; undetermined: number; measured: number }>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");
  const seq = useRef(0);
  const cropUrl = usePreview(camera, feature, frame, null, null, setError);

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(shared.pick(f));
      })
      .catch((e: unknown) => setError(msg(e)));
    api
      .frames(camera, product)
      .then((r) => {
        setFrames(r.frames);
        setFrame(r.reference_frame ?? r.frames[0] ?? "");
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  const load = useCallback(async () => {
    if (!camera || !feature) return;
    try {
      const st = await api.edgeAngleState(camera, feature);
      setSaved(st);
      setDraft(fromSettings(st.settings, { ...EMPTY, halfWidth: st.defaults.half_width, points: st.defaults.points }));
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature]);

  useEffect(() => {
    setSaved(null);
    setPreview(null);
    setJobId(null);
    setNotice(null);
    load();
  }, [load]);

  const settings = toSettings(draft);
  const settingsKey = JSON.stringify(settings);
  const dirty = settingsKey !== JSON.stringify(saved?.settings ?? null);

  // Live measurement of the chosen frame with the unsaved settings.
  useEffect(() => {
    if (!camera || !feature || !frame || !settings) {
      setPreview(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api
        .edgeAnglePreview(camera, feature, frame, settings)
        .then((p) => {
          if (mine === seq.current) setPreview(p);
        })
        .catch((e: unknown) => mine === seq.current && setError(msg(e)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, feature, frame, settingsKey]);

  useEffect(() => {
    if (job?.status === "done") {
      setNotice("Measured every frame. See Classify → Show: Edge angle.");
      load();
    } else if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(): Promise<boolean> {
    try {
      const st = await api.edgeAngleSave(camera, feature, settings);
      setSaved(st);
      setError(null);
      return true;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  }

  async function saveAndRun() {
    setNotice(null);
    if (dirty && !(await save())) return;
    try {
      setJobId((await api.edgeAngleRun(camera, feature)).id);
    } catch (e) {
      setError(msg(e));
    }
  }

  const m = preview?.measurement;
  const ranges = saved?.ranges;
  const idx = frames.indexOf(frame);
  const step = (d: number) => frames[Math.min(frames.length - 1, Math.max(0, idx + d))] && setFrame(frames[Math.min(frames.length - 1, Math.max(0, idx + d))]);
  const progress = job?.progress ?? {};
  const overlay = m && m.status === "ok" ? { points: m.points, fitted: m.line } : null;
  const setExpected = (patch: Partial<EdgeExpected>) =>
    setDraft((d) => (d.expected ? { ...d, expected: { ...d.expected, ...patch } } : d));

  if (!camera) return <p>Select a camera.</p>;

  return (
    <section>
      <h2>
        Edge angle — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p style={{ fontSize: 13 }}>
        A rule-based check: only the angle and direction you set count as OK. Draw a line along the edge, size the band, and look at the live
        measurement on the right. Direction comes from which side of the edge is brighter, not from the order of your clicks.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Feature (ROI){" "}
          <select value={feature} onChange={(e) => setFeature(e.target.value)}>
            {features.map((f) => (
              <option key={f.feature} value={f.feature}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Frame{" "}
          <select value={frame} onChange={(e) => setFrame(e.target.value)}>
            {frames.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <button onClick={() => step(-1)} disabled={idx <= 0} aria-label="Previous frame">
          ‹
        </button>
        <button onClick={() => step(1)} disabled={idx < 0 || idx >= frames.length - 1} aria-label="Next frame">
          ›
        </button>
      </div>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", marginTop: 8 }}>
        <div style={{ flex: "1 1 460px", minWidth: 0 }}>
          {cropUrl ? (
            <LineCanvas
              imageUrl={cropUrl}
              line={draft.line}
              halfWidth={draft.halfWidth}
              overlay={overlay}
              onChange={(line, halfWidth) => setDraft((d) => ({ ...d, line, halfWidth }))}
            />
          ) : (
            <p>Loading the crop…</p>
          )}
        </div>

        <aside style={{ flex: "1 1 320px", minWidth: 280 }}>
          <h3 style={{ marginTop: 0 }}>Band preview</h3>
          {preview?.patch ? (
            <div style={{ position: "relative", lineHeight: 0, border: "1px solid #ccc" }} data-testid="band-preview">
              <img src={preview.patch} alt="Straightened band" style={{ width: "100%", display: "block", imageRendering: "pixelated" }} />
              {m && m.status === "ok" && (
                <>
                  <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                    <line
                      x1={m.patch_line[0].x}
                      y1={m.patch_line[0].y}
                      x2={m.patch_line[1].x}
                      y2={m.patch_line[1].y}
                      stroke="#00c853"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {m.patch_points.map((p, i) => (
                    <div key={i} style={{ position: "absolute", left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: 3, background: "#ffeb3b", border: "1px solid #000" }} />
                  ))}
                </>
              )}
            </div>
          ) : (
            <p style={{ fontSize: 13 }}>{draft.line ? "Measuring…" : "Draw a line to see the band here."}</p>
          )}

          {m && (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", margin: "8px 0" }} data-testid="measurement">
              <dt>Angle</dt>
              <dd style={{ margin: 0 }}>{m.status === "ok" ? `${m.angle!.toFixed(1)}° (counter-clockwise)` : "no edge found"}</dd>
              <dt>Direction</dt>
              <dd style={{ margin: 0 }}>
                {m.status === "ok" ? `${m.polarity}  (${m.polarity === "+" ? "left side brighter" : "right side brighter"}, contrast ${Math.abs(m.contrast!).toFixed(0)})` : "—"}
              </dd>
              <dt>Points used</dt>
              <dd style={{ margin: 0 }}>
                {m.n_points} of {draft.points}
                {m.rms !== null ? ` · spread ${m.rms.toFixed(2)} px` : ""}
              </dd>
              {preview?.verdict && (
                <>
                  <dt>Verdict</dt>
                  <dd style={{ margin: 0 }}>
                    <strong style={{ color: VERDICT_COLOUR[preview.verdict] }}>{preview.verdict}</strong>
                  </dd>
                </>
              )}
            </dl>
          )}

          <label style={{ display: "block" }}>
            Points used{" "}
            <input
              type="range"
              aria-label="Points used"
              min={ranges?.points[0] ?? 3}
              max={ranges?.points[1] ?? 40}
              value={draft.points}
              onChange={(e) => setDraft((d) => ({ ...d, points: Number(e.target.value) }))}
            />{" "}
            {draft.points}
          </label>
          <small>Start low (5) and raise it if the angle jumps between frames: more points average out noise.</small>
          <label style={{ display: "block", marginTop: 6 }}>
            Band half-width{" "}
            <input
              type="range"
              aria-label="Band half-width"
              min={ranges?.half_width[0] ?? 0.005}
              max={ranges?.half_width[1] ?? 0.5}
              step={0.005}
              value={draft.halfWidth}
              onChange={(e) => setDraft((d) => ({ ...d, halfWidth: Number(e.target.value) }))}
            />{" "}
            {draft.halfWidth.toFixed(3)}
          </label>

          <h3>What counts as OK</h3>
          {draft.expected ? (
            <div style={{ display: "grid", gap: 6 }}>
              <label>
                Angle{" "}
                <input
                  type="number"
                  aria-label="Expected angle"
                  min={0}
                  max={180}
                  step={0.1}
                  value={draft.expected.angle}
                  onChange={(e) => setExpected({ angle: Math.min(180, Math.max(0, Number(e.target.value))) })}
                  style={{ width: 80 }}
                />{" "}
                ° ±{" "}
                <input
                  type="number"
                  aria-label="Tolerance"
                  min={ranges?.tolerance[0] ?? 0.1}
                  max={ranges?.tolerance[1] ?? 90}
                  step={0.5}
                  value={draft.expected.tolerance}
                  onChange={(e) => setExpected({ tolerance: Math.min(90, Math.max(0.1, Number(e.target.value))) })}
                  style={{ width: 70 }}
                />{" "}
                °
              </label>
              <label>
                Direction{" "}
                <select aria-label="Expected direction" value={draft.expected.polarity} onChange={(e) => setExpected({ polarity: e.target.value as "+" | "-" })}>
                  <option value="+">+ (left side brighter)</option>
                  <option value="-">− (right side brighter)</option>
                </select>
              </label>
              <button onClick={() => setDraft((d) => ({ ...d, expected: null }))}>Measure only (no pass/fail)</button>
            </div>
          ) : (
            <p style={{ fontSize: 13 }}>No expectation yet: frames are measured but not judged.</p>
          )}
          <button
            disabled={!m || m.status !== "ok"}
            title="Take this frame's measured angle and direction as the expected values."
            onClick={() =>
              m &&
              m.status === "ok" &&
              setDraft((d) => ({
                ...d,
                expected: { angle: round(m.angle!), tolerance: d.expected?.tolerance ?? saved?.defaults.tolerance ?? 5, polarity: m.polarity! },
              }))
            }
          >
            Use this frame as the OK example
          </button>

          <h3>Save and measure</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={!dirty} onClick={() => save()}>
              Save{dirty ? " *" : ""}
            </button>
            <button disabled={!dirty} onClick={() => setDraft(fromSettings(saved?.settings ?? null, { ...EMPTY, halfWidth: saved?.defaults.half_width ?? EMPTY.halfWidth, points: saved?.defaults.points ?? EMPTY.points }))}>
              Revert
            </button>
            <button disabled={!draft.line || running} onClick={saveAndRun}>
              {dirty ? "Save and measure all frames" : "Measure all frames"}
            </button>
            {saved?.settings && (
              <button
                disabled={running}
                onClick={() => {
                  api
                    .edgeAngleSave(camera, feature, null)
                    .then((st) => {
                      setSaved(st);
                      setDraft(EMPTY);
                    })
                    .catch((e: unknown) => setError(msg(e)));
                }}
              >
                Remove the rule
              </button>
            )}
          </div>
          {running && (
            <p aria-live="polite">
              <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Measuring {Number(progress.done ?? 0)}/{Number(progress.total ?? 0)}
            </p>
          )}
          {saved?.results === "stale" && <p role="status">⚠ The saved results are for an earlier line or filter. Measure all frames again.</p>}
          {saved?.results === "fresh" && saved.summary && (
            <p role="status" data-testid="summary">
              Last run: {saved.summary.total} frames
              {saved.settings?.expected
                ? ` · ${saved.summary.pass} pass · ${saved.summary.fail} fail · ${saved.summary.undetermined} undetermined`
                : ` · ${saved.summary.measured} measured (set an expectation to get pass/fail)`}
              .
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
