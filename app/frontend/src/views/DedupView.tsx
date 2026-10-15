import { useCallback, useEffect, useRef, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, DedupParams, DedupResult, DedupState, DeletePreview, DeleteResult, OutlierResult, ScatterPoint, ScatterResult } from "../api";
import { thumbUrl } from "../classify/Card";
import ClusterBrowser, { Marks } from "../classify/ClusterBrowser";
import OutlierPanel from "../classify/OutlierPanel";
import Scatter from "../classify/Scatter";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_SELECTED = 60;

export function drift(existing: DedupParams, now: DedupParams): string[] {
  const bits: string[] = [];
  if (existing.method !== now.method) bits.push(`embedding '${existing.method}' → '${now.method}'`);
  if (Math.abs(existing.epsilon - now.epsilon) > 1e-9) bits.push(`ε ${existing.epsilon.toFixed(3)} → ${now.epsilon.toFixed(3)}`);
  if (existing.min_points !== now.min_points) bits.push(`minPts ${existing.min_points} → ${now.min_points}`);
  return bits;
}

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
  const [marks, setMarks] = useState<Marks>({});
  const [outliers, setOutliers] = useState<OutlierResult | null>(null);
  const [colourByOutlier, setColourByOutlier] = useState(true);
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

  useEffect(() => setSelected(null), [scatter]);
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
      setScatter(null);
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

  if (!camera) return <p>Select a camera.</p>;
  if (st?.reason === "no_embeddings")
    return (
      <p>
        Perceptual dedup requires ResNet embeddings. Install the neural dependencies (<code>pip install -r requirements-embedding.txt</code>), then return here.
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

  return (
    <section>
      <h2>
        Dedup — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

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

      {st && st.frames === 0 && <p>This feature has no frames yet — ingest some first.</p>}
      {st && st.frames > 0 && params && (
        <>
          <p>
            <strong>{st.frames} frame(s)</strong> in scope. DBSCAN groups near-identical cutouts on their ResNet embeddings; the representative of each
            cluster stays visible in Classify, the rest are muted (never deleted).
          </p>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <label>
              Embedding{" "}
              <select value={params.method} onChange={(e) => change({ method: e.target.value })}>
                {st.backbones.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label>
              Epsilon (neighborhood radius){" "}
              <input
                type="range"
                aria-label="Epsilon"
                min={st.ranges.epsilon[0]}
                max={st.ranges.epsilon[1]}
                step={0.001}
                value={params.epsilon}
                onChange={(e) => change({ epsilon: Number(e.target.value) })}
              />{" "}
              {params.epsilon.toFixed(3)}
            </label>
            <label>
              Min points{" "}
              <input
                type="range"
                aria-label="Min points"
                min={st.ranges.min_points[0]}
                max={st.ranges.min_points[1]}
                step={1}
                value={params.min_points}
                onChange={(e) => change({ min_points: Number(e.target.value) })}
              />{" "}
              {params.min_points}
            </label>
          </div>
          <div>
            <button
              disabled={clustering}
              onClick={() => {
                setNotice(null);
                api.dedupCluster(camera, feature, params).then((j) => setClusterJob(j.id)).catch((e: unknown) => setError(msg(e)));
              }}
            >
              🔍 Cluster
            </button>{" "}
            <button
              disabled={bits.length === 0}
              onClick={() => result && change({ ...result.params })}
              title={result ? "Restore sliders to the values used by the last computed clustering." : "Nothing to revert to — run a cluster first."}
            >
              ↺ Revert sliders
            </button>{" "}
            <small>Neural device: {st.device_label} · vectors are cached — first pass over a new batch is the slow one.</small>
            {clustering && (
              <p aria-live="polite">
                <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Embedding {Number(progress.done ?? 0)}/
                {Number(progress.total ?? 0)}
              </p>
            )}
          </div>
          {result && bits.length > 0 && (
            <p role="status">
              ⚠ <strong>Sliders changed since the last cluster</strong> — clusters below still show the previous run ({bits.join(", ")}). Click{" "}
              <strong>🔍 Cluster</strong> to recompute, or <strong>↺ Revert sliders</strong> to match what's shown.
            </p>
          )}
        </>
      )}

      {st && params && params.method && (
        <OutlierPanel
          camera={camera}
          feature={feature}
          method={params.method}
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
          onResult={setOutliers}
          onError={setError}
        />
      )}

      {result && (
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

          {result.summary.total >= 2 && (
            <details>
              <summary>2D scatter (sanity check)</summary>
              <fieldset>
                <legend>Projection</legend>
                {(st?.projections ?? []).map((p) => (
                  <label key={p} style={{ marginRight: 12 }}>
                    <input type="radio" name="projection" checked={projection === p} onChange={() => setProjection(p)} /> {p}
                  </label>
                ))}
              </fieldset>
              <button
                disabled={projecting}
                onClick={() => api.dedupScatter(camera, feature, projection).then((j) => setScatterJob(j.id)).catch((e: unknown) => setError(msg(e)))}
              >
                Compute projection
              </button>
              {projecting && (
                <p aria-live="polite">
                  <progress /> Projecting…
                </p>
              )}
              {scatter && (
                <>
                  {outliers && (
                    <label>
                      <input type="checkbox" checked={colourByOutlier} onChange={(e) => setColourByOutlier(e.target.checked)} /> Colour by outlier score (k = {outliers.k}; pale =
                      typical, dark red = most isolated)
                    </label>
                  )}
                  <Scatter
                    key={genRef.current.gen}
                    points={scatter.points}
                    classes={scatter.classes}
                    onSelect={setSelected}
                    scores={outliers && colourByOutlier ? outlierShades(outliers) : undefined}
                  />
                  {selected && (
                    <ScatterSelection
                      camera={camera}
                      feature={feature}
                      points={selected}
                      onError={(m) => setError(m)}
                      onDeleted={(r) => {
                        setNotice(
                          `Deleted ${r.deleted} frame(s)` +
                            (r.cleared_labels || r.cleared_goldens ? ` · cleared ${r.cleared_labels} label(s) and ${r.cleared_goldens} golden mark(s)` : "") +
                            ". They stay on disk; see Classify → Show: Deleted.",
                        );
                        setSelected(null);
                        load();
                        api.dedupScatter(camera, feature, projection).then((j) => setScatterJob(j.id)).catch((e: unknown) => setError(msg(e)));
                      }}
                    />
                  )}
                  <p>
                    <em>2D projection distorts distances — use for sanity check only.</em> Clustering decisions above stay in full-dimensional embedding
                    space. {scatter.from_cache ? "(from cache)" : "(freshly projected)"}
                  </p>
                </>
              )}
            </details>
          )}

          {result.clusters.length > 0 ? (
            <>
              <h3>Clusters</h3>
              <p>The chosen representative stays visible in Classify. Every other member of the cluster will be muted on Apply.</p>
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
                if (scatter) api.dedupScatter(camera, feature, projection).then((j) => setScatterJob(j.id)).catch((e: unknown) => setError(msg(e)));
              }}
            />
          )}
          {result.clusters.length > 0 && (
            <p>
              <button
                disabled={wouldMute === 0}
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
                🔇 Apply — mute {wouldMute} frame(s)
              </button>
            </p>
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
  );
}

function ScatterSelection({
  camera,
  feature,
  points,
  onDeleted,
  onError,
}: {
  camera: string;
  feature: string;
  points: ScatterPoint[];
  onDeleted: (r: DeleteResult) => void;
  onError: (m: string) => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const frames = points.map((p) => p.frame);
  // A new selection must never reuse the confirmation (and its counts) of an older one.
  useEffect(() => setPreview(null), [points]);
  const askDelete = () => {
    setBusy(true);
    api
      .deletePreview(camera, feature, frames)
      .then(setPreview)
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
        onDeleted(r);
      })
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  const sorted = [...points].sort((a, b) => (a.cluster < 0 ? 1e9 : a.cluster) - (b.cluster < 0 ? 1e9 : b.cluster) || a.frame.localeCompare(b.frame));
  const counts = new Map<number, number>();
  for (const p of points) counts.set(p.cluster, (counts.get(p.cluster) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort((a, b) => (a[0] < 0 ? 1e9 : a[0]) - (b[0] < 0 ? 1e9 : b[0]))
    .map(([c, n]) => `${c < 0 ? "unique" : `cluster ${c}`}: ${n}`)
    .join(" · ");
  return (
    <div data-testid="scatter-selection">
      <h4>{points.length} frame(s) in the selected region</h4>
      {points.length === 0 ? (
        <p>No frames inside the rectangle. Right-click to reset the view.</p>
      ) : (
        <>
          <p style={{ fontSize: 12 }}>{summary}</p>
          {preview === null ? (
            <p>
              <button type="button" disabled={busy} onClick={askDelete}>
                🗑 Delete these {points.length} frame(s)…
              </button>
            </p>
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
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {sorted.slice(0, MAX_SELECTED).map((p) => (
              <figure key={p.frame} style={{ margin: 0, width: 110 }}>
                <img src={thumbUrl(camera, p.frame, feature)} alt={p.frame} style={{ width: "100%" }} />
                <figcaption style={{ fontSize: 11 }}>
                  {p.representative ? "⭐ " : ""}
                  {p.frame}
                  <br />
                  {p.cluster < 0 ? "unique" : `cluster ${p.cluster}`}
                  {p.golden ? ` · golden ${p.golden}` : ""}
                </figcaption>
              </figure>
            ))}
          </div>
          {points.length > MAX_SELECTED && <p>…and {points.length - MAX_SELECTED} more — zoom in further to see them.</p>}
        </>
      )}
    </div>
  );
}
