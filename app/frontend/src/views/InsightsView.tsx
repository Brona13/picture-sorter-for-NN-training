import { useCallback, useEffect, useState } from "react";
import { api, InsightsResponse } from "../api";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function InsightsView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<{ frames: number }>(jobId);
  const computing = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

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

  const load = useCallback(() => {
    if (!camera || !feature) return;
    api
      .insights(camera, feature)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature]);

  useEffect(() => {
    setData(null);
    setJobId(null);
    load();
  }, [load]);

  useEffect(() => {
    if (job?.status === "done") load();
    if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!camera) return <p>Select a camera.</p>;

  return (
    <section>
      <h2>
        Insights — {camera}
        {product ? ` › ${product}` : ""}
      </h2>
      {error && <p role="alert">{error}</p>}
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

      {data?.reason === "needs_two_golden_classes" && (
        <p>
          A confusion matrix needs goldens in at least two classes so the methods can produce a leaning. Currently only{" "}
          <strong>{data.goldens_in.join("/") || "none"}</strong> has references — add another in <strong>Classify</strong>, refresh, and come back.
        </p>
      )}
      {data?.reason === "no_held_out_labels" && (
        <p>No held-out labelled frames yet — every label is currently a ⭐golden. Label some non-golden frames in Classify and come back.</p>
      )}

      {data && !data.reason && (
        <>
          <button disabled={computing} onClick={() => api.classifyRefresh(camera, feature).then((j) => setJobId(j.id)).catch((e: unknown) => setError(msg(e)))}>
            🔄 Compute matrices
          </button>{" "}
          <small>
            Rows = your label · columns = method's leaning · {data.evaluable} held-out frames · ⭐ goldens excluded.
          </small>
          {computing && (
            <p aria-live="polite">
              <progress /> Computing insight matrices…
            </p>
          )}
          {!data.has_results && !computing && <p>Click Compute matrices to score frames and render the matrices.</p>}
          {data.has_results && (
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              {data.methods.map((m) => {
                const mm = data.matrices[m];
                if (!mm) return null;
                return (
                  <div key={m} data-testid={`matrix-${m}`}>
                    <strong>{m}</strong>
                    <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
                      <thead>
                        <tr>
                          <th></th>
                          {data.classes.map((c) => (
                            <th key={c} style={{ fontWeight: "normal", fontSize: 11, color: "#888" }}>
                              pred {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.classes.map((t) => (
                          <tr key={t}>
                            <th style={{ fontWeight: "normal", fontSize: 11, color: "#888", textAlign: "right" }}>true {t}</th>
                            {data.classes.map((p) => {
                              const v = mm.matrix[t][p];
                              const bg = v === 0 ? "transparent" : t === p ? "#C0DD97" : "#F7C1C1";
                              const fg = v === 0 ? "#888" : t === p ? "#173404" : "#501313";
                              return (
                                <td key={p} style={{ background: bg, color: fg, padding: "4px 8px", textAlign: "center", minWidth: 32 }}>
                                  {v}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <small>
                      Accuracy <strong>{mm.accuracy.toFixed(1)}%</strong> ({mm.correct}/{mm.total}){mm.skipped ? ` · ${mm.skipped} unscored` : ""}
                    </small>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
