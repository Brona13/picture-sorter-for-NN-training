import { useEffect, useState } from "react";
import { api, CardData, OutlierResult } from "../api";
import { useJob } from "../useJob";
import WheelRange from "../WheelRange";
import { PagerSettings } from "./Pager";
import PictureGrid from "./PictureGrid";

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
/** onStart is called when "Score outliers" is pressed, before the run begins. */
export function OutlierControls({ o, onStart }: { o: OutlierState; onStart?: () => void }) {
  return (
    <>
      <label>
        k (neighbours){" "}
        <WheelRange aria-label="k neighbours" min={K_MIN} max={K_MAX} value={o.k} onValue={o.setK} /> {o.k}
      </label>{" "}
      <button
        disabled={o.running || !o.feature || !o.method}
        onClick={() => {
          onStart?.();
          api
            .dedupOutliers(o.camera, o.feature, o.method, o.k)
            .then((j) => o.setJobId(j.id))
            .catch((e: unknown) => o.onError(msg(e)));
        }}
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
  onChanged,
}: {
  o: OutlierState;
  grid: PagerSettings;
  onGrid: (perPage: number, cols: number) => void;
  onDeleted: (frame: string) => void;
  /** A card was labeled, marked golden or restored here (a delete goes to `onDeleted`). */
  onChanged?: () => void;
}) {
  const { camera, feature, result, marks, setMarks, gone, setGone, page, setPage } = o;
  if (!result) return null;

  const rows = result.scores.filter((s) => !gone.has(s.frame));
  const score = new Map(result.scores.map((r) => [r.frame, r.score])); // a deleted card stays in place, so every score is kept
  const cardOf = (frame: string): CardData => ({
    frame,
    label: marks[frame]?.label ?? null,
    golden: marks[frame]?.golden ?? null,
    deleted: false,
    leanings: {},
    bars: null,
    cluster: null,
  });

  return (
    <div data-testid="outlier-results">
      <p role="status">
        {rows.length} frame(s) · score min {result.summary.min.toFixed(3)} · median {result.summary.median.toFixed(3)} · 95th percentile {result.summary.p95.toFixed(3)} · max{" "}
        {result.summary.max.toFixed(3)} (k = {result.k}, {result.method})
      </p>
      <PictureGrid
        camera={camera}
        feature={feature}
        classes={result.classes}
        frames={rows.map((r) => r.frame)}
        cardOf={cardOf}
        via="Outliers"
        grid={grid}
        onGrid={onGrid}
        page={page}
        onPage={setPage}
        where="outliers"
        extras={(f) => ({ caption: `outlier ${(score.get(f) ?? 0).toFixed(3)}` })}
        onChanged={(f, c) => {
          setMarks((m) => ({ ...m, [f]: { label: c.label, golden: c.golden } }));
          onChanged?.();
        }}
        onDeleted={(f) => {
          setGone((g) => new Set(g).add(f));
          onDeleted(f);
        }}
        onRestored={(f) => {
          setGone((g) => {
            const next = new Set(g);
            next.delete(f);
            return next;
          });
          setMarks((m) => ({ ...m, [f]: { label: null, golden: null } }));
          onChanged?.();
        }}
        onError={o.onError}
      />
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
