import { useEffect, useState } from "react";
import { api, GridQuery, SuggestResponse } from "../api";
import { classColor } from "./colors";
import { thumbUrl } from "./Card";

interface Props {
  camera: string;
  query: GridQuery;
  classes: string[];
  revision: number;
  onPromoted: (frame: string, cls: string, counts: Record<string, number>) => void;
  onError: (m: string) => void;
}

export default function SuggestPanel({ camera, query, classes, revision, onPromoted, onError }: Props) {
  const [n, setN] = useState<number | null>(null);
  const [data, setData] = useState<SuggestResponse | null>(null);
  const [open, setOpen] = useState(false);

  const base: GridQuery = { ...query, auto_preview: false, auto_classes: null, auto_min_margin: null };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .suggestGoldens(camera, base, n ?? 10)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, camera, query.feature, query.view, query.rank, query.order, query.show_muted, n, revision]);

  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Suggested goldens (most-uncertain, spread for diversity)</summary>
      <p>
        The frames the machine is least sure about under <strong>{query.rank}</strong>, spread across the ambiguity band by embedding-space
        diversity. One click labels <em>and</em> promotes to golden — sharpens class separation the fastest.
      </p>
      {data && !data.available && <p>No unlabeled candidates match — refresh scores or add more goldens (at least two classes need goldens).</p>}
      {data?.available && (
        <>
          <label>
            How many picks{" "}
            <input
              type="range"
              aria-label="How many picks"
              min={data.n_min}
              max={data.n_max}
              value={n ?? data.default_n}
              onChange={(e) => setN(Number(e.target.value))}
            />{" "}
            {n ?? data.default_n}
          </label>
          <p>
            Showing <strong>{data.picks.length}</strong> pick(s).{" "}
            {data.backbone ? `Diversity via ${data.backbone}.` : "No ResNet available — top-by-margin only."} See where they land on the Dedup
            view's 2D scatter.
          </p>
          <ul style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, padding: 0, listStyle: "none" }}>
            {data.picks.map((p) => (
              <li key={p.frame} data-testid={`suggest-${p.frame}`} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 6 }}>
                <img src={thumbUrl(camera, p.frame, query.feature)} alt={p.frame} style={{ width: "100%", display: "block" }} />
                {p.bars && (
                  <div style={{ fontSize: 10, opacity: 0.7 }}>
                    {p.bars.rows.map((r) => `${r.cls} ${(r.rel * 100).toFixed(0)}%`).join(" · ")}
                    {p.bars.close_call ? " · ⚠ close call" : ""}
                  </div>
                )}
                <code style={{ fontSize: 11 }}>{p.frame}</code>
                <div style={{ display: "flex", gap: 4 }}>
                  {classes.map((c) => (
                    <button
                      key={c}
                      style={{ borderColor: classColor(c, classes) }}
                      onClick={() =>
                        api
                          .promote(camera, query.feature, p.frame, c)
                          .then((r) => onPromoted(p.frame, c, r.counts))
                          .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
                      }
                    >
                      ⭐ {c}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
