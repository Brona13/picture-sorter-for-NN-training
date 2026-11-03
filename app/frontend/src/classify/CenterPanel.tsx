import { useEffect, useState } from "react";
import { api, CenterResponse, GridQuery } from "../api";
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

/**
 * The centers of the pictures in view: the densest spots of the embedding, one per look. Set the view to "Labeled OK" and these are
 * the centers of OK; set it to "Labeled NG" for NG. Needs no goldens, so it is the first golden to pick. A picture that has a label
 * can only become a golden of that label.
 */
export default function CenterPanel({ camera, query, classes, revision, onPromoted, onError }: Props) {
  const [n, setN] = useState(3);
  const [data, setData] = useState<CenterResponse | null>(null);
  const [open, setOpen] = useState(false);

  const base: GridQuery = { ...query, auto_preview: false, auto_classes: null, auto_min_margin: null };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    api
      .suggestCenter(camera, base, n)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, camera, query.feature, query.view, query.rank, query.show_muted, n, revision]);

  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Suggested center (the typical pictures of the view)</summary>
      <p>
        The densest spots among the pictures of the current view <strong>{query.view}</strong>, found in the embedding space: one per look, the main
        crowd first. Choose the view <em>Labeled OK</em> or <em>Labeled NG</em> to get the center of that class. No goldens are needed.
      </p>
      <label>
        How many centers{" "}
        <input type="range" aria-label="How many centers" min={1} max={10} value={n} onChange={(e) => setN(Number(e.target.value))} /> {n}
      </label>
      {data && !data.available && (
        <p>{data.backbone ? "Fewer than three pictures in this view — nothing to find a center of." : "No ResNet is available — the centers are found in a ResNet embedding."}</p>
      )}
      {data?.available && (
        <>
          <p>
            Among <strong>{data.count}</strong> picture(s) in view. {data.backbone ? `Embedding: ${data.backbone}.` : ""}
          </p>
          <ul style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, padding: 0, listStyle: "none" }}>
            {data.picks.map((p, i) => (
              <li key={p.frame} data-testid={`center-${p.frame}`} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 6 }}>
                <img src={thumbUrl(camera, p.frame, query.feature)} alt={p.frame} style={{ width: "100%", display: "block" }} />
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  center {i + 1}
                  {p.label ? ` · labeled ${p.label}` : " · no label yet"}
                </div>
                <code style={{ fontSize: 11 }}>{p.frame}</code>
                <div style={{ display: "flex", gap: 4 }}>
                  {(p.label ? classes.filter((c) => c === p.label) : classes).map((c) => (
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
                      {p.label ? `⭐ Make golden (${c})` : `⭐ ${c}`}
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
