import { ReactNode, useCallback, useEffect, useState } from "react";
import { api, DedupParams, DedupResult, DedupState, OutlierResult } from "../api";
import ClusterBrowser, { Marks } from "../classify/ClusterBrowser";
import { OutlierControls, OutlierResults, useOutliers } from "../classify/OutlierPanel";
import { ColourBy } from "../classify/Scatter";
import { OUTLIERS_INFO, SCATTER_INFO } from "../classify/toolInfo";
import { effectiveColour, ScatterMapView, useScatterMap } from "../classify/ScatterWorkbench";
import InfoTip from "../InfoTip";
import SidePanel from "../SidePanel";
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

const CLUSTERS_INFO = (
  <>
    Groups near-identical pictures: DBSCAN on the ResNet embeddings. <strong>Epsilon</strong> is how close two pictures must be to count as neighbours and{" "}
    <strong>Min points</strong> how many neighbours make a cluster. The chosen representative of each cluster stays visible in Classify; every other member of the
    cluster is muted when you press <strong>Apply mute</strong>. Nothing is deleted. The mutes belong to this Dedup box; a golden is never muted.
  </>
);
/** The three duplicate tools; the top bar picks one, and its controls fill the options panel and its results the centre. */
export type DedupTool = "scatter" | "clusters" | "outliers";
const TITLES: Record<DedupTool, string> = { scatter: "Scatter", clusters: "Clusters", outliers: "Outliers" };

/** Each frame's outlier score scaled to [0, 1] against the 95th percentile, so one extreme frame cannot wash out the rest. */
export function outlierShades(r: OutlierResult): Record<string, number> {
  const top = Math.max(r.summary.p95, 1e-9);
  return Object.fromEntries(r.scores.map((s) => [s.frame, Math.min(1, s.score / top)]));
}

export default function DedupView({
  camera,
  box,
  tool = "scatter",
}: {
  camera: string;
  /** The Dedup box to open (from the Chain); else the first one. */
  box?: string;
  tool?: DedupTool;
}) {
  // The pages work on one Dedup box of the Chain (its id is the "feature" of the API).
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [boxesLoaded, setBoxesLoaded] = useState(false);
  const [st, setSt] = useState<DedupState | null>(null);
  const [params, setParams] = useState<DedupParams | null>(null);
  const [result, setResult] = useState<DedupResult | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [clusterJob, setClusterJob] = useState<string | null>(null);
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

  useEffect(() => {
    setSt(null);
    setResult(null);
    setOutliers(null);
    setPicks({});
    setClusterJob(null);
    setNotice(null);
    setConfirmClear(false);
    load();
  }, [load]);

  useEffect(() => {
    if (cj?.status === "done" && cj.result) {
      setResult(cj.result);
      setPicks({});
      if (map.scatter) map.run(); // its cluster colours follow the new clustering (the projection itself is cached)
    } else if (cj?.status === "error") setError(cj.error);
  }, [cj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(patch: Partial<DedupParams>) {
    if (!params) return;
    const next = { ...params, ...patch };
    setParams(next);
    api.dedupSaveSettings(camera, feature, next).catch((e: unknown) => setError(msg(e)));
  }

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
                  onClick={() => {
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
              {projecting && (
                <p aria-live="polite">
                  <progress /> Projecting…
                </p>
              )}
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
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {boxesLoaded && features.length === 0 && <p>There is no Dedup box yet. Add one on the Chain (the Dedup tile) and connect it.</p>}
      {st && st.frames === 0 && <p>This Dedup box has no pictures yet: ingest some, or label some for the Classifier it reads.</p>}

      {active === "scatter" && (
        <div data-testid="scatter-view">
          {!scatter && !projecting && <p>Press <strong>Compute projection</strong> in the options panel to map this box's pictures in 2D.</p>}
          {scatter && (
            <>
              {colourNote && <p role="note" style={{ fontSize: 12 }}>{colourNote}</p>}
              <ScatterMapView
                camera={camera}
                feature={feature}
                map={map}
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

          {result.clusters.length === 0 && (
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
