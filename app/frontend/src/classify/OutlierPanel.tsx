import { useEffect, useState } from "react";
import { api, CardData, OutlierResult } from "../api";
import { useJob } from "../useJob";
import Card, { MAX_SHORTCUT_CLASSES } from "./Card";
import Pager, { PagerSettings } from "./Pager";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const K_MIN = 1;
const K_MAX = 20;

/**
 * Outlier scoring: how isolated each frame is among the feature's embeddings (mean cosine distance
 * to its k nearest other frames). The most isolated frames come first, as the same cards Classify
 * and the cluster browser use, so they can be labeled, made golden or deleted on the spot.
 * The score is a review aid, not a verdict.
 */
export default function OutlierPanel({
  camera,
  feature,
  method,
  grid,
  onGrid,
  onDeleted,
  onResult,
  onError,
}: {
  camera: string;
  feature: string;
  method: string;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onDeleted: (frame: string) => void;
  /** Reports the latest scores (or null when they are stale) so the scatter can colour by them. */
  onResult?: (result: OutlierResult | null) => void;
  onError: (message: string) => void;
}) {
  const [k, setK] = useState(5);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<OutlierResult | null>(null);
  const [marks, setMarks] = useState<OutlierResult["marks"]>({});
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const job = useJob<OutlierResult>(jobId);
  const running = jobId !== null && (job === null || job.status === "queued" || job.status === "running");

  useEffect(() => {
    setJobId(null);
    setResult(null);
    setGone(new Set());
    setPage(1);
    onResult?.(null);
  }, [camera, feature, method]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (job?.status === "done" && job.result) {
      setResult(job.result);
      setMarks(job.result.marks);
      setGone(new Set());
      setPage(1);
      onResult?.(job.result);
    } else if (job?.status === "error") onError(job.error ?? "Outlier scoring failed.");
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = result ? result.scores.filter((s) => !gone.has(s.frame)) : [];
  const perPage = grid.per_page;
  const nPages = Math.max(1, Math.ceil(rows.length / perPage));
  const cur = Math.min(page, nPages);
  const shown = rows.slice((cur - 1) * perPage, cur * perPage);
  const progress = job?.progress ?? {};

  async function act<T>(frame: string, call: () => Promise<T>, then: (r: T) => void) {
    setBusy(frame);
    try {
      then(await call());
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(null);
    }
  }

  const cardOf = (frame: string): CardData => ({
    frame,
    label: marks[frame]?.label ?? null,
    golden: marks[frame]?.golden ?? null,
    deleted: false,
    leanings: {},
    bars: null,
    cluster: null,
  });
  const keep = (r: { card: { frame: string; label: string | null; golden: string | null } }) =>
    setMarks((m) => ({ ...m, [r.card.frame]: { label: r.card.label, golden: r.card.golden } }));

  return (
    <details data-testid="outlier-panel">
      <summary>Outliers (most isolated frames)</summary>
      <p style={{ fontSize: 12 }}>
        Scores each frame by its mean cosine distance to its <em>k</em> nearest other frames, using the {method} embeddings (filter and mask apply). A high score means
        few similar frames: an unusual picture, or one that does not belong. It is a hint for review, not a verdict.
      </p>
      <label>
        k (neighbours){" "}
        <input type="range" aria-label="k neighbours" min={K_MIN} max={K_MAX} value={k} onChange={(e) => setK(Number(e.target.value))} /> {k}
      </label>{" "}
      <button
        disabled={running || !feature || !method}
        onClick={() =>
          api
            .dedupOutliers(camera, feature, method, k)
            .then((j) => setJobId(j.id))
            .catch((e: unknown) => onError(msg(e)))
        }
      >
        Score outliers
      </button>
      {running && (
        <p aria-live="polite">
          <progress value={Number(progress.done ?? 0)} max={Number(progress.total ?? 0) || undefined} /> Embedding {Number(progress.done ?? 0)}/{Number(progress.total ?? 0)}
        </p>
      )}
      {result && (
        <>
          <p role="status">
            {rows.length} frame(s) · score min {result.summary.min.toFixed(3)} · median {result.summary.median.toFixed(3)} · 95th percentile {result.summary.p95.toFixed(3)} · max{" "}
            {result.summary.max.toFixed(3)} (k = {result.k}, {result.method})
          </p>
          <p style={{ margin: "0 0 4px", fontSize: 12 }}>
            ⌨ Hover a card and press {result.classes.slice(0, MAX_SHORTCUT_CLASSES).map((c, i) => `${i + 1} = ${c}`).join(", ")}, 0 = clear label, the key left of 1 = golden,
            Delete = delete the frame.
          </p>
          <Pager grid={{ page: cur, per_page: perPage, n_pages: nPages, total: rows.length }} settings={grid} onPage={setPage} onSettings={onGrid} where="outliers top" />
          <ul style={{ display: "grid", gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gap: 8, padding: 0 }}>
            {shown.map((s) => (
              <Card
                key={s.frame}
                camera={camera}
                feature={feature}
                classes={result.classes}
                methods={[]}
                card={cardOf(s.frame)}
                busy={busy === s.frame}
                fullSize
                caption={`outlier ${s.score.toFixed(3)}`}
                onLabel={(cls) => act(s.frame, () => api.setLabel(camera, feature, s.frame, cls), keep)}
                onGolden={(on) => act(s.frame, () => api.setGolden(camera, feature, s.frame, on), keep)}
                onDelete={() =>
                  act(
                    s.frame,
                    () => api.deleteFrame(camera, feature, s.frame),
                    () => {
                      setGone((g) => new Set(g).add(s.frame));
                      onDeleted(s.frame);
                    },
                  )
                }
                onRestore={() => undefined}
              />
            ))}
          </ul>
          <Pager grid={{ page: cur, per_page: perPage, n_pages: nPages, total: rows.length }} settings={grid} onPage={setPage} onSettings={onGrid} where="outliers bottom" />
        </>
      )}
    </details>
  );
}
