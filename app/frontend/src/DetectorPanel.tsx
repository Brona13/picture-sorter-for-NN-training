import { ReactNode, useEffect, useRef } from "react";
import { DetectionList, DetectionRow, DetectorChoice, DetectorInfo } from "./api";
import { thumbUrl } from "./classify/Card";

export const EMPTY_DETECTOR: DetectorChoice = { exemplars: [], topk: 1, threshold: 0.3 };

/** Frames the detector is unsure about (or found nothing in) – the review queue. */
export const needsLook = (r: DetectionRow) => r.state === "review" || r.state === "none";
/** Frames without a box first, then the least confident. */
export const byConfidence = (a: DetectionRow, b: DetectionRow) =>
  (a.boxes[0]?.conf ?? -1) - (b.boxes[0]?.conf ?? -1);

const STATE_COLOR: Record<string, string> = {
  trusted: "#2e9e5b",
  human: "#1a73e8",
  review: "#e08a00",
  none: "#c0392b",
};
const STRIP_WINDOW = 60;

/** Horizontal strip of thumbnails with the detected box drawn on each one. */
export function FrameStrip({
  camera,
  feature,
  frames,
  current,
  rows,
  onPick,
}: {
  camera: string;
  feature: string;
  frames: string[];
  current: string;
  rows: Map<string, DetectionRow>;
  onPick: (frame: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector('[aria-current="true"]') as HTMLElement | null;
    el?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [current]);

  if (frames.length === 0) return null;
  const idx = Math.max(0, frames.indexOf(current));
  const start = Math.max(0, Math.min(idx - STRIP_WINDOW / 2, frames.length - STRIP_WINDOW));
  const shown = frames.slice(start, start + STRIP_WINDOW);
  return (
    <div aria-label="Frame strip">
      <div ref={ref} style={{ display: "flex", gap: 4, overflowX: "auto", padding: "4px 0" }}>
        {shown.map((f) => {
          const row = rows.get(f);
          const box = row?.boxes[0];
          const active = f === current;
          return (
            <button
              key={f}
              type="button"
              aria-label={`Show ${f}`}
              aria-current={active}
              title={`${f}${row ? ` — ${row.state}${box ? ` ${Math.round(box.conf * 100)}%` : ""}` : ""}`}
              onClick={(e) => {
                e.currentTarget.blur();
                onPick(f);
              }}
              style={{
                position: "relative",
                padding: 0,
                flex: "0 0 auto",
                lineHeight: 0,
                background: "none",
                border: `2px solid ${row ? STATE_COLOR[row.state] ?? "#bbb" : "#ddd"}`,
                outline: active ? "2px solid #111" : "none",
                outlineOffset: 1,
                cursor: "pointer",
              }}
            >
              <img src={thumbUrl(camera, f, feature)} alt="" loading="lazy" style={{ height: 56, display: "block" }} />
              {box && (
                <span
                  data-testid={`strip-box-${f}`}
                  style={{
                    position: "absolute",
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.w * 100}%`,
                    height: `${box.h * 100}%`,
                    border: "1.5px solid #ff3b30",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      {frames.length > shown.length && (
        <small>
          Showing {start + 1}–{start + shown.length} of {frames.length} frames
        </small>
      )}
    </div>
  );
}

export interface RunState {
  running: boolean;
  progress?: { done?: number; total?: number };
  result?: { detected: number; needs_review: number; skipped_human: number } | null;
  error?: string | null;
}

/** Candidates, threshold and the Run button – shown next to both the Detector and Review steps. */
export function RunBar({
  det,
  onDetector,
  info,
  dirty,
  onRun,
  run,
  onGoReview,
}: {
  det: DetectorChoice;
  onDetector: (d: DetectorChoice) => void;
  info: DetectorInfo | null;
  dirty: boolean;
  onRun: () => void;
  run: RunState;
  onGoReview?: () => void;
}) {
  const [minK, maxK] = info?.topk ?? [1, 5];
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ margin: "4px 0" }}>
        <label>
          Candidates per frame{" "}
          <select value={det.topk} onChange={(e) => onDetector({ ...det, topk: Number(e.target.value) })}>
            {Array.from({ length: maxK - minK + 1 }, (_, i) => minK + i).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Confidence threshold{" "}
          <input
            type="range"
            aria-label="Confidence threshold"
            min={0}
            max={100}
            step={1}
            value={Math.round(det.threshold * 100)}
            onChange={(e) => onDetector({ ...det, threshold: Number(e.target.value) / 100 })}
          />{" "}
          <output>{Math.round(det.threshold * 100)}%</output>
        </label>
      </p>
      <p style={{ margin: "4px 0" }}>
        <button onClick={onRun} disabled={det.exemplars.length === 0 || !info?.available || run.running}>
          Run detection
        </button>{" "}
        {dirty && !run.running && <em>Unsaved settings are saved first.</em>}
        {run.running && (
          <span>
            Detecting… {run.progress?.done ?? 0}/{run.progress?.total ?? "?"}
          </span>
        )}
        {!run.running && run.result && (
          <span>
            Detected {run.result.detected} frames, {run.result.needs_review} need review
            {run.result.skipped_human ? `, ${run.result.skipped_human} kept as decided` : ""}.{" "}
            {onGoReview && run.result.needs_review > 0 && <button onClick={onGoReview}>Go to Review</button>}
          </span>
        )}
        {run.error && <span role="alert">{run.error}</span>}
      </p>
    </div>
  );
}

/** Enter accepts the box, ←/→ move through the queue, Delete clears the box. */
function useReviewKeys(enabled: boolean, h: { accept: () => void; clear: () => void; step: (d: number) => void }) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (e.key === "Enter") {
        if (tag === "BUTTON") return;
        e.preventDefault();
        ref.current.accept();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        ref.current.step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        ref.current.step(-1);
      } else if (e.key === "Delete") {
        e.preventDefault();
        ref.current.clear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Review queue controls; the frame itself is shown on the shared preview. */
export function ReviewPanel({
  list,
  queue,
  showAll,
  onShowAll,
  canAccept,
  onAccept,
  onClear,
  onStep,
  active,
  children,
}: {
  list: DetectionList | null;
  queue: DetectionRow[];
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  canAccept: boolean;
  onAccept: () => void;
  onClear: () => void;
  onStep: (d: number) => void;
  active: boolean;
  children?: ReactNode;
}) {
  useReviewKeys(active && queue.length > 0, {
    accept: () => canAccept && onAccept(),
    clear: onClear,
    step: onStep,
  });
  if (!list) return <p>Add exemplars and run the detector first — its uncertain frames show up here.</p>;
  const toCheck = (list.counts.review ?? 0) + (list.counts.none ?? 0);
  const confidences = queue.map((f) => f.boxes[0]?.conf).filter((c): c is number => c !== undefined);
  return (
    <section aria-label="Review queue">
      <h4 style={{ margin: "4px 0" }}>
        Review ({toCheck} to check
        {list.counts.trusted ? `, ${list.counts.trusted} trusted` : ""}
        {list.counts.human ? `, ${list.counts.human} decided` : ""})
      </h4>
      <label>
        <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} /> Show all
        frames, least confident first
      </label>
      {showAll && confidences.length > 0 && (
        <p>
          Confidence of the shown boxes: {Math.round(Math.min(...confidences) * 100)}% to{" "}
          {Math.round(Math.max(...confidences) * 100)}% (threshold {Math.round(list.threshold * 100)}%).
        </p>
      )}
      {queue.length === 0 ? (
        <p>Nothing to review.</p>
      ) : (
        <p>
          <button disabled={!canAccept} onClick={onAccept}>
            Accept box
          </button>{" "}
          <button onClick={onClear}>Clear</button>{" "}
          <em>
            Shortcuts: Enter accepts, ← → switch frame, Delete clears. Adjusted boxes are saved as manual and
            kept when detection is re-run.
          </em>
        </p>
      )}
      {children}
    </section>
  );
}
