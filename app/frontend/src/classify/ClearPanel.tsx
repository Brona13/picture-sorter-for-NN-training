import { useEffect, useState } from "react";
import { api, ClearPreview, GridQuery } from "../api";

interface Props {
  camera: string;
  query: GridQuery;
  revision: number;
  onCleared: (cleared: number, goldensSpared: number, counts: Record<string, number>) => void;
  onError: (m: string) => void;
}

/** Remove labels from every labeled frame in the current Show filter (all pages). */
export default function ClearPanel({ camera, query, revision, onCleared, onError }: Props) {
  const [preview, setPreview] = useState<ClearPreview | null>(null);
  const [withGoldens, setWithGoldens] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // A different filter or option cancels a pending confirmation.
  useEffect(() => setConfirming(false), [query, withGoldens]);

  useEffect(() => {
    let cancelled = false;
    api
      .clearPreview(camera, query)
      .then((p) => !cancelled && setPreview(p))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, query, revision]);

  if (!preview || preview.labeled + preview.goldens === 0) return null;
  const n = preview.labeled + (withGoldens ? preview.goldens : 0);

  return (
    <details>
      <summary>Clear labels in this view ({preview.labeled + preview.goldens} labeled)</summary>
      <p>
        Removes the label from <strong>{n}</strong> frame{n === 1 ? "" : "s"} in the current view (<em>{query.view}</em>) — all pages, not just the one
        you're looking at. Source frames are not touched.
      </p>
      {preview.goldens > 0 && (
        <label style={{ display: "block" }}>
          <input type="checkbox" checked={withGoldens} onChange={(e) => setWithGoldens(e.target.checked)} /> Also clear the {preview.goldens} golden
          {preview.goldens === 1 ? "" : "s"} in this view (the ⭐ mark is removed with the label)
        </label>
      )}
      {preview.goldens > 0 && !withGoldens && (
        <p>
          The {preview.goldens} golden{preview.goldens === 1 ? "" : "s"} in this view will be kept.
        </p>
      )}
      {!confirming ? (
        <button disabled={n === 0} onClick={() => setConfirming(true)}>
          Clear {n} label{n === 1 ? "" : "s"}…
        </button>
      ) : (
        <p>
          <strong>
            Clear {n} label{n === 1 ? "" : "s"}? This can't be undone — freeze a version first if you may want them back.
          </strong>{" "}
          <button
            onClick={() =>
              api
                .clearLabels(camera, query, withGoldens)
                .then((r) => {
                  setConfirming(false);
                  onCleared(r.cleared, r.goldens_spared, r.counts);
                })
                .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
            }
          >
            Yes, clear
          </button>{" "}
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </p>
      )}
    </details>
  );
}
