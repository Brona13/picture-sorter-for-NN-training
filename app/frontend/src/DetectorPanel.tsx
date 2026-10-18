import { ReactNode, useEffect, useRef, useState } from "react";
import { DetectionList, DetectionRow, DetectorChoice, DetectorInfo } from "./api";
import { thumbUrl } from "./classify/Card";

export const EMPTY_DETECTOR: DetectorChoice = { exemplars: [], topk: 1, threshold: 0.3, method: "template", size: 768 };

const METHOD_LABEL: Record<string, string> = {
  template: "Template matching (fast, exact size)",
  model: "Model (OWL-ViT)",
};
const METHOD_HELP =
  "Template matching slides your exemplar over each frame: exact position and your drawn size, no model to download. It suits a fixed camera and an object of constant size. The model (OWL-ViT) tolerates a different look, but its boxes are often much bigger than the object, and its confidence is only relative. Changing the method makes the stored detections stale."

const SIZE_LABEL: Record<number, string> = { 768: "768 (precise)", 512: "512 (about 2x faster, boxes less exact)" };

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
                border: `2px solid ${row ? STATE_COLOR[row.state] ?? "var(--border)" : "var(--border)"}`,
                outline: active ? "2px solid var(--fg)" : "none",
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
  progress?: { done?: number; total?: number; phase?: string };
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
  onRun: (acceptDownload: boolean) => void;
  run: RunState;
  onGoReview?: () => void;
}) {
  const [minK, maxK] = info?.topk ?? [1, 5];
  const [confirming, setConfirming] = useState(false);
  const usesModel = (det.method ?? "template") === "model";
  const needsDownload = usesModel && info?.model_cached === false;
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
        <label title={METHOD_HELP}>
          Method{" "}
          <select value={det.method ?? "template"} onChange={(e) => onDetector({ ...det, method: e.target.value as DetectorChoice["method"] })}>
            {(info?.methods ?? ["template", "model"]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </label>{" "}
        {usesModel && (
          <>
            <label title="The side the pictures are scaled to before the model looks at them. 512 is about twice as fast, but the boxes are less exact; changing it makes the stored detections stale.">
              Input size{" "}
              <select value={det.size ?? 768} onChange={(e) => onDetector({ ...det, size: Number(e.target.value) })}>
                {(info?.input_sizes ?? [768, 512]).map((n) => (
                  <option key={n} value={n}>
                    {SIZE_LABEL[n] ?? n}
                  </option>
                ))}
              </select>
            </label>{" "}
          </>
        )}
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
      {confirming && info && (
        <div
          role="alertdialog"
          aria-label="Model download"
          style={{
            border: "1px solid var(--accent)",
            background: "var(--info-bg)",
            color: "var(--info-fg)",
            borderRadius: "var(--radius)",
            padding: 10,
            margin: "6px 0",
          }}
        >
          <strong>The detector model has to be downloaded first</strong>
          <ul style={{ margin: "6px 0" }}>
            <li>
              Model: <code>{info.model}</code> (OWL-ViT)
            </li>
            <li>Size: about {info.download_mb ?? 600} MB, downloaded once</li>
            <li>Source: {info.download_source ?? "huggingface.co"} — needs internet access (behind a proxy, set HTTPS_PROXY before starting the app)</li>
            {info.cache_dir && (
              <li>
                Stored in: <code>{info.cache_dir}</code>
              </li>
            )}
            <li>Afterwards detection runs locally; your frames never leave this computer.</li>
          </ul>
          <button
            onClick={() => {
              setConfirming(false);
              onRun(true);
            }}
          >
            Download and run
          </button>{" "}
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      <p style={{ margin: "4px 0" }}>
        <button
          onClick={() => (needsDownload ? setConfirming(true) : onRun(false))}
          disabled={det.exemplars.length === 0 || (usesModel && !info?.available) || run.running}
        >
          Run detection
        </button>{" "}
        {needsDownload && !confirming && !run.running && (
          <em>First run downloads the model (about {info?.download_mb ?? 600} MB).</em>
        )}{" "}
        {dirty && !run.running && <em>Unsaved settings are saved first.</em>}
        {run.running && (
          <span>
            {run.progress?.phase === "downloading"
              ? "Downloading the model…"
              : `Detecting… ${run.progress?.done ?? 0}/${run.progress?.total ?? "?"}`}
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

/** Review queue header: the counts, the filter, the hints and the run controls; the frames are in the grid below. */
export function ReviewPanel({
  list,
  queue,
  showAll,
  onShowAll,
  children,
}: {
  list: DetectionList | null;
  queue: DetectionRow[];
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  children?: ReactNode;
}) {
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
          <em>
            Hover a card: <kbd>Enter</kbd> or <kbd>A</kbd> accepts its box, <kbd>Delete</kbd> or <kbd>X</kbd> clears it,{" "}
            <kbd>Z</kbd> undoes, <kbd>E</kbd> (or a click on the picture) opens it to adjust the box. A decision shows at once and
            the card stays where it is until you press Remove decided. Adjusted boxes are saved as manual and kept when
            detection is re-run.
          </em>
        </p>
      )}
      {children}
    </section>
  );
}
