import { ReactNode, useCallback, useEffect, useState } from "react";
import { api, CardData, DedupParams, DedupResult, DedupState, DedupSweep, DedupSweepRange, OutlierResult } from "../api";
import DeletedByDay from "../classify/DeletedByDay";
import PictureGrid, { type GridMute } from "../classify/PictureGrid";
import ClusterBrowser, { Marks } from "../classify/ClusterBrowser";
import { OutlierControls, OutlierResults, useOutliers } from "../classify/OutlierPanel";
import { ColourBy } from "../classify/Scatter";
import { OUTLIERS_INFO, SCATTER_INFO } from "../classify/toolInfo";
import { effectiveColour, ProjectionProgress, ScatterMapView, useScatterMap } from "../classify/ScatterWorkbench";
import InfoTip from "../InfoTip";
import SidePanel from "../SidePanel";
import WheelRange from "../WheelRange";
import { lastSession } from "../lastSession";
import { useJob } from "../useJob";
import DedupSweepChart from "./DedupSweepChart";

const DEFAULT_SWEEP: DedupSweepRange = { eps_from: 0.005, eps_to: 0.03, eps_step: 0.001, mp_from: 2, mp_to: 4 };

/** The sweep range remembered for this camera, else the defaults. */
function savedSweepRange(camera: string): DedupSweepRange {
  try {
    return { ...DEFAULT_SWEEP, ...JSON.parse(lastSession.sweepRange(camera) || "{}") };
  } catch {
    return DEFAULT_SWEEP;
  }
}

/** How many Epsilon values and clustering runs (at most) a sweep range asks for. */
export function sweepRuns(r: DedupSweepRange): { values: number; runs: number } {
  const values = r.eps_step > 0 ? Math.floor((r.eps_to - r.eps_from) / r.eps_step + 1e-9) + 1 : 0;
  return { values: Math.max(0, values), runs: Math.max(0, values) * Math.max(0, r.mp_to - r.mp_from + 1) };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function drift(existing: DedupParams, now: DedupParams): string[] {
  const bits: string[] = [];
  if (existing.method !== now.method) bits.push(`embedding '${existing.method}' → '${now.method}'`);
  if (Math.abs(existing.epsilon - now.epsilon) > 1e-9) bits.push(`ε ${existing.epsilon.toFixed(3)} → ${now.epsilon.toFixed(3)}`);
  if (existing.min_points !== now.min_points) bits.push(`minPts ${existing.min_points} → ${now.min_points}`);
  return bits;
}

const CLUSTERS_INFO = (
  <>
    Groups near-identical pictures: DBSCAN on the ResNet embeddings. <strong>Epsilon</strong> is how close two pictures must be to count as neighbours and{" "}
    <strong>Min points</strong> how many neighbours make a cluster. The chosen representative of each cluster stays visible in Classify; every other member of the
    cluster is muted when you press <strong>Apply mute</strong>. Nothing is deleted. The mutes belong to this Dedup box; a golden is never muted.
  </>
);
/** The three duplicate tools; the top bar picks one, and its controls fill the options panel and its results the centre. */
export type DedupTool = "grid" | "scatter" | "clusters" | "outliers";
const TITLES: Record<DedupTool, string> = { grid: "Grid", scatter: "Scatter", clusters: "Clusters", outliers: "Outliers" };

/** Each frame's outlier score scaled to [0, 1] against the 95th percentile, so one extreme frame cannot wash out the rest. */
export function outlierShades(r: OutlierResult): Record<string, number> {
  const top = Math.max(r.summary.p95, 1e-9);
  return Object.fromEntries(r.scores.map((s) => [s.frame, Math.min(1, s.score / top)]));
}

export default function DedupView({
  camera,
  box,
  tool = "scatter",
  onBack,
  onTool,
}: {
  camera: string;
  /** The Dedup box to open (from the Chain); else the first one. */
  box?: string;
  tool?: DedupTool;
  /** From the Chain: the way back. */
  onBack?: () => void;
  /** Switch to another tool of the same box. */
  onTool?: (tool: DedupTool, box: string) => void;
}) {
  const [gridData, setGridData] = useState<Awaited<ReturnType<typeof api.dedupFrames>> | null>(null);
  const [gridPage, setGridPage] = useState(1);
  const [showMuted, setShowMuted] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [gridRev, setGridRev] = useState(0);
  // The pages work on one Dedup box of the Chain (its id is the "feature" of the API).
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [boxesLoaded, setBoxesLoaded] = useState(false);
  const [st, setSt] = useState<DedupState | null>(null);
  const [params, setParams] = useState<DedupParams | null>(null);
  const [result, setResult] = useState<DedupResult | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [clusterJob, setClusterJob] = useState<string | null>(null);
  const [sweep, setSweep] = useState<DedupSweep | null>(null);
  const [sweepJob, setSweepJob] = useState<string | null>(null);
  const [sweepRange, setSweepRange] = useState<DedupSweepRange>(() => savedSweepRange(camera));
  const [marks, setMarks] = useState<Marks>({});
  const [outliers, setOutliers] = useState<OutlierResult | null>(null);
  const [colourBy, setColourBy] = useState<ColourBy>("label");
  // The selected tool owns the options panel and the centre; the other tools keep their results while it is away.
  const active = tool;
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cj = useJob<DedupResult>(clusterJob);
  const clustering = clusterJob !== null && (cj === null || cj.status === "queued" || cj.status === "running");
  const sj = useJob<DedupSweep>(sweepJob);
  const sweeping = sweepJob !== null && (sj === null || sj.status === "queued" || sj.status === "running");
  const map = useScatterMap({ camera, feature, method: params?.method ?? "", onError: setError });
  const { scatter, projecting, projection, setProjection } = map;
  useEffect(() => setMarks(result?.marks ?? {}), [result]);

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .dedupBoxes(camera)
      .then((f) => {
        setFeatures(f);
        setBoxesLoaded(true);
        setFeature(f.some((b) => b.feature === box) ? box! : (f[0]?.feature ?? ""));
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, box]);

  const load = useCallback(async () => {
    if (!camera || !feature) return;
    try {
      const s = await api.dedupState(camera, feature);
      setSt(s);
      setParams(s.params);
      setResult(s.result);
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, [camera, feature]);
  // The M key in Clusters, Outliers and the Scatter selection: those lists only hold pictures the box still sees, so a picture
  // is muted there exactly when it was muted here by M (and not taken back since).
  const [mutedByKey, setMutedByKey] = useState<{ box: string; frames: Set<string> }>({ box: "", frames: new Set() });
  const keyMuted = mutedByKey.box === `${camera}/${feature}` ? mutedByKey.frames : new Set<string>();
  const toolMute: GridMute = {
    showMuted,
    is: (f) => keyMuted.has(f),
    toggle: async (f) => {
      const was = keyMuted.has(f);
      if (was) await api.dedupUnmuteFrames(camera, feature, [f]);
      else {
        const r = await api.dedupMuteFrames(camera, feature, [f]);
        if (r.muted === 0) {
          setNotice(r.skipped_golden ? "A golden picture is never muted." : "This picture is already muted or not in the box any more.");
          return;
        }
      }
      setMutedByKey(() => {
        const next = new Set(keyMuted);
        if (was) next.delete(f);
        else next.add(f);
        return { box: `${camera}/${feature}`, frames: next };
      });
      load();
    },
  };

  useEffect(() => {
    setSt(null);
    setResult(null);
    setOutliers(null);
    setPicks({});
    setClusterJob(null);
    setSweep(null);
    setSweepJob(null);
    setNotice(null);
    setConfirmClear(false);
    load();
    if (camera && feature)
      api
        .dedupSweepGet(camera, feature)
        .then((r) => setSweep(r.sweep))
        .catch(() => undefined); // no held chart is not an error
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSweepRange(savedSweepRange(camera)), [camera]);

  useEffect(() => {
    if (!camera || !feature || tool !== "grid") return;
    api.dedupFrames(camera, feature).then(setGridData).catch((e: unknown) => setError(msg(e)));
  }, [camera, feature, tool, gridRev, st?.muted_count]);

  useEffect(() => {
    if (cj?.status === "done" && cj.result) {
      setResult(cj.result);
      setPicks({});
      if (map.scatter) map.run(); // its cluster colours follow the new clustering (the projection itself is cached)
    } else if (cj?.status === "error") setError(cj.error);
  }, [cj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function runCluster(p: DedupParams) {
    setNotice(null);
    api.dedupCluster(camera, feature, p).then((j) => setClusterJob(j.id)).catch((e: unknown) => setError(msg(e)));
  }

  function setRange(patch: Partial<DedupSweepRange>) {
    const next = { ...sweepRange, ...patch };
    setSweepRange(next);
    lastSession.setSweepRange(camera, JSON.stringify(next));
  }

  // A finished sweep puts the sliders on its peak and clusters there, so the grid below shows what the chart points at.
  useEffect(() => {
    if (sj?.status === "done" && sj.result) {
      setSweep(sj.result);
      const peak = sj.result.peak;
      if (peak && params) {
        const next = { ...params, epsilon: peak.epsilon, min_points: peak.min_points };
        change({ epsilon: peak.epsilon, min_points: peak.min_points });
        runCluster(next);
      } else setNotice("Nothing clusters in this range: widen the Epsilon range, or lower Min points.");
    } else if (sj?.status === "error") setError(sj.error);
  }, [sj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(patch: Partial<DedupParams>) {
    if (!params) return;
    const next = { ...params, ...patch };
    setParams(next);
    api.dedupSaveSettings(camera, feature, next).catch((e: unknown) => setError(msg(e)));
  }

  // Picture actions (label, golden, delete) go through the Classifier the box reads, else the whole-frame feature.
  const act = st?.source ?? gridData?.source ?? feature;
  const outlierRun = useOutliers({ camera, feature, method: params?.method ?? "", onResult: setOutliers, onError: setError });

  const blocked = (message: ReactNode) => <SidePanel panel={null}>{message}</SidePanel>;

  if (!camera) return <p>Select a camera.</p>;
  if (st?.reason === "no_embeddings")
    return blocked(
      <p>
        Perceptual dedup requires ResNet embeddings. Install the neural dependencies (<code>pip install -r requirements-embedding.txt</code>), then return here.
      </p>,
    );
  if (st?.reason === "methods_off")
    return blocked(
      <p>
        No ResNet method is switched on, and Dedup works on ResNet embeddings. Tick ResNet18 or ResNet50 on the <strong>Configuration</strong> page, then return here.
      </p>,
    );
  if (st?.reason === "no_sklearn")
    return blocked(
      <p>
        scikit-learn isn't installed. Run <code>pip install -r requirements-embedding.txt</code> (it includes scikit-learn) and reload the app.
      </p>,
    );

  const bits = result && params ? drift(result.params, params) : [];
  // Picks that no longer name a member of a cluster (it changed after a delete) are dropped.
  const validPicks = Object.fromEntries(Object.entries(picks).filter(([cid, f]) => result?.clusters.find((c) => c.id === Number(cid))?.members.includes(f)));
  const wouldMute = result ? result.clusters.reduce((n, c) => n + c.members.length - 1, 0) : 0;
  const progress = cj?.progress ?? {};
  const { colour: shownColour, note: colourNote } = effectiveColour(colourBy, scatter, outliers);

  return (
    <SidePanel
      card={
        st && (
          <>
            <strong data-testid="frames-in-scope">{st.frames}</strong>{" "}
            <span>{st.frames === 1 ? "frame" : "frames"} in scope</span>
          </>
        )
      }
      panel={
        <>
          {st && st.frames > 0 && params && (
            <label>
              Embedding
              <select value={params.method} onChange={(e) => change({ method: e.target.value })}>
                {st.backbones.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Dedup box
            <select value={feature} onChange={(e) => setFeature(e.target.value)}>
              {features.map((f) => (
                <option key={f.feature} value={f.feature}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {(active === "grid" || active === "clusters" || active === "outliers" || active === "scatter") && (
            <label title="Muted pictures leave the grids; tick to see them again, dimmed">
              <input type="checkbox" checked={showMuted} onChange={(e) => { setShowMuted(e.target.checked); setGridPage(1); }} /> Show muted
            </label>
          )}
          {active === "grid" && (
            <label title="The camera's deleted pictures by day, with Restore">
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted
            </label>
          )}
          {active === "clusters" && st && st.frames > 0 && params && (
            <ToolControls tool="clusters" info={CLUSTERS_INFO}>
              <label>
                Epsilon (neighborhood radius)
                <WheelRange
                  aria-label="Epsilon"
                  min={st.ranges.epsilon[0]}
                  max={st.ranges.epsilon[1]}
                  step={0.001}
                  value={params.epsilon}
                  onValue={(v) => change({ epsilon: v })}
                />
                <span>{params.epsilon.toFixed(3)}</span>
              </label>
              <label>
                Min points
                <WheelRange
                  aria-label="Min points"
                  min={st.ranges.min_points[0]}
                  max={st.ranges.min_points[1]}
                  step={1}
                  value={params.min_points}
                  onValue={(v) => change({ min_points: v })}
                />
                <span>{params.min_points}</span>
              </label>
              <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", alignItems: "center", marginTop: 8 }}>
                <button
                  disabled={clustering}
                  onClick={() => runCluster(params)}
                >
                  🔍 Cluster
                </button>
                <button
                  aria-label="Revert"
                  disabled={bits.length === 0}
                  onClick={() => result && change({ ...result.params })}
                  title={result ? "Revert: restore the sliders to the values used by the last computed clustering." : "Revert: nothing to go back to — run a cluster first."}
                >
                  ↺
                </button>
                {result && result.clusters.length > 0 && (
                  <button
                    aria-label="Apply mute"
                    disabled={wouldMute === 0}
                    title="Apply mute: mute every cluster member except its representative. Nothing is deleted."
                    onClick={() =>
                      api
                        .dedupApply(camera, feature, validPicks)
                        .then((r) => {
                          setNotice(
                            `Muted ${r.muted} frame(s)${r.unmuted ? ` · unmuted ${r.unmuted} that no longer belong to a cluster` : ""}` +
                              (r.skipped_labeled || r.skipped_golden
                                ? ` · skipped: ${[r.skipped_labeled && `${r.skipped_labeled} labeled`, r.skipped_golden && `${r.skipped_golden} golden`].filter(Boolean).join(", ")}`
                                : "") +
                              ".",
                          );
                          setResult(null);
                          setPicks({});
                          load();
                        })
                        .catch((e: unknown) => setError(msg(e)))
                    }
                  >
                    🔇
                  </button>
                )}
              </div>
              {clustering && (
                <p aria-live="polite">
                  <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Embedding {Number(progress.done ?? 0)}/
                  {Number(progress.total ?? 0)}
                </p>
              )}
              <fieldset className="sweep-controls" style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
                <legend style={{ fontSize: 12, color: "var(--muted)", padding: 0 }}>Sweep chart</legend>
                <div className="sweep-fields">
                  <span>Epsilon</span>
                  <input type="number" aria-label="Sweep Epsilon from" title="from" min={0.001} max={0.2} step={0.001} value={sweepRange.eps_from} onChange={(e) => setRange({ eps_from: Number(e.target.value) })} />
                  <input type="number" aria-label="Sweep Epsilon to" title="to" min={0.001} max={0.2} step={0.001} value={sweepRange.eps_to} onChange={(e) => setRange({ eps_to: Number(e.target.value) })} />
                  <span>Step</span>
                  <input type="number" aria-label="Sweep Epsilon step" min={0.0001} step={0.0005} value={sweepRange.eps_step} onChange={(e) => setRange({ eps_step: Number(e.target.value) })} />
                  <span />
                  <span>Min points</span>
                  <input type="number" aria-label="Sweep Min points from" title="from" min={2} max={10} step={1} value={sweepRange.mp_from} onChange={(e) => setRange({ mp_from: Number(e.target.value) })} />
                  <input type="number" aria-label="Sweep Min points to" title="to" min={2} max={10} step={1} value={sweepRange.mp_to} onChange={(e) => setRange({ mp_to: Number(e.target.value) })} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  <button
                    disabled={sweeping || clustering}
                    title="Calculate the chart: cluster over the whole Epsilon range for the lowest Min points, then for the others only where something happens."
                    onClick={() => {
                      setNotice(null);
                      api.dedupSweep(camera, feature, params.method, sweepRange).then((j) => setSweepJob(j.id)).catch((e: unknown) => setError(msg(e)));
                    }}
                  >
                    📈 Calculate chart
                  </button>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>up to {sweepRuns(sweepRange).runs} runs</span>
                </div>
                {sweeping && (
                  <p aria-live="polite">
                    <progress value={Number(sj?.progress.done ?? 0)} max={Number(sj?.progress.total ?? 0) || undefined} />{" "}
                    {sj?.progress.phase === "sweep" ? "Clustering" : "Embedding"} {Number(sj?.progress.done ?? 0)}/{Number(sj?.progress.total ?? 0)}
                  </p>
                )}
              </fieldset>
              {result && result.clusters.length > 0 && (
                <div data-testid="mute-status" style={{ fontSize: 12, marginTop: 4 }}>
                  {wouldMute} frame(s) will be muted
                </div>
              )}
              {result && bits.length > 0 && (
                <p role="status" style={{ fontSize: 12 }}>
                  ⚠ <strong>Sliders changed since the last cluster</strong> — clusters below still show the previous run ({bits.join(", ")}). Click{" "}
                  <strong>🔍 Cluster</strong> to recompute, or <strong>↺ Revert</strong> to match what's shown.
                </p>
              )}
            </ToolControls>
          )}
          {active === "scatter" && st && params && params.method && st.frames > 1 && (
            <ToolControls tool="scatter" info={SCATTER_INFO}>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontSize: 12, color: "var(--muted)", padding: 0 }}>Projection</legend>
                {(st?.projections ?? []).map((p) => (
                  <label key={p} style={{ display: "inline-block", marginRight: 12 }}>
                    <input type="radio" name="projection" checked={projection === p} onChange={() => setProjection(p)} /> {p}
                  </label>
                ))}
              </fieldset>
              <label>
                Colour by
                <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
                  <option value="cluster">Cluster</option>
                  <option value="label">Label</option>
                  <option value="outlier">Outlier score</option>
                  <option value="none">Nothing</option>
                </select>
              </label>
              <div style={{ marginTop: 8 }}>
                <button
                  disabled={projecting}
                  onClick={() => {
                    map.run();
                  }}
                >
                  Compute projection
                </button>
              </div>
              {projecting && <ProjectionProgress progress={map.progress} />}
            </ToolControls>
          )}
          {active === "outliers" && st && params && params.method && (
            <ToolControls tool="outliers" info={OUTLIERS_INFO}>
              <OutlierControls o={outlierRun} onStart={() => undefined} />
            </ToolControls>
          )}
        </>
      }
    >
    <section>
      {(onBack || onTool) && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
          {onBack && (
            <button type="button" onClick={onBack}>
              ← Back to chain
            </button>
          )}
          {onTool && (
            <div role="group" aria-label="View" style={{ display: "flex", gap: 6, marginLeft: 14 }}>
              {(["grid", "scatter", "clusters", "outliers"] as DedupTool[]).map((t) => (
                <button key={t} type="button" aria-pressed={tool === t} onClick={() => onTool(t, feature)}>
                  {TITLES[t]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {boxesLoaded && features.length === 0 && <p>There is no Dedup box yet. Add one on the Chain (the Dedup tile) and connect it.</p>}
      {st && st.frames === 0 && <p>This Dedup box has no pictures yet: ingest some, or label some for the Classifier it reads.</p>}

      {active === "grid" && showDeleted && st && (
        <div data-testid="deleted-view">
          <DeletedByDay
            camera={camera}
            feature={act}
            revision={gridRev}
            settings={st.grid}
            onSettings={(perPage, cols) =>
              api
                .dedupGridSettings(camera, feature, perPage, cols)
                .then((g) => setSt((x) => (x ? { ...x, grid: g } : x)))
                .catch((e: unknown) => setError(msg(e)))
            }
            onChanged={() => {
              setGridRev((r) => r + 1);
              load();
            }}
            onNotice={setNotice}
            onError={setError}
          />
        </div>
      )}

      {active === "grid" && !showDeleted && gridData && st && (() => {
        const mutedSet = new Set(gridData.muted);
        const shownFrames = gridData.frames; // PictureGrid drops the muted ones unless Show muted is ticked
        const shownCount = showMuted ? shownFrames.length : shownFrames.filter((f) => !mutedSet.has(f)).length;
        const cardOf = (frame: string): CardData => ({
          frame,
          label: gridData.marks[frame]?.label ?? null,
          golden: gridData.marks[frame]?.golden ?? null,
          deleted: false,
          muted: mutedSet.has(frame),
          leanings: {},
          bars: null,
          cluster: null,
        });
        return (
          <div data-testid="grid-view">
            <p role="status">
              {shownCount} {shownCount === 1 ? "picture" : "pictures"} · {gridData.muted.length} muted
            </p>
            <PictureGrid
              camera={camera}
              feature={act}
              pictureFeature={feature}
              classes={gridData.classes}
              labeling={false}
              frames={shownFrames}
              cardOf={cardOf}
              via="Dedup grid"
              grid={st.grid}
              onGrid={(perPage, cols) =>
                api
                  .dedupGridSettings(camera, feature, perPage, cols)
                  .then((g) => {
                    setSt((x) => (x ? { ...x, grid: g } : x));
                    setGridPage(1);
                  })
                  .catch((e: unknown) => setError(msg(e)))
              }
              page={gridPage}
              onPage={(p) => {
               
                setGridPage(p);
              }}
              mute={{
                showMuted,
                is: (f) => mutedSet.has(f),
                toggle: async (f) => {
                  if (mutedSet.has(f)) await api.dedupUnmuteFrames(camera, feature, [f]);
                  else {
                    const r = await api.dedupMuteFrames(camera, feature, [f]);
                    if (r.muted === 0) {
                      setNotice(r.skipped_golden ? "A golden picture is never muted." : "This picture is not in the box any more.");
                      return;
                    }
                  }
                  setGridRev((r) => r + 1);
                  load();
                },
              }}
              where="grid"
              extras={(f) => (mutedSet.has(f) ? { caption: "muted" } : {})}
              onChanged={() => setGridRev((r) => r + 1)}
              onDeleted={() => setGridRev((r) => r + 1)}
              onError={setError}
            />
          </div>
        );
      })()}

      {active === "scatter" && (
        <div data-testid="scatter-view">
          {!scatter && !projecting && <p>Press <strong>Compute projection</strong> in the options panel to map this box's pictures in 2D.</p>}
          {scatter && (
            <>
              {colourNote && <p role="note" style={{ fontSize: 12 }}>{colourNote}</p>}
              <ScatterMapView
                camera={camera}
                feature={act}
                pictureFeature={feature}
                labeling={false}
                map={map}
                mute={toolMute}
                onMute={(frames) =>
                  api.dedupMuteFrames(camera, feature, frames).then((r) => {
                    setNotice(
                      `Muted ${r.muted} frame(s)` +
                        (r.already ? ` · ${r.already} were already muted` : "") +
                        (r.skipped_golden ? ` · ${r.skipped_golden} golden kept` : "") +
                        ". Unmute all of this box (below) undoes it.",
                    );
                    load();
                  })
                }
                colourBy={shownColour}
                scores={outliers ? outlierShades(outliers) : undefined}
                grid={st?.grid ?? { per_page: 24, cols: 4, per_page_options: [], cols_options: [] }}
                onGrid={(perPage, cols) =>
                  api
                    .dedupGridSettings(camera, feature, perPage, cols)
                    .then((g) => setSt((x) => (x ? { ...x, grid: g } : x)))
                    .catch((e: unknown) => setError(msg(e)))
                }
                onNotice={setNotice}
                onError={setError}
                onChanged={load}
              />
            </>
          )}
        </div>
      )}

      {active === "outliers" && st && params && params.method && (
        <OutlierResults
          mute={toolMute}
          o={outlierRun}
          labelFeature={act}
          labeling={false}
          grid={st.grid}
          onGrid={(perPage, cols) =>
            api
              .dedupGridSettings(camera, feature, perPage, cols)
              .then((g) => setSt((s) => (s ? { ...s, grid: g } : s)))
              .catch((e: unknown) => setError(msg(e)))
          }
          onDeleted={(frame) => {
            setNotice(`Deleted ${frame}. It stays on disk; see Classify → Show: Deleted.`);
            load();
          }}
        />
      )}

      {active === "clusters" && sweep && params && (
        <DedupSweepChart
          sweep={sweep}
          epsilon={params.epsilon}
          minPoints={params.min_points}
          method={params.method}
          onPick={(epsilon, min_points) => {
            change({ epsilon, min_points });
            runCluster({ ...params, epsilon, min_points });
          }}
        />
      )}

      {active === "clusters" && result && (
        <>
          <dl style={{ display: "flex", gap: 24 }}>
            <div>
              <dt>Clusters</dt>
              <dd>{result.summary.clusters}</dd>
            </div>
            <div>
              <dt>Covered frames</dt>
              <dd>{result.summary.covered}</dd>
            </div>
            <div>
              <dt>Unique (noise)</dt>
              <dd>{result.summary.unique}</dd>
            </div>
            <div>
              <dt>Would mute</dt>
              <dd>{wouldMute}</dd>
            </div>
          </dl>

          {result.clusters.length === 0 && (
            <p>
              No clusters at the current sliders. Everything looks unique under this embedding at this radius — try a larger <em>epsilon</em>, a smaller{" "}
              <em>min points</em>, or a different backbone.
            </p>
          )}
          {st && (
            <ClusterBrowser
              mute={toolMute}
              camera={camera}
              feature={act}
              pictureFeature={feature}
              result={result}
              picks={picks}
              marks={marks}
              grid={st.grid}
              onPick={(cid, frame) => setPicks((p) => ({ ...p, [cid]: frame }))}
              onMarks={(frame, m) => setMarks((cur) => ({ ...cur, [frame]: m }))}
              onGrid={(perPage, cols) =>
                api
                  .dedupGridSettings(camera, feature, perPage, cols)
                  .then((g) => setSt((s) => (s ? { ...s, grid: g } : s)))
                  .catch((e: unknown) => setError(msg(e)))
              }
              onError={setError}
              onDeleted={(frame) => {
                setNotice(`Deleted ${frame}. It stays on disk; see Classify → Show: Deleted.`);
                load();
                if (map.scatter) map.run();
              }}
            />
          )}
        </>
      )}

      {st && st.muted_count > 0 && (
        <div>
          <hr />
          <h3>Currently muted — {st.muted_count} frame(s)</h3>
          <p>Muted frames stay on disk and can be revealed in Classify with Show muted, or unmuted here in bulk.</p>
          {confirmClear ? (
            <>
              <button
                onClick={() =>
                  api
                    .dedupClearMutes(camera, feature)
                    .then((r) => {
                      setNotice(`Unmuted ${r.unmuted} frame(s).`);
                      setConfirmClear(false);
                      load();
                    })
                    .catch((e: unknown) => setError(msg(e)))
                }
              >
                Yes — unmute all
              </button>{" "}
              <button onClick={() => setConfirmClear(false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmClear(true)}>♻️ Unmute all of this box</button>
          )}
        </div>
      )}
    </section>
    </SidePanel>
  );
}

/** The selected tool's heading (with its info tip) and controls, in the options panel under the shared Embedding and Feature. */
function ToolControls({ tool, info, children }: { tool: DedupTool; info: ReactNode; children: ReactNode }) {
  return (
    <section className="tool-controls" data-testid={`${tool}-controls`}>
      <h3 className="tool-controls-title">
        {TITLES[tool]}
        <InfoTip label={TITLES[tool]}>{info}</InfoTip>
      </h3>
      {children}
    </section>
  );
}
