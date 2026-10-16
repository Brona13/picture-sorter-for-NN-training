import { useEffect, useState } from "react";
import { api, CardData, OutlierResult } from "../api";
import { useJob } from "../useJob";
import WheelRange from "../WheelRange";
import Card, { MAX_SHORTCUT_CLASSES } from "./Card";
import Pager, { PagerSettings } from "./Pager";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const K_MIN = 1;
const K_MAX = 20;

type Args = {
  camera: string;
  feature: string;
  method: string;
  /** Reports the latest scores (or null when they are stale) so the scatter can colour by them. */
  onResult?: (result: OutlierResult | null) => void;
  onError: (message: string) => void;
};

/** State of one outlier run. The controls and the result cards read it, so they can sit in different places on the page. */
export function useOutliers({ camera, feature, method, onResult, onError }: Args) {
  const [k, setK] = useState(5);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<OutlierResult | null>(null);
  const [marks, setMarks] = useState<OutlierResult["marks"]>({});
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
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

  return { camera, feature, method, k, setK, setJobId, result, marks, setMarks, gone, setGone, page, setPage, running, progress: job?.progress ?? {}, onError };
}

export type OutlierState = ReturnType<typeof useOutliers>;

/** k slider, "Score outliers" button and progress. */
export function OutlierControls({ o }: { o: OutlierState }) {
  return (
    <>
      <p style={{ fontSize: 12 }}>
        Scores each frame by its mean cosine distance to its <em>k</em> nearest other frames, using the {o.method} embeddings (filter and mask apply). A high score means
        few similar frames: an unusual picture, or one that does not belong. It is a hint for review, not a verdict.
      </p>
      <label>
        k (neighbours){" "}
        <WheelRange aria-label="k neighbours" min={K_MIN} max={K_MAX} value={o.k} onValue={o.setK} /> {o.k}
      </label>{" "}
      <button
        disabled={o.running || !o.feature || !o.method}
        onClick={() =>
          api
            .dedupOutliers(o.camera, o.feature, o.method, o.k)
            .then((j) => o.setJobId(j.id))
            .catch((e: unknown) => o.onError(msg(e)))
        }
      >
        Score outliers
      </button>
      {o.running && (
        <p aria-live="polite">
          <progress value={Number(o.progress.done ?? 0)} max={Number(o.progress.total ?? 0) || undefined} /> Embedding {Number(o.progress.done ?? 0)}/{Number(o.progress.total ?? 0)}
        </p>
      )}
    </>
  );
}

/**
 * The most isolated frames first, as the same cards Classify and the cluster browser use, so they
 * can be labeled, made golden or deleted on the spot. The score is a review aid, not a verdict.
 */
export function OutlierResults({
  o,
  grid,
  onGrid,
  onDeleted,
}: {
  o: OutlierState;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onDeleted: (frame: string) => void;
}) {
  const { camera, feature, result, marks, setMarks, gone, setGone, page, setPage } = o;
  const [busy, setBusy] = useState<string | null>(null);
  if (!result) return null;

  const rows = result.scores.filter((s) => !gone.has(s.frame));
  const perPage = grid.per_page;
  const nPages = Math.max(1, Math.ceil(rows.length / perPage));
  const cur = Math.min(page, nPages);
  const shown = rows.slice((cur - 1) * perPage, cur * perPage);

  async function act<T>(frame: string, call: () => Promise<T>, then: (r: T) => void) {
    setBusy(frame);
    try {
      then(await call());
    } catch (e) {
      o.onError(msg(e));
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
    <div data-testid="outlier-results">
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
    </div>
  );
}

/** Controls and results together in one collapsible block. */
export default function OutlierPanel({
  grid,
  onGrid,
  onDeleted,
  ...args
}: Args & { grid: PagerSettings; onGrid: (perPage: number, cols: number) => void; onDeleted: (frame: string) => void }) {
  const o = useOutliers(args);
  return (
    <details data-testid="outlier-panel">
      <summary>Outliers (most isolated frames)</summary>
      <OutlierControls o={o} />
      <OutlierResults o={o} grid={grid} onGrid={onGrid} onDeleted={onDeleted} />
    </details>
  );
}
