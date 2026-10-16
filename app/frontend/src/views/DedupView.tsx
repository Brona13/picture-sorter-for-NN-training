import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, CardData, DedupParams, DedupResult, DedupState, DeletePreview, DeleteResult, OutlierResult, ScatterPoint, ScatterResult } from "../api";
import Card from "../classify/Card";
import { classColor } from "../classify/colors";
import FrameViewer from "../classify/FrameViewer";
import Pager, { PagerSettings } from "../classify/Pager";
import ClusterBrowser, { Marks } from "../classify/ClusterBrowser";
import { OutlierControls, OutlierResults, useOutliers } from "../classify/OutlierPanel";
import Scatter, { ColourBy, ScatterLegend } from "../classify/Scatter";
import SidePanel, { PanelGroup } from "../SidePanel";
import WheelRange from "../WheelRange";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function drift(existing: DedupParams, now: DedupParams): string[] {
  const bits: string[] = [];
  if (existing.method !== now.method) bits.push(`embedding '${existing.method}' → '${now.method}'`);
  if (Math.abs(existing.epsilon - now.epsilon) > 1e-9) bits.push(`ε ${existing.epsilon.toFixed(3)} → ${now.epsilon.toFixed(3)}`);
  if (existing.min_points !== now.min_points) bits.push(`minPts ${existing.min_points} → ${now.min_points}`);
  return bits;
}

/** The functions that can own the centre of the page; one at a time. */
type Fn = "clusters" | "outliers" | "scatter";

/** Each frame's outlier score scaled to [0, 1] against the 95th percentile, so one extreme frame cannot wash out the rest. */
export function outlierShades(r: OutlierResult): Record<string, number> {
  const top = Math.max(r.summary.p95, 1e-9);
  return Object.fromEntries(r.scores.map((s) => [s.frame, Math.min(1, s.score / top)]));
}

export default function DedupView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [st, setSt] = useState<DedupState | null>(null);
  const [params, setParams] = useState<DedupParams | null>(null);
  const [result, setResult] = useState<DedupResult | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [clusterJob, setClusterJob] = useState<string | null>(null);
  const [scatterJob, setScatterJob] = useState<string | null>(null);
  const [projection, setProjection] = useState("umap");
  const [scatter, setScatter] = useState<ScatterResult | null>(null);
  const [selected, setSelected] = useState<ScatterPoint[] | null>(null);
  // Changes made from the selection (a label, a delete) show on the map at once, without projecting again. null = deleted.
  const [overrides, setOverrides] = useState<Record<string, Mark | null>>({});
  const [marks, setMarks] = useState<Marks>({});
  const [outliers, setOutliers] = useState<OutlierResult | null>(null);
  const [colourBy, setColourBy] = useState<ColourBy>("label");
  // One function at a time owns the centre of the page; groups can still be opened to look at their settings.
  const [active, setActive] = useState<Fn>("clusters");
  const [open, setOpen] = useState<Record<Fn, boolean>>({ clusters: true, outliers: false, scatter: false });
  // A fresh projection resets the chart's zoom and selection; the key changes in the same render, so no remount flicker.
  const genRef = useRef<{ scatter: ScatterResult | null; gen: number }>({ scatter: null, gen: 0 });
  if (genRef.current.scatter !== scatter) genRef.current = { scatter, gen: genRef.current.gen + 1 };
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cj = useJob<DedupResult>(clusterJob);
  const sj = useJob<ScatterResult>(scatterJob);
  const clustering = clusterJob !== null && (cj === null || cj.status === "queued" || cj.status === "running");
  const projecting = scatterJob !== null && (sj === null || sj.status === "queued" || sj.status === "running");

  useEffect(() => {
    setSelected(null);
    setOverrides({});
  }, [scatter]);
  const mapPoints = useMemo(
    () => (scatter ? scatter.points.flatMap((p) => (p.frame in overrides ? (overrides[p.frame] === null ? [] : [{ ...p, ...overrides[p.frame] }]) : [p])) : []),
    [scatter, overrides],
  );
  // A map of another embedding would be stale.
  useEffect(() => {
    if (scatter && params && scatter.method !== params.method) setScatter(null);
  }, [params?.method]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMarks(result?.marks ?? {}), [result]);

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
  }, [camera, product]);

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

  useEffect(() => {
    setSt(null);
    setResult(null);
    setOutliers(null);
    setPicks({});
    setScatter(null);
    setClusterJob(null);
    setScatterJob(null);
    setNotice(null);
    setConfirmClear(false);
    load();
  }, [load]);

  useEffect(() => {
    if (cj?.status === "done" && cj.result) {
      setResult(cj.result);
      setPicks({});
      if (scatter) runScatter(); // its cluster colours follow the new clustering (the projection itself is cached)
    } else if (cj?.status === "error") setError(cj.error);
  }, [cj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sj?.status === "done" && sj.result) setScatter(sj.result);
    else if (sj?.status === "error") setError(sj.error);
  }, [sj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(patch: Partial<DedupParams>) {
    if (!params) return;
    const next = { ...params, ...patch };
    setParams(next);
    api.dedupSaveSettings(camera, feature, next).catch((e: unknown) => setError(msg(e)));
  }

  // The map of the feature's frames, for the chosen embedding. No clustering is needed.
  function runScatter() {
    if (!params?.method) return;
    api.dedupScatter(camera, feature, projection, params.method).then((j) => setScatterJob(j.id)).catch((e: unknown) => setError(msg(e)));
  }

  // Pressing a function's own button makes it the active one: the previous one deactivates and collapses.
  function activate(fn: Fn) {
    setOpen((o) => ({ ...o, [active]: fn === active ? o[active] : false, [fn]: true }));
    setActive(fn);
  }

  const outlierRun = useOutliers({ camera, feature, method: params?.method ?? "", onResult: setOutliers, onError: setError });

  if (!camera) return <p>Select a camera.</p>;
  if (st?.reason === "no_embeddings")
    return (
      <p>
        Perceptual dedup requires ResNet embeddings. Install the neural dependencies (<code>pip install -r requirements-embedding.txt</code>), then return here.
      </p>
    );
  if (st?.reason === "methods_off")
    return (
      <p>
        No ResNet method is switched on, and Dedup works on ResNet embeddings. Tick ResNet18 or ResNet50 on the <strong>Configuration</strong> page, then return here.
      </p>
    );
  if (st?.reason === "no_sklearn")
    return (
      <p>
        scikit-learn isn't installed. Run <code>pip install -r requirements-embedding.txt</code> (it includes scikit-learn) and reload the app.
      </p>
    );

  const bits = result && params ? drift(result.params, params) : [];
  // Picks that no longer name a member of a cluster (it changed after a delete) are dropped.
  const validPicks = Object.fromEntries(Object.entries(picks).filter(([cid, f]) => result?.clusters.find((c) => c.id === Number(cid))?.members.includes(f)));
  const wouldMute = result ? result.clusters.reduce((n, c) => n + c.members.length - 1, 0) : 0;
  const progress = cj?.progress ?? {};
  // The map can only be coloured by what exists: say so and fall back to the labels.
  const hasClusters = !!scatter && scatter.points.some((p) => p.cluster !== null);
  const colourNote =
    colourBy === "cluster" && !hasClusters
      ? "There is no clustering for this embedding yet, so the dots are coloured by label. Press Cluster to colour by cluster."
      : colourBy === "outlier" && !outliers
        ? "Outliers have not been scored for this embedding, so the dots are coloured by label. Press Score outliers first."
        : null;
  const effectiveColour: ColourBy = colourNote ? "label" : colourBy;

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
            Feature (ROI)
            <select value={feature} onChange={(e) => setFeature(e.target.value)}>
              {features.map((f) => (
                <option key={f.feature} value={f.feature}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {st && st.frames > 0 && params && (
            <PanelGroup title="Clusters" testId="cluster-group" open={open.clusters} onOpenChange={(v) => setOpen((o) => ({ ...o, clusters: v }))} active={active === "clusters"}>
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
                  onClick={() => {
                    activate("clusters");
                    setNotice(null);
                    api.dedupCluster(camera, feature, params).then((j) => setClusterJob(j.id)).catch((e: unknown) => setError(msg(e)));
                  }}
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
                    disabled={wouldMute === 0 || active !== "clusters"}
                    title={active !== "clusters" ? "Apply mute: press Cluster to bring the clusters back first." : "Apply mute: mute every cluster member except its representative. Nothing is deleted."}
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
            </PanelGroup>
          )}
          {st && params && params.method && st.frames > 1 && (
            <PanelGroup title="Scatter" testId="scatter-group" open={open.scatter} onOpenChange={(v) => setOpen((o) => ({ ...o, scatter: v }))} active={active === "scatter"}>
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
                    activate("scatter");
                    runScatter();
                  }}
                >
                  Compute projection
                </button>
              </div>
              {projecting && (
                <p aria-live="polite">
                  <progress /> Projecting…
                </p>
              )}
            </PanelGroup>
          )}
          {st && params && params.method && (
            <PanelGroup title="Outliers" testId="outlier-group" open={open.outliers} onOpenChange={(v) => setOpen((o) => ({ ...o, outliers: v }))} active={active === "outliers"}>
              <OutlierControls o={outlierRun} onStart={() => activate("outliers")} />
            </PanelGroup>
          )}
        </>
      }
    >
    <section>
      <h2>
        Dedup — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {st && st.frames === 0 && <p>This feature has no frames yet — ingest some first.</p>}

      {active === "scatter" && (
        <div data-testid="scatter-view">
          {!scatter && !projecting && <p>Press <strong>Compute projection</strong> in the Scatter group to map this feature's frames in 2D.</p>}
          {scatter && (
            <>
              {colourNote && <p role="note" style={{ fontSize: 12 }}>{colourNote}</p>}
              <ScatterLegend colourBy={effectiveColour} classes={scatter.classes} />
              <Scatter
                key={genRef.current.gen}
                points={mapPoints}
                classes={scatter.classes}
                onSelect={setSelected}
                colourBy={effectiveColour}
                scores={outliers ? outlierShades(outliers) : undefined}
              />
              {selected && st && (
                <ScatterSelection
                  camera={camera}
                  feature={feature}
                  points={selected}
                  classes={scatter.classes}
                  grid={st.grid}
                  onGrid={(perPage, cols) =>
                    api
                      .dedupGridSettings(camera, feature, perPage, cols)
                      .then((g) => setSt((x) => (x ? { ...x, grid: g } : x)))
                      .catch((e: unknown) => setError(msg(e)))
                  }
                  onMark={(frame, m) => setOverrides((o) => ({ ...o, [frame]: m }))}
                  onRemoved={(frame) => {
                    setOverrides((o) => ({ ...o, [frame]: null }));
                    setNotice(`Deleted ${frame}. It stays on disk; see Classify → Show: Deleted.`);
                    load();
                  }}
                  onError={(m) => setError(m)}
                  onLabeled={(frames, cls) => {
                    setNotice(`Labeled ${frames.length} frame(s) as ${cls}.`);
                    setOverrides((o) => ({
                      ...o,
                      ...Object.fromEntries(
                        frames.map((f) => {
                          const pt = scatter.points.find((q) => q.frame === f);
                          const prev = o[f] ?? (pt ? { label: pt.label, golden: pt.golden } : { label: null, golden: null });
                          return [f, { label: cls, golden: prev.golden ? cls : null }];
                        }),
                      ),
                    }));
                    load();
                  }}
                  onDeleted={(r, frames) => {
                    setNotice(
                      `Deleted ${r.deleted} frame(s)` +
                        (r.cleared_labels || r.cleared_goldens ? ` · cleared ${r.cleared_labels} label(s) and ${r.cleared_goldens} golden mark(s)` : "") +
                        ". They stay on disk; see Classify → Show: Deleted.",
                    );
                    setOverrides((o) => ({ ...o, ...Object.fromEntries(frames.map((f) => [f, null])) }));
                    setSelected(null);
                    load();
                  }}
                />
              )}
              <p>
                <em>2D projection distorts distances — use it as a sanity check only.</em> Clustering stays in full-dimensional embedding space.{" "}
                {scatter.from_cache ? "(from cache)" : "(freshly projected)"}
              </p>
            </>
          )}
        </div>
      )}

      {active === "outliers" && st && params && params.method && (
        <OutlierResults
          o={outlierRun}
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

          {result.clusters.length > 0 ? (
            <>
              <h3>Clusters</h3>
              <p>The chosen representative stays visible in Classify. Every other member of the cluster will be muted on Apply mute.</p>
            </>
          ) : (
            <p>
              No clusters at the current sliders. Everything looks unique under this embedding at this radius — try a larger <em>epsilon</em>, a smaller{" "}
              <em>min points</em>, or a different backbone.
            </p>
          )}
          {st && (
            <ClusterBrowser
              camera={camera}
              feature={feature}
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
                if (scatter) runScatter();
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
            <button onClick={() => setConfirmClear(true)}>♻️ Unmute all for this feature</button>
          )}
        </div>
      )}
    </section>
    </SidePanel>
  );
}

type Mark = { label: string | null; golden: string | null };

/**
 * The frames inside the rectangle drawn on the scatter: a summary, the batch actions (label all as
 * a class, delete all), and then the same paged card grid used everywhere else, with the picture
 * viewer on click. Changes are reported up so the map can show them without being recomputed.
 */
function ScatterSelection({
  camera,
  feature,
  points,
  classes,
  grid,
  onGrid,
  onMark,
  onRemoved,
  onDeleted,
  onLabeled,
  onError,
}: {
  camera: string;
  feature: string;
  points: ScatterPoint[];
  classes: string[];
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onMark: (frame: string, mark: Mark) => void;
  onRemoved: (frame: string) => void;
  onDeleted: (r: DeleteResult, frames: string[]) => void;
  onLabeled: (frames: string[], cls: string) => void;
  onError: (m: string) => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [gone, setGone] = useState<Set<string>>(new Set());

  const hasClusters = points.some((p) => p.cluster !== null);
  const clusterKey = (p: ScatterPoint) => (p.cluster === null || p.cluster < 0 ? 1e9 : p.cluster);
  const sorted = useMemo(() => [...points].sort((a, b) => clusterKey(a) - clusterKey(b) || a.frame.localeCompare(b.frame)), [points]);

  // A new selection starts clean: no old confirmation, page, marks or removals.
  useEffect(() => {
    setPreview(null);
    setPage(1);
    setViewing(null);
    setGone(new Set());
    setMarks(Object.fromEntries(points.map((p) => [p.frame, { label: p.label, golden: p.golden }])));
  }, [points]);

  const rows = sorted.filter((p) => !gone.has(p.frame));
  const frames = rows.map((p) => p.frame);
  const markOf = (frame: string): Mark => marks[frame] ?? { label: null, golden: null };
  const perPage = grid.per_page;
  const nPages = Math.max(1, Math.ceil(rows.length / perPage));
  const cur = Math.min(page, nPages);
  const shown = rows.slice((cur - 1) * perPage, cur * perPage);

  const askDelete = () => {
    setBusy(true);
    api
      .deletePreview(camera, feature, frames)
      .then(setPreview)
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  const doLabel = (cls: string) => {
    setBusy(true);
    api
      .labelFrames(camera, feature, frames, cls, "Dedup")
      .then((r) => {
        setMarks((m) => Object.fromEntries(Object.entries(m).map(([f, v]) => [f, { label: frames.includes(f) ? cls : v.label, golden: frames.includes(f) && v.golden ? cls : v.golden }])));
        onLabeled(frames, cls);
        void r;
      })
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  const doDelete = () => {
    setBusy(true);
    api
      .deleteFrames(camera, feature, frames, note)
      .then((r) => {
        setPreview(null);
        setNote("");
        onDeleted(r, frames);
      })
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };

  // What the selection is made of: clusters when there is a clustering, labels otherwise.
  const counts = new Map<string, number>();
  for (const p of rows) {
    const k = hasClusters ? (p.cluster === null || p.cluster < 0 ? "unique" : `cluster ${p.cluster}`) : (markOf(p.frame).label ?? "unlabeled");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(" · ");

  async function act<T>(frame: string, call: () => Promise<T>, then: (r: T) => void) {
    setCardBusy(frame);
    try {
      then(await call());
    } catch (e) {
      onError(msg(e));
    } finally {
      setCardBusy(null);
    }
  }
  const keep = (r: { card: { frame: string; label: string | null; golden: string | null } }) => {
    const m = { label: r.card.label, golden: r.card.golden };
    setMarks((cur) => ({ ...cur, [r.card.frame]: m }));
    onMark(r.card.frame, m);
  };
  const remove = (frame: string) => {
    setGone((g) => new Set(g).add(frame));
    onRemoved(frame);
  };
  const cardOf = (frame: string): CardData => ({ frame, ...markOf(frame), deleted: false, leanings: {}, bars: null, cluster: null });
  const label = (frame: string, cls: string | null) => act(frame, () => api.setLabel(camera, feature, frame, cls), keep);
  const golden = (frame: string, on: boolean) => act(frame, () => api.setGolden(camera, feature, frame, on), keep);
  const del = (frame: string) => act(frame, () => api.deleteFrame(camera, feature, frame), () => remove(frame));

  return (
    <div data-testid="scatter-selection">
      <h4>{rows.length} frame(s) in the selected region</h4>
      {rows.length === 0 ? (
        <p>No frames inside the rectangle. Right-click to reset the view.</p>
      ) : (
        <>
          <p style={{ fontSize: 12 }}>{summary}</p>
          {preview === null ? (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "6px 0" }}>
              <div role="group" aria-label="Label the selection" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {classes.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={busy}
                    onClick={() => doLabel(c)}
                    style={{ background: classColor(c, classes), color: "#fff", borderColor: classColor(c, classes) }}
                  >
                    Label {rows.length} as {c}
                  </button>
                ))}
              </div>
              <button type="button" disabled={busy} onClick={askDelete} style={{ borderColor: "#c62828", color: "#c62828" }}>
                🗑 Delete these {rows.length} frame(s)…
              </button>
            </div>
          ) : (
            <div role="alertdialog" aria-label="Confirm delete" style={{ border: "1px solid #c33", padding: 8, margin: "6px 0" }}>
              <p style={{ margin: "0 0 6px" }}>
                Delete <strong>{preview.total}</strong> frame(s) on this camera, in <strong>every ROI</strong>? Of these, <strong>{preview.labeled}</strong>{" "}
                labeled and <strong>{preview.golden}</strong> golden lose their marks (a restore does not bring the marks back). Files stay on disk.
              </p>
              <label>
                Note (optional){" "}
                <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. foreign object" style={{ width: 260 }} />
              </label>{" "}
              <button type="button" disabled={busy} onClick={doDelete}>
                Yes — delete {preview.total}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          )}
          <Pager grid={{ page: cur, per_page: perPage, n_pages: nPages, total: rows.length }} settings={grid} onPage={setPage} onSettings={onGrid} where="selection top" />
          <ul style={{ display: "grid", gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gap: 8, padding: 0 }}>
            {shown.map((p) => (
              <Card
                key={p.frame}
                camera={camera}
                feature={feature}
                classes={classes}
                methods={[]}
                card={cardOf(p.frame)}
                busy={cardBusy === p.frame}
                fullSize
                onOpen={() => setViewing(p.frame)}
                caption={p.cluster === null ? undefined : p.cluster < 0 ? "unique" : `cluster ${p.cluster}${p.representative ? " · rep" : ""}`}
                onLabel={(cls) => label(p.frame, cls)}
                onGolden={(on) => golden(p.frame, on)}
                onDelete={() => del(p.frame)}
                onRestore={() => undefined}
              />
            ))}
          </ul>
          <Pager grid={{ page: cur, per_page: perPage, n_pages: nPages, total: rows.length }} settings={grid} onPage={setPage} onSettings={onGrid} where="selection bottom" />
          {viewing && (
            <FrameViewer
              camera={camera}
              frames={frames}
              start={viewing}
              classes={classes}
              marks={markOf}
              busy={cardBusy !== null}
              onLabel={label}
              onGolden={golden}
              onDelete={del}
              onShow={(f) => {
                const at = frames.indexOf(f);
                if (at >= 0) setPage(Math.floor(at / perPage) + 1);
              }}
              onClose={() => setViewing(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
