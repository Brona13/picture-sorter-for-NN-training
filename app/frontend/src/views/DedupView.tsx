import { useCallback, useEffect, useState } from "react";
import { api, DedupParams, DedupResult, DedupState, ScatterResult } from "../api";
import { thumbUrl } from "../classify/Card";
import Scatter from "../classify/Scatter";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_SHOWN = 24;

export function drift(existing: DedupParams, now: DedupParams): string[] {
  const bits: string[] = [];
  if (existing.method !== now.method) bits.push(`embedding '${existing.method}' → '${now.method}'`);
  if (Math.abs(existing.epsilon - now.epsilon) > 1e-9) bits.push(`ε ${existing.epsilon.toFixed(3)} → ${now.epsilon.toFixed(3)}`);
  if (existing.min_points !== now.min_points) bits.push(`minPts ${existing.min_points} → ${now.min_points}`);
  return bits;
}

export default function DedupView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [st, setSt] = useState<DedupState | null>(null);
  const [params, setParams] = useState<DedupParams | null>(null);
  const [result, setResult] = useState<DedupResult | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [clusterJob, setClusterJob] = useState<string | null>(null);
  const [scatterJob, setScatterJob] = useState<string | null>(null);
  const [projection, setProjection] = useState("umap");
  const [scatter, setScatter] = useState<ScatterResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cj = useJob<DedupResult>(clusterJob);
  const sj = useJob<ScatterResult>(scatterJob);
  const clustering = clusterJob !== null && (cj === null || cj.status === "queued" || cj.status === "running");
  const projecting = scatterJob !== null && (sj === null || sj.status === "queued" || sj.status === "running");

  useEffect(() => {
    if (!camera) return;
    setFeature("");
    api
      .versionFeatures(camera, product)
      .then((f) => {
        setFeatures(f);
        setFeature(f[0]?.feature ?? "");
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
  const currentRep = (cid: number, dflt: string) => picks[cid] ?? dflt;
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
                  <Scatter points={scatter.points} classes={scatter.classes} />
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
              {result.clusters.map((c, i) => {
                const rep = currentRep(c.id, c.representative);
                return (
                  <details key={c.id} open={i === 0}>
                    <summary>
                      Cluster {c.id} — {c.members.length} frames · rep: {rep}
                    </summary>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {c.members.slice(0, MAX_SHOWN).map((f) => (
                        <figure key={f} style={{ margin: 0, width: 110 }}>
                          <img src={thumbUrl(camera, f, feature)} alt={f} style={{ width: "100%" }} />
                          <figcaption style={{ fontSize: 11 }}>{f === rep ? "⭐ rep" : f}</figcaption>
                        </figure>
                      ))}
                    </div>
                    {c.members.length > MAX_SHOWN && <p>…and {c.members.length - MAX_SHOWN} more members not shown.</p>}
                    <fieldset>
                      <legend>Keep as representative</legend>
                      {c.members.map((f) => (
                        <label key={f} style={{ marginRight: 10 }}>
                          <input type="radio" name={`rep-${c.id}`} checked={rep === f} onChange={() => setPicks((p) => ({ ...p, [c.id]: f }))} /> {f}
                        </label>
                      ))}
                    </fieldset>
                  </details>
                );
              })}
              <button
                disabled={wouldMute === 0}
                onClick={() =>
                  api
                    .dedupApply(camera, feature, picks)
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
            </>
          ) : (
            <p>
              No clusters at the current sliders. Everything looks unique under this embedding at this radius — try a larger <em>epsilon</em>, a smaller{" "}
              <em>min points</em>, or a different backbone.
            </p>
          )}
          {result.noise_frames.length > 0 && (
            <details>
              <summary>
                Unique (noise) — {result.noise_frames.length} frames (never muted)
              </summary>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {result.noise_frames.slice(0, 20).map((f) => (
                  <figure key={f} style={{ margin: 0, width: 110 }}>
                    <img src={thumbUrl(camera, f, feature)} alt={f} style={{ width: "100%" }} />
                    <figcaption style={{ fontSize: 11 }}>{f}</figcaption>
                  </figure>
                ))}
              </div>
              {result.noise_frames.length > 20 && <p>…and {result.noise_frames.length - 20} more.</p>}
            </details>
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
