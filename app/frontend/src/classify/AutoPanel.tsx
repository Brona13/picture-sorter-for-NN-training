import { useEffect, useState } from "react";
import { api, AutoPreview, GridQuery } from "../api";

export interface AutoFilter {
  on: boolean;
  classes: string[];
  minMargin: number | null;
}

interface Props {
  camera: string;
  query: GridQuery;
  allClasses: string[];
  revision: number;
  filter: AutoFilter;
  onFilter: (f: AutoFilter) => void;
  onApplied: (n: number, counts: Record<string, number>) => void;
  onError: (m: string) => void;
}

export default function AutoPanel({ camera, query, allClasses, revision, filter, onFilter, onApplied, onError }: Props) {
  const [preview, setPreview] = useState<AutoPreview | null>(null);
  const { classes, minMargin } = filter;
  // The preview is computed without its own grid filter; strip it so toggling "show" doesn't feed back.
  const base: GridQuery = { ...query, auto_preview: false, auto_classes: null, auto_min_margin: null };

  useEffect(() => {
    let cancelled = false;
    api
      .autoPreview(camera, base, classes, minMargin)
      .then((p) => !cancelled && setPreview(p))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, query.feature, query.view, query.rank, query.order, query.show_muted, classes, minMargin, revision]);

  if (!preview || preview.candidates === 0) return null;
  const set = (patch: Partial<AutoFilter>) => onFilter({ ...filter, ...patch });

  return (
    <details>
      <summary>Auto-assign by leaning ({preview.candidates} unlabelled candidates)</summary>
      <p>
        Fills in unlabelled frames using each frame's <strong>{query.rank}</strong> leaning. Nothing is written until you press{" "}
        <strong>Confirm</strong>.
      </p>
      <fieldset>
        <legend>Include only these classes</legend>
        {allClasses.map((c) => (
          <label key={c} style={{ marginRight: 8 }}>
            <input
              type="checkbox"
              checked={classes.includes(c)}
              onChange={(e) => set({ classes: e.target.checked ? [...classes, c] : classes.filter((x) => x !== c) })}
            />{" "}
            {c}
          </label>
        ))}
      </fieldset>
      {preview.hi > preview.lo && (
        <label style={{ display: "block" }}>
          Minimum confidence (margin between top two classes){" "}
          <input
            type="range"
            aria-label="Minimum confidence"
            min={preview.lo}
            max={preview.hi}
            step={(preview.hi - preview.lo) / 100}
            value={preview.min_margin}
            onChange={(e) => set({ minMargin: Number(e.target.value) })}
          />{" "}
          {preview.min_margin.toFixed(4)}
        </label>
      )}
      <p>
        <strong>Preview — {preview.total} frame(s) will be labelled:</strong>
      </p>
      <ul>
        {preview.per_class.map((p) => (
          <li key={p.cls}>
            <code>{p.cls}</code> —{" "}
            {p.count > 0 ? (
              <>
                <strong>{p.count}</strong> frames · avg margin {p.avg_margin?.toFixed(4)}
              </>
            ) : (
              "—"
            )}
          </li>
        ))}
      </ul>
      <label>
        <input type="checkbox" checked={filter.on} disabled={preview.total === 0} onChange={(e) => set({ on: e.target.checked })} /> Show these{" "}
        {preview.total} in the grid below
      </label>
      <div>
        <button
          disabled={preview.total === 0}
          onClick={() =>
            api
              .autoApply(camera, base, classes, minMargin)
              .then((r) => onApplied(r.labeled, r.counts))
              .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
          }
        >
          ✅ Confirm auto-assignment of {preview.total} frame(s)
        </button>
      </div>
    </details>
  );
}
