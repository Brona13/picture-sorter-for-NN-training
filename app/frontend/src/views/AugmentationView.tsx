import { useCallback, useEffect, useRef, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, MotionAnalysis, MotionAxis, MotionRanges, MotionSettings, MotionState } from "../api";
import Histogram from "../classify/Histogram";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const AXES = [
  { key: "dx", title: "Shift right (+) / left (−)", unit: "px" },
  { key: "dy", title: "Shift down (+) / up (−)", unit: "px" },
  { key: "rot", title: "Rotation, counter-clockwise (+)", unit: "°" },
] as const;
type AxisKey = (typeof AXES)[number]["key"];

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * How far does the object move between frames of this ROI? Measures the shift (and optionally the
 * rotation) of every frame against a reference frame and suggests the central part of the distribution
 * as ranges. The ranges are edited and saved here and frozen with a version, for the training side to use.
 * Nothing is applied to any picture: this page only measures and records.
 */
export default function AugmentationView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [frames, setFrames] = useState<string[]>([]);
  const [saved, setSaved] = useState<MotionState | null>(null);
  const [draft, setDraft] = useState<MotionSettings | null>(null);
  const [analysis, setAnalysis] = useState<MotionAnalysis | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<{ measured: number; total: number; reference: string }>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");
  const seq = useRef(0);

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
      .then((r) => setFrames(r.frames))
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, product]);

  const load = useCallback(async () => {
    if (!camera || !feature) return;
    try {
      const st = await api.motionState(camera, feature);
      setSaved(st);
      setDraft({ ...st.settings, reference: st.settings.reference ?? st.reference });
      setAnalysis(st.analysis);
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature]);

  useEffect(() => {
    setSaved(null);
    setDraft(null);
    setAnalysis(null);
    setJobId(null);
    setNotice(null);
    load();
  }, [load]);

  // The coverage slider and the label filter only change the analysis, so preview them without saving.
  const coverage = draft?.coverage;
  const label = draft?.label ?? "";
  useEffect(() => {
    if (!camera || !feature || !saved || saved.results !== "fresh" || coverage === undefined) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api
        .motionState(camera, feature, coverage, label)
        .then((st) => mine === seq.current && setAnalysis(st.analysis))
        .catch((e: unknown) => mine === seq.current && setError(msg(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [camera, feature, saved, coverage, label]);

  useEffect(() => {
    if (job?.status === "done") {
      setNotice(`Measured ${job.result?.measured ?? 0} of ${job.result?.total ?? 0} frames.`);
      load();
    } else if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const settingsOf = (s: MotionState | null): string | null => (s ? JSON.stringify({ ...s.settings, reference: s.settings.reference ?? s.reference }) : null);
  const dirty = draft !== null && JSON.stringify(draft) !== settingsOf(saved);

  async function save(): Promise<boolean> {
    if (!draft) return false;
    try {
      const st = await api.motionSave(camera, feature, draft);
      setSaved(st);
      setAnalysis(st.analysis);
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
      setJobId((await api.motionRun(camera, feature)).id);
    } catch (e) {
      setError(msg(e));
    }
  }

  const setRange = (key: AxisKey, range: [number, number] | null) => setDraft((d) => (d ? { ...d, ranges: { ...d.ranges, [key]: range } as MotionRanges } : d));
  const useSuggested = (key: AxisKey) => {
    const axis = analysis?.[key];
    if (axis) setRange(key, [round1(axis.suggested[0]), round1(axis.suggested[1])]);
  };
  const progress = job?.progress ?? {};
  const stale = saved?.results === "stale";

  if (!camera) return <p>Select a camera.</p>;

  const pct = (key: AxisKey, v: number): string => {
    const size = analysis?.crop ? (key === "dx" ? analysis.crop[0] : analysis.crop[1]) : 0;
    return key === "rot" || !size ? "" : ` (${((v / size) * 100).toFixed(1)}%)`;
  };

  return (
    <section>
      <h2>
        Augmentation ranges — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p style={{ fontSize: 13 }}>
        How far does the object move between frames of this ROI? Every frame is compared with a reference frame and the shift (and, if you ask for it, the rotation) is
        measured. The central part of the distribution is suggested as a range; you edit it and save it, and it is frozen with the version for the training side. Nothing here
        changes or creates a picture.
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
        {draft && (
          <>
            <label title="Everything is measured against this frame: pick a typical OK frame where the object sits where it should.">
              Reference frame{" "}
              <select aria-label="Reference frame" value={draft.reference ?? ""} onChange={(e) => setDraft({ ...draft, reference: e.target.value || null })}>
                {frames.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              Shift from{" "}
              <select aria-label="Shift source" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value as MotionSettings["source"] })}>
                <option value="auto">detector box, else picture matching</option>
                <option value="detector" disabled={!saved?.has_detector}>
                  detector box only
                </option>
                <option value="template">picture matching only</option>
              </select>
            </label>
            <label title="Estimates the rotation of each frame as well (slower; only reliable for a few degrees).">
              <input type="checkbox" checked={draft.rotation} onChange={(e) => setDraft({ ...draft, rotation: e.target.checked })} /> Measure rotation
            </label>
          </>
        )}
      </div>
      {draft && !saved?.has_detector && draft.source !== "template" && (
        <p style={{ fontSize: 12 }}>This ROI has no detector set up, so shifts come from matching the pictures.</p>
      )}

      {draft && (
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button disabled={!draft.reference || running} onClick={saveAndRun}>
            {dirty ? "Save and measure all frames" : "Measure all frames"}
          </button>
          <button disabled={!dirty} onClick={() => save()}>
            Save{dirty ? " *" : ""}
          </button>
          <button disabled={!dirty} onClick={() => saved && setDraft({ ...saved.settings, reference: saved.settings.reference ?? saved.reference })}>
            Revert
          </button>
          {saved?.saved && (
            <button
              disabled={running}
              onClick={() =>
                api
                  .motionSave(camera, feature, null)
                  .then(() => load())
                  .catch((e: unknown) => setError(msg(e)))
              }
            >
              Remove the saved ranges
            </button>
          )}
          {running && (
            <span aria-live="polite">
              <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Measuring {Number(progress.done ?? 0)}/{Number(progress.total ?? 0)}
            </span>
          )}
        </p>
      )}
      {stale && <p role="status">⚠ The saved measurements were made with a different reference frame, filter, detector or option. Measure all frames again.</p>}
      {saved?.results === "none" && <p>No measurements yet. Choose a reference frame and click “Measure all frames”.</p>}

      {draft && analysis && (
        <>
          <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
            <label>
              Cover the central{" "}
              <input
                type="range"
                aria-label="Coverage"
                min={saved?.coverage_range[0] ?? 50}
                max={saved?.coverage_range[1] ?? 100}
                step={1}
                value={draft.coverage}
                onChange={(e) => setDraft({ ...draft, coverage: Number(e.target.value) })}
              />{" "}
              {draft.coverage}% of the frames
            </label>
            <label>
              Use frames{" "}
              <select aria-label="Frames to use" value={draft.label ?? ""} onChange={(e) => setDraft({ ...draft, label: e.target.value || null })}>
                <option value="">all</option>
                {saved?.classes.map((c) => (
                  <option key={c} value={c}>
                    labeled {c}
                  </option>
                ))}
              </select>
            </label>
            <span data-testid="sources" style={{ fontSize: 12 }}>
              {analysis.frames} frames · shift from detector {analysis.sources.detector}, picture matching {analysis.sources.template}, not measured {analysis.sources.none}
              {analysis.reference ? ` · reference ${analysis.reference}` : ""}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
            {AXES.map(({ key, title, unit }) => {
              const axis: MotionAxis | null = analysis[key];
              const chosen = draft.ranges[key];
              if (!axis)
                return (
                  <div key={key} data-testid={`axis-${key}`}>
                    <h3 style={{ marginBottom: 4 }}>{title}</h3>
                    <p style={{ fontSize: 13 }}>{key === "rot" ? "Rotation was not measured. Tick “Measure rotation” and measure again." : "No measurements for the selected frames."}</p>
                  </div>
                );
              return (
                <div key={key} data-testid={`axis-${key}`}>
                  <h3 style={{ marginBottom: 4 }}>{title}</h3>
                  <Histogram title={`${axis.n} frames`} unit={unit} edges={axis.hist.edges} counts={axis.hist.counts} suggested={axis.suggested} chosen={chosen} />
                  <table style={{ fontSize: 12, margin: "6px 0" }}>
                    <tbody>
                      <tr>
                        <td>min … max</td>
                        <td>
                          {round1(axis.min)} … {round1(axis.max)} {unit}
                          {pct(key, axis.max)}
                        </td>
                      </tr>
                      <tr>
                        <td>median</td>
                        <td>
                          {round1(axis.median)} {unit}
                        </td>
                      </tr>
                      <tr>
                        <td>central {analysis.coverage}%</td>
                        <td data-testid={`suggested-${key}`}>
                          {round1(axis.suggested[0])} … {round1(axis.suggested[1])} {unit}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <label>
                    Range{" "}
                    <input
                      type="number"
                      aria-label={`${key} low`}
                      step={0.1}
                      value={chosen ? chosen[0] : ""}
                      onChange={(e) => e.target.value !== "" && setRange(key, [Number(e.target.value), chosen ? Math.max(chosen[1], Number(e.target.value)) : Number(e.target.value)])}
                      style={{ width: 80 }}
                    />{" "}
                    …{" "}
                    <input
                      type="number"
                      aria-label={`${key} high`}
                      step={0.1}
                      value={chosen ? chosen[1] : ""}
                      onChange={(e) => e.target.value !== "" && setRange(key, [chosen ? Math.min(chosen[0], Number(e.target.value)) : Number(e.target.value), Number(e.target.value)])}
                      style={{ width: 80 }}
                    />{" "}
                    {unit}
                  </label>{" "}
                  <button aria-label={`Use suggested ${key}`} onClick={() => useSuggested(key)}>
                    Use suggested
                  </button>{" "}
                  <button aria-label={`Clear ${key}`} disabled={!chosen} onClick={() => setRange(key, null)}>
                    Clear
                  </button>
                </div>
              );
            })}
          </div>
          <p>
            <button
              onClick={() => {
                useSuggested("dx");
                useSuggested("dy");
                useSuggested("rot");
              }}
            >
              Use the suggested range for every axis
            </button>
          </p>
        </>
      )}
    </section>
  );
}
