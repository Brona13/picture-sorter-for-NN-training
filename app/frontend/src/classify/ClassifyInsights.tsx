import { useEffect, useState } from "react";
import { api, InsightsResponse } from "../api";
import { methodTag } from "../methodTags";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The confusion matrix of every method in use, for one Classifier (step 2): rows = your label, columns = the method's leaning,
 * goldens left out, so every other labeled picture is a test of what the goldens teach. A cell is a button: it turns the Grid
 * to that cell's Show entry (`onPick`), so its pictures come in the one Grid, with its paging, order, keys and the coloured
 * borders, and the Show box says which cell is open. Read again whenever `revision` changes (a label, golden or refresh).
 */
export default function ClassifyInsights({
  camera,
  feature,
  revision,
  onPick,
}: {
  camera: string;
  feature: string;
  revision: number;
  /** The Show entry of the clicked cell. */
  onPick: (view: string) => void;
}) {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .insights(camera, feature)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(msg(e)));
    return () => {
      cancelled = true;
    };
  }, [camera, feature, revision]);

  return (
    <section data-testid="classify-insights">
      {error && <p role="alert">{error}</p>}
      {data?.reason === "needs_two_golden_classes" && (
        <p>
          A confusion matrix needs goldens in at least two classes, so the methods can lean one way or the other. Only{" "}
          <strong>{data.goldens_in.join("/") || "none"}</strong> has references: mark a golden in the other class in the Grid, refresh the scores, and come back.
        </p>
      )}
      {data?.reason === "no_held_out_labels" && <p>No test pictures yet: every labeled picture is a ⭐golden. Label some pictures that are not goldens, and come back.</p>}
      {data && !data.reason && !data.has_results && <p>No scores yet. Click Refresh scores to evaluate the pictures.</p>}
      {data && !data.reason && data.has_results && (
        <>
          <small>
            Rows = your label · columns = the method's leaning · {data.evaluable} test pictures · ⭐ goldens and muted pictures left out. A number opens
            those pictures in the Grid.
          </small>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 8 }}>
            {data.methods.map((m) => {
              const mm = data.matrices[m];
              if (!mm) return null;
              return (
                <div key={m} data-testid={`matrix-${m}`}>
                  <strong>{methodTag(m)}</strong>
                  <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
                    <thead>
                      <tr>
                        <th></th>
                        {data.classes.map((c) => (
                          <th key={c} style={{ fontWeight: "normal", fontSize: 11, color: "#888" }}>
                            model says {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.classes.map((t) => (
                        <tr key={t}>
                          <th style={{ fontWeight: "normal", fontSize: 11, color: "#888", textAlign: "right" }}>labeled {t}</th>
                          {data.classes.map((p) => {
                            const v = mm.matrix[t][p];
                            const bg = v === 0 ? "transparent" : t === p ? "#C0DD97" : "#F7C1C1";
                            const fg = v === 0 ? "#888" : t === p ? "#173404" : "#501313";
                            const view = mm.views[t][p];
                            return (
                              <td key={p} style={{ background: bg, padding: 0, minWidth: 32 }}>
                                <button
                                  type="button"
                                  disabled={v === 0}
                                  title={`Open the ${v} picture(s) in the Grid: ${view}`}
                                  onClick={() => onPick(view)}
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
        </>
      )}
    </section>
  );
}
