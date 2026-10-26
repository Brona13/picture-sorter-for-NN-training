import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, CardData, DeletePreview, DeleteResult, OutlierResult, ScatterPoint, ScatterResult } from "../api";
import { useJob } from "../useJob";
import { classColor } from "./colors";
import { PagerSettings } from "./Pager";
import PictureGrid from "./PictureGrid";
import Scatter, { ColourBy, ScatterLegend } from "./Scatter";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a picture's mark on the map is: its label and golden class. */
export type Mark = { label: string | null; golden: string | null };

/**
 * The 2D map of a feature's pictures with its batch selection, shared by the Scatter page and Classify's Scatter
 * view: this hook owns the projection job and the map's points, `ScatterMapView` draws them.
 *
 * With `auto` set, a map that is already cached (nothing to compute) appears by itself; otherwise `run` computes it.
 */
export function useScatterMap({
  camera,
  feature,
  method,
  auto = false,
  onError,
}: {
  camera: string;
  feature: string;
  method: string;
  auto?: boolean;
  onError: (message: string) => void;
}) {
  const [projection, setProjection] = useState("umap");
  const [scatter, setScatter] = useState<ScatterResult | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScatterPoint[] | null>(null);
  // Changes made from the selection (a label, a delete) show on the map at once, without projecting again. null = deleted.
  const [overrides, setOverrides] = useState<Record<string, Mark | null>>({});
  // null = not asked yet / not asked for (no `auto`)
  const [cached, setCached] = useState<boolean | null>(null);
  // A fresh projection resets the chart's zoom and selection; the key changes in the same render, so no remount flicker.
  const genRef = useRef<{ scatter: ScatterResult | null; gen: number }>({ scatter: null, gen: 0 });
  if (genRef.current.scatter !== scatter) genRef.current = { scatter, gen: genRef.current.gen + 1 };
  const sj = useJob<ScatterResult>(job);
  const projecting = job !== null && (sj === null || sj.status === "queued" || sj.status === "running");

  useEffect(() => {
    setSelected(null);
    setOverrides({});
  }, [scatter]);

  // A map of another embedding, or of another picture set, would be stale.
  useEffect(() => {
    setScatter(null);
    setJob(null);
    setCached(null);
  }, [camera, feature]);
  useEffect(() => {
    setScatter((s) => (s && s.method !== method ? null : s));
  }, [method]);

  const run = useCallback(() => {
    if (!method) return;
    api.dedupScatter(camera, feature, projection, method).then((j) => setJob(j.id)).catch((e: unknown) => onError(msg(e)));
  }, [camera, feature, projection, method, onError]);

  useEffect(() => {
    if (sj?.status === "done" && sj.result) setScatter(sj.result);
    else if (sj?.status === "error") onError(sj.error ?? "The projection failed.");
  }, [sj?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask whether the map is cached, and show it at once when it is.
  useEffect(() => {
    if (!auto || !camera || !feature || !method) return;
    let cancelled = false;
    setCached(null);
    api
      .dedupScatterCached(camera, feature, projection, method)
      .then((r) => {
        if (cancelled) return;
        setCached(r.cached);
        if (r.cached && !scatter) run();
      })
      .catch((e: unknown) => !cancelled && onError(msg(e)));
    return () => {
      cancelled = true;
    };
  }, [auto, camera, feature, projection, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapPoints = useMemo(
    () => (scatter ? scatter.points.flatMap((p) => (p.frame in overrides ? (overrides[p.frame] === null ? [] : [{ ...p, ...overrides[p.frame] }]) : [p])) : []),
    [scatter, overrides],
  );
  const progress = (sj?.progress ?? {}) as Record<string, unknown>;
  return { projection, setProjection, scatter, projecting, progress, run, cached, selected, setSelected, overrides, setOverrides, mapPoints, gen: genRef.current.gen };
}

export type ScatterMap = ReturnType<typeof useScatterMap>;

/** The map can only be coloured by what exists: say so and fall back to the labels. */
export function effectiveColour(colourBy: ColourBy, scatter: ScatterResult | null, outliers: OutlierResult | null): { colour: ColourBy; note: string | null } {
  const hasClusters = !!scatter && scatter.points.some((p) => p.cluster !== null);
  const note =
    colourBy === "cluster" && !hasClusters
      ? "There is no clustering for this embedding yet, so the dots are coloured by label. Run Clusters to colour by cluster."
      : colourBy === "outlier" && !outliers
        ? "Outliers have not been scored for this embedding, so the dots are coloured by label. Run Outliers first."
        : null;
  return { colour: note ? "label" : colourBy, note };
}

/**
 * The legend, the map and, under it, the selection with its batch actions. `onChanged` runs after a label or a delete
 * made from the selection, so the page can reload its own counts.
 */
export function ScatterMapView({
  camera,
  feature,
  pictureFeature,
  map,
  colourBy,
  scores,
  grid,
  onGrid,
  onNotice,
  onError,
  onChanged,
}: {
  camera: string;
  feature: string;
  /** The feature whose cutout the cards show, when it differs from the one the picture actions go through (a Dedup box). */
  pictureFeature?: string;
  map: ScatterMap;
  colourBy: ColourBy;
  scores?: Record<string, number>;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onChanged: () => void;
}) {
  const { scatter, selected, setSelected, setOverrides } = map;
  if (!scatter) return null;
  return (
    <>
      <ScatterLegend colourBy={colourBy} classes={scatter.classes} />
      <Scatter key={map.gen} points={map.mapPoints} classes={scatter.classes} onSelect={setSelected} colourBy={colourBy} scores={scores} />
      {selected && (
        <ScatterSelection
          camera={camera}
          feature={feature}
          pictureFeature={pictureFeature}
          points={selected}
          classes={scatter.classes}
          grid={grid}
          onGrid={onGrid}
          onMark={(frame, m) => setOverrides((o) => ({ ...o, [frame]: m }))}
          onRemoved={(frame) => {
            setOverrides((o) => ({ ...o, [frame]: null }));
            onNotice(`Deleted ${frame}. It stays on disk; see Classify → Show: Deleted.`);
            onChanged();
          }}
          onError={onError}
          onRestored={(frame) => {
            setOverrides((o) => ({ ...o, [frame]: { label: null, golden: null } }));
            onChanged();
          }}
          onLabeled={(frames, cls) => {
            onNotice(`Labeled ${frames.length} frame(s) as ${cls}.`);
            setOverrides((o) => ({
              ...o,
              ...Object.fromEntries(
                frames.map((f) => {
                  const pt = scatter.points.find((q) => q.frame === f);
                  const prev = o[f] ?? (pt ? { label: pt.label, golden: pt.golden } : { label: null, golden: null });
                  return [f, { label: cls, golden: prev.golden ? cls : null }];
                }),
              ),
            }));
            onChanged();
          }}
          onDeleted={(r, frames) => {
            onNotice(
              `Deleted ${r.deleted} frame(s)` +
                (r.cleared_labels || r.cleared_goldens ? ` · cleared ${r.cleared_labels} label(s) and ${r.cleared_goldens} golden mark(s)` : "") +
                ". They stay on disk; see Classify → Show: Deleted.",
            );
            setOverrides((o) => ({ ...o, ...Object.fromEntries(frames.map((f) => [f, null])) }));
            setSelected(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/**
 * The frames inside the rectangle drawn on the scatter: a summary, the batch actions (label all as
 * a class, delete all), and then the same paged card grid used everywhere else, with the picture
 * viewer on click. Changes are reported up so the map can show them without being recomputed.
 */
export function ScatterSelection({
  camera,
  feature,
  pictureFeature,
  points,
  classes,
  grid,
  onGrid,
  onMark,
  onRemoved,
  onRestored,
  onDeleted,
  onLabeled,
  onError,
}: {
  camera: string;
  feature: string;
  pictureFeature?: string;
  points: ScatterPoint[];
  classes: string[];
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onMark: (frame: string, mark: Mark) => void;
  onRemoved: (frame: string) => void;
  /** A picture deleted from the selection was restored there: it is back on the map, unlabeled. */
  onRestored: (frame: string) => void;
  onDeleted: (r: DeleteResult, frames: string[]) => void;
  onLabeled: (frames: string[], cls: string) => void;
  onError: (m: string) => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [gone, setGone] = useState<Set<string>>(new Set());

  const hasClusters = points.some((p) => p.cluster !== null);
  const clusterKey = (p: ScatterPoint) => (p.cluster === null || p.cluster < 0 ? 1e9 : p.cluster);
  const sorted = useMemo(() => [...points].sort((a, b) => clusterKey(a) - clusterKey(b) || a.frame.localeCompare(b.frame)), [points]);

  // A new selection starts clean: no old confirmation, page, marks or removals.
  useEffect(() => {
    setPreview(null);
    setPage(1);
    setGone(new Set());
    setMarks(Object.fromEntries(points.map((p) => [p.frame, { label: p.label, golden: p.golden }])));
  }, [points]);

  const rows = sorted.filter((p) => !gone.has(p.frame));
  const frames = rows.map((p) => p.frame);
  const markOf = (frame: string): Mark => marks[frame] ?? { label: null, golden: null };
  const askDelete = () => {
    setBusy(true);
    api
      .deletePreview(camera, feature, frames)
      .then(setPreview)
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  const doLabel = (cls: string) => {
    setBusy(true);
    api
      .labelFrames(camera, feature, frames, cls, "Scatter")
      .then((r) => {
        setMarks((m) => Object.fromEntries(Object.entries(m).map(([f, v]) => [f, { label: frames.includes(f) ? cls : v.label, golden: frames.includes(f) && v.golden ? cls : v.golden }])));
        onLabeled(frames, cls);
        void r;
      })
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  const doDelete = () => {
    setBusy(true);
    api
      .deleteFrames(camera, feature, frames, note, "Scatter")
      .then((r) => {
        setPreview(null);
        setNote("");
        onDeleted(r, frames);
      })
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };

  // What the selection is made of: clusters when there is a clustering, labels otherwise.
  const counts = new Map<string, number>();
  for (const p of rows) {
    const k = hasClusters ? (p.cluster === null || p.cluster < 0 ? "unique" : `cluster ${p.cluster}`) : (markOf(p.frame).label ?? "unlabeled");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(" · ");

  const cardOf = (frame: string): CardData => ({ frame, ...markOf(frame), deleted: false, leanings: {}, bars: null, cluster: null });

  return (
    <div data-testid="scatter-selection">
      <h4>{rows.length} frame(s) in the selected region</h4>
      {rows.length === 0 ? (
        <p>No frames inside the rectangle. Right-click to reset the view.</p>
      ) : (
        <>
          <p style={{ fontSize: 12 }}>{summary}</p>
          {preview === null ? (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "6px 0" }}>
              <div role="group" aria-label="Label the selection" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {classes.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={busy}
                    onClick={() => doLabel(c)}
                    style={{ background: classColor(c, classes), color: "#fff", borderColor: classColor(c, classes) }}
                  >
                    Label {rows.length} as {c}
                  </button>
                ))}
              </div>
              <button type="button" disabled={busy} onClick={askDelete} style={{ borderColor: "#c62828", color: "#c62828" }}>
                🗑 Delete these {rows.length} frame(s)…
              </button>
            </div>
          ) : (
            <div role="alertdialog" aria-label="Confirm delete" style={{ border: "1px solid #c33", padding: 8, margin: "6px 0" }}>
              <p style={{ margin: "0 0 6px" }}>
                Delete <strong>{preview.total}</strong> frame(s) on this camera, in <strong>every ROI</strong>? Of these, <strong>{preview.labeled}</strong>{" "}
                labeled and <strong>{preview.golden}</strong> golden lose their marks (a restore does not bring the marks back). Files stay on disk.
              </p>
              <label>
                Note (optional){" "}
                <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. foreign object" style={{ width: 260 }} />
              </label>{" "}
              <button type="button" disabled={busy} onClick={doDelete}>
                Yes — delete {preview.total}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          )}
          <PictureGrid
            camera={camera}
            feature={feature}
            pictureFeature={pictureFeature}
            classes={classes}
            frames={frames}
            cardOf={cardOf}
            via="Scatter"
            grid={grid}
            onGrid={onGrid}
            page={page}
            onPage={setPage}
            where="selection"
            extras={(f) => {
              const p = points.find((q) => q.frame === f);
              return { caption: !p || p.cluster === null ? undefined : p.cluster < 0 ? "unique" : `cluster ${p.cluster}${p.representative ? " · rep" : ""}` };
            }}
            onChanged={(f, c) => {
              const m = { label: c.label, golden: c.golden };
              setMarks((cur) => ({ ...cur, [f]: m }));
              onMark(f, m);
            }}
            onDeleted={(f) => {
              setGone((g) => new Set(g).add(f));
              onRemoved(f);
            }}
            onRestored={(f) => {
              setGone((g) => {
                const next = new Set(g);
                next.delete(f);
                return next;
              });
              setMarks((cur) => ({ ...cur, [f]: { label: null, golden: null } }));
              onRestored(f);
            }}
            onError={onError}
          />
        </>
      )}
    </div>
  );
}

/** The projection's bar: the embedding step counts pictures, the layout step counts its own steps and shows a percentage. */
export function ProjectionProgress({ progress }: { progress: Record<string, unknown> }) {
  const done = Number(progress.done ?? 0);
  const total = Number(progress.total ?? 0);
  if (progress.phase === "embedding") {
    return (
      <p aria-live="polite">
        <progress value={done} max={total || undefined} /> Embedding {done}/{total}
      </p>
    );
  }
  const share = total > 0 ? Math.round((100 * done) / total) : null;
  return (
    <p aria-live="polite">
      <progress value={share === null ? undefined : done} max={total || undefined} /> Projecting{share === null ? "…" : ` ${share} %`}
    </p>
  );
}
