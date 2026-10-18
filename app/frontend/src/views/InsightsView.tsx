import { useCallback, useEffect, useState } from "react";
import { usePublishFeature, useSharedFeature } from "../SharedFeature";
import { api, CardData, InsightsResponse } from "../api";
import { PagerSettings } from "../classify/Pager";
import PictureGrid from "../classify/PictureGrid";
import { useJob } from "../useJob";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function InsightsView({ camera, product }: { camera: string; product?: string }) {
  const [features, setFeatures] = useState<{ feature: string; label: string }[]>([]);
  const [feature, setFeature] = useState("");
  const shared = useSharedFeature();
  usePublishFeature(feature, shared.publish);
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cell, setCell] = useState<{ method: string; t: string; p: string; items: CardData[]; classes: string[]; methods: string[]; cols: number } | null>(null);
  const [settings, setSettings] = useState<PagerSettings | null>(null);
  const [page, setPage] = useState(1);
  const job = useJob<{ frames: number }>(jobId);
  const computing = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

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

  // The same per-page / column choice as Classify (stored per camera and feature).
  useEffect(() => {
    setSettings(null);
    if (camera && feature)
      api
        .classifyState(camera, feature)
        .then((st) => setSettings(st.settings))
        .catch((e: unknown) => setError(msg(e)));
  }, [camera, feature]);

  function changeSettings(per_page: number, cols: number) {
    api
      .setGridSettings(camera, feature, per_page, cols)
      .then(() => {
        setSettings((s) => (s ? { ...s, per_page, cols } : s));
        setPage(1);
      })
      .catch((e: unknown) => setError(msg(e)));
  }

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
    setCell(null);
    load();
  }, [load]);

  useEffect(() => {
    if (job?.status === "done") {
      setCell(null);
      load();
    }
    if (job?.status === "error") setError(job.error);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Marks change in place; the matrix counts refresh, the open list keeps its cards until closed.
  const applyCard = (frame: string, card: { label: string | null; golden: string | null; deleted: boolean }) => {
    setCell((c) => (c ? { ...c, items: c.items.map((x) => (x.frame === frame ? { ...x, ...card } : x)) } : c));
    load();
  };

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
                                <td key={p} style={{ background: bg, padding: 0, minWidth: 32, outline: cell?.method === m && cell.t === t && cell.p === p ? "2px solid #333" : "none" }}>
                                  <button
                                    type="button"
                                    disabled={v === 0}
                                    title={`Show the ${v} frame(s) labeled ${t} that the method leans ${p}`}
                                    onClick={() =>
                                      api
                                        .insightsCell(camera, feature, m, t, p)
                                        .then((r) => {
                                          setCell({ method: m, t, p, ...r });
                                          setPage(1);
                                        })
                                        .catch((e: unknown) => setError(msg(e)))
                                    }
                                    style={{ all: "unset", display: "block", padding: "4px 8px", textAlign: "center", color: fg, cursor: v === 0 ? "default" : "pointer", textDecoration: v === 0 ? "none" : "underline" }}
                                  >
                                    {v}
                                  </button>
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
          {cell && settings && (
            <div data-testid="matrix-cell-frames">
              <h4>
                {cell.method}: true {cell.t} → predicted {cell.p} — {cell.items.length} frame(s){" "}
                <button type="button" onClick={() => setCell(null)}>
                  Close
                </button>
              </h4>
              {cell.items.length > 0 && (
                <PictureGrid
                  camera={camera}
                  feature={feature}
                  classes={cell.classes}
                  methods={cell.methods}
                  frames={cell.items.map((c) => c.frame)}
                  cardOf={(f) => cell.items.find((c) => c.frame === f)!}
                  via="Insights"
                  grid={settings}
                  onGrid={changeSettings}
                  page={page}
                  onPage={setPage}
                  where="insights"
                  restorable
                  onChanged={applyCard}
                  onDeleted={applyCard}
                  onError={setError}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
