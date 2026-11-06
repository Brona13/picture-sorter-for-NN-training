import { useEffect, useState } from "react";
import { api, InsightsResponse } from "../api";
import { methodTag } from "../methodTags";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The confusion matrix of a step-2 Classifier for the one method it is made for (ResNet50): rows = your label, columns = what
 * the method says, goldens and muted pictures left out, so every other labeled picture is a test of what the goldens teach.
 * It is the content of the first region of the options panel. A number is a button: it turns the Grid to that cell's Show entry
 * (`onPick`), so its pictures come in the one Grid and the Show box says which cell is open. Read again whenever `revision`
 * changes (a refresh of the scores, a label, a golden); greyed out while `outdated` (goldens or pictures changed since the last refresh).
 */
export default function ClassifyInsights({
  camera,
  feature,
  revision,
  outdated,
  onPick,
}: {
  camera: string;
  feature: string;
  revision: number;
  /** The scores are older than the goldens or the pictures: the numbers are shown, greyed out, with a note. */
  outdated: boolean;
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

  const hint = (text: string) => (
    <p role="note" className="muted" data-testid="matrix-hint" style={{ margin: "4px 0" }}>
      {text}
    </p>
  );
  const method = data?.methods[0];
  const mm = method ? data?.matrices[method] : undefined;
  return (
    <div data-testid="classify-insights">
      {error && <p role="alert">{error}</p>}
      {data?.reason === "method_off" && hint("ResNet50 is not switched on (Configuration), so there is no matrix.")}
      {data?.reason === "needs_two_golden_classes" && hint(`Needs goldens in both classes (only ${data.goldens_in.join("/") || "none"} has them) and scores.`)}
      {data?.reason === "no_held_out_labels" && hint("No test pictures yet: every labeled picture is a golden.")}
      {data && !data.reason && !data.has_results && hint("No scores yet: click Refresh scores.")}
      {data && !data.reason && data.has_results && method && mm && (
        <div data-testid={`matrix-${method}`} data-outdated={outdated ? "true" : "false"} style={{ opacity: outdated ? 0.45 : 1 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 2, fontSize: 12 }}>
            <thead>
              <tr>
                <th></th>
                {data.classes.map((c) => (
                  <th key={c} style={{ fontWeight: "normal", fontSize: 11, color: "#888" }}>
                    says {c}
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
            {methodTag(method)} · accuracy <strong>{mm.accuracy.toFixed(1)}%</strong> ({mm.correct}/{mm.total}){mm.skipped ? ` · ${mm.skipped} unscored` : ""}
          </small>
        </div>
      )}
      {data && !data.reason && data.has_results && outdated && hint("Outdated: goldens or pictures changed since the last refresh. Refresh scores to update.")}
    </div>
  );
}
