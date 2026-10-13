import { useEffect, useState } from "react";
import { api, BulkPreview, GridQuery } from "../api";

const MODES = [
  { id: "leaning", label: "Frames leaning a class (confident ones)" },
  { id: "ordinary", label: "Most ordinary (lowest novelty)" },
  { id: "uncertain", label: "Most uncertain (smallest margin)" },
];

interface Props {
  camera: string;
  query: GridQuery;
  classes: string[];
  revision: number;
  onLabeled: (n: number, cls: string, counts: Record<string, number>) => void;
  onError: (m: string) => void;
}

export default function BulkPanel({ camera, query, classes, revision, onLabeled, onError }: Props) {
  const [mode, setMode] = useState("leaning");
  const [leanCls, setLeanCls] = useState(classes[0] ?? "");
  const [threshold, setThreshold] = useState<number | null>(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);

  // Changing the mode/class resets the slider to its lowest position.
  useEffect(() => setThreshold(null), [mode, leanCls, query.feature, query.view, query.rank, query.order]);

  useEffect(() => {
    let cancelled = false;
    api
      .bulkPreview(camera, query, mode, mode === "leaning" ? leanCls : null, threshold)
      .then((p) => !cancelled && setPreview(p))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, query, mode, leanCls, threshold, revision]);

  if (!preview || preview.selectable === 0) return null;
  const picked = preview.selected;

  return (
    <details>
      <summary>Bulk-label a selection ({preview.selectable} matching)</summary>
      <fieldset>
        <legend>Select</legend>
        {MODES.map((m) => (
          <label key={m.id} style={{ display: "block" }}>
            <input type="radio" name="bulk-mode" checked={mode === m.id} onChange={() => setMode(m.id)} /> {m.label}
          </label>
        ))}
      </fieldset>
      {mode === "leaning" && (
        <label>
          Leaning toward{" "}
          <select value={leanCls} onChange={(e) => setLeanCls(e.target.value)}>
            {classes.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      {preview.hi > preview.lo ? (
        <label style={{ display: "block" }}>
          {mode === "leaning" ? "Minimum confidence (margin between the two classes)" : "Select everything at or below"}{" "}
          <input
            type="range"
            aria-label="Threshold"
            min={preview.lo}
            max={preview.hi}
            step={(preview.hi - preview.lo) / 100}
            value={preview.threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />{" "}
          {preview.threshold.toFixed(4)}
        </label>
      ) : (
        mode === "leaning" && (
          <p>
            No frames lean <strong>{leanCls}</strong> — you need goldens marked on <em>both</em> sides for leanings to exist.
          </p>
        )
      )}
      <p>
        <strong>{picked}</strong> of {preview.selectable} matching frames selected — labelling applies to <em>all</em> of them, not just the
        page you're looking at.
      </p>
      {classes.map((c) => (
        <button
          key={c}
          disabled={picked === 0}
          onClick={() =>
            api
              .bulkLabel(camera, query, mode, mode === "leaning" ? leanCls : null, threshold, c)
              .then((r) => onLabeled(r.labeled, c, r.counts))
              .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
          }
        >
          Label selection {c}
        </button>
      ))}
    </details>
  );
}
