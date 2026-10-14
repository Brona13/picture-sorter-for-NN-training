import { useEffect, useState } from "react";
import { api, DetectionList, DetectionRow, DetectorChoice, DetectorInfo, FilterChoice } from "./api";
import RoiCanvas from "./RoiCanvas";
import { Box, roundBox } from "./roiGeometry";
import { useJob } from "./useJob";
import { usePreview } from "./usePreview";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Frames without a box first, then the least confident.
const byConfidence = (a: DetectionRow, b: DetectionRow) =>
  (a.boxes[0]?.conf ?? -1) - (b.boxes[0]?.conf ?? -1);
const EMPTY: DetectorChoice = { exemplars: [], topk: 1, threshold: 0.3 };

interface Props {
  camera: string;
  feature: string;
  /** Frame currently shown on the page and its filtered crop (exemplar boxes are drawn on it). */
  frame: string;
  cropUrl: string | null;
  filter: FilterChoice | null;
  detector: DetectorChoice | null;
  onDetector: (d: DetectorChoice) => void;
  /** Unsaved settings: detection runs on the saved ones, so it is disabled until saved. */
  dirty: boolean;
  onError: (message: string | null) => void;
}

/** Exemplar picker, detection run and manual review queue for one feature. */
export default function DetectorPanel({
  camera,
  feature,
  frame,
  cropUrl,
  filter,
  detector,
  onDetector,
  dirty,
  onError,
}: Props) {
  const det = detector ?? EMPTY;
  const [info, setInfo] = useState<DetectorInfo | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<{ detected: number; needs_review: number; skipped_human: number }>(jobId);
  const [list, setList] = useState<DetectionList | null>(null);
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [reviewFrame, setReviewFrame] = useState("");
  const [reviewBox, setReviewBox] = useState<Box | null>(null);
  const reviewUrl = usePreview(camera, feature, reviewFrame, filter, null, onError);

  useEffect(() => {
    api
      .detectorInfo()
      .then(setInfo)
      .catch((e: unknown) => onError(msg(e)));
  }, [onError]);

  const hasExemplars = det.exemplars.length > 0;
  const jobDone = job?.status === "done";
  useEffect(() => {
    if (!camera || !feature || !hasExemplars) {
      setList(null);
      return;
    }
    api
      .detections(camera, feature, !showAll)
      .then((l) =>
        setList(showAll ? { ...l, frames: [...l.frames].sort(byConfidence) } : l),
      )
      .catch((e: unknown) => onError(msg(e)));
  }, [camera, feature, hasExemplars, jobDone, tick, showAll, onError]);

  // Open the first frame that still needs a look whenever the queue changes.
  useEffect(() => {
    if (!list) return;
    if (!list.frames.some((f) => f.frame === reviewFrame)) setReviewFrame(list.frames[0]?.frame ?? "");
  }, [list, reviewFrame]);

  useEffect(() => {
    const row = list?.frames.find((f) => f.frame === reviewFrame);
    const top = row?.boxes[0];
    setReviewBox(top ? { x: top.x, y: top.y, w: top.w, h: top.h } : null);
  }, [list, reviewFrame]);

  const addExemplar = () => {
    if (!draft || draft.w <= 0 || draft.h <= 0) return;
    onDetector({ ...det, exemplars: [...det.exemplars, { frame, box: roundBox(draft) }] });
    setDraft(null);
  };
  const removeExemplar = (i: number) =>
    onDetector({ ...det, exemplars: det.exemplars.filter((_, j) => j !== i) });

  const run = () =>
    api
      .detect(camera, feature)
      .then((j) => setJobId(j.id))
      .catch((e: unknown) => onError(msg(e)));

  const decide = (action: () => Promise<unknown>) =>
    action()
      .then(() => setTick((t) => t + 1))
      .catch((e: unknown) => onError(msg(e)));

  const confidences = (list?.frames ?? [])
    .map((f) => f.boxes[0]?.conf)
    .filter((c): c is number => c !== undefined);
  const toCheck = (list?.counts.review ?? 0) + (list?.counts.none ?? 0);
  const maxExemplars = info?.max_exemplars ?? 3;
  const [minK, maxK] = info?.topk ?? [1, 5];
  const progress = job?.progress as { done?: number; total?: number } | undefined;

  return (
    <div>
      <h3>Object detector</h3>
      <p>
        Mark the object on up to {maxExemplars} frames (vary lighting and screw lean). The detector
        looks for similar objects in every frame of this feature. Detection is a suggestion: boxes
        below the confidence threshold wait for your review.
      </p>
      {info && !info.available && (
        <p role="alert">
          Detector dependencies are missing. Install them with{" "}
          <code>pip install -r requirements-detector.txt</code> ({info.model}, downloaded once).
        </p>
      )}
      <ul aria-label="Exemplars">
        {det.exemplars.map((ex, i) => (
          <li key={i}>
            {ex.frame}{" "}
            <button onClick={() => removeExemplar(i)} aria-label={`Remove exemplar ${i + 1}`}>
              Remove
            </button>
          </li>
        ))}
        {!hasExemplars && <li>No exemplars yet.</li>}
      </ul>
      {det.exemplars.length < maxExemplars && cropUrl && (
        <>
          <p>Draw a box around the object on {frame}, then add it as an exemplar.</p>
          <RoiCanvas
            imageUrl={cropUrl}
            mode={draft ? "edit" : "draw"}
            box={draft}
            onChange={setDraft}
            maxWidth={500}
          />
          <button onClick={addExemplar} disabled={!draft}>
            Add exemplar
          </button>
        </>
      )}
      <p>
        <label>
          Candidates per frame{" "}
          <select
            value={det.topk}
            onChange={(e) => onDetector({ ...det, topk: Number(e.target.value) })}
          >
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
      <p>
        <button onClick={run} disabled={!hasExemplars || dirty || !info?.available}>
          Run detection
        </button>
        {dirty && <em> Save settings first.</em>}{" "}
        {job && (job.status === "queued" || job.status === "running") && (
          <span>
            Detecting… {progress?.done ?? 0}/{progress?.total ?? "?"}
          </span>
        )}
        {job?.status === "done" && job.result && (
          <span>
            Detected {job.result.detected} frames, {job.result.needs_review} need review
            {job.result.skipped_human ? `, ${job.result.skipped_human} kept as decided` : ""}.
          </span>
        )}
        {job?.status === "error" && <span role="alert">{job.error}</span>}
      </p>

      {list && (
        <section aria-label="Review queue">
          <h4>
            Review ({toCheck} to check
            {list.counts.trusted ? `, ${list.counts.trusted} trusted` : ""}
            {list.counts.human ? `, ${list.counts.human} decided` : ""})
          </h4>
          <label>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show
            all frames, least confident first
          </label>
          {showAll && confidences.length > 0 && (
            <p>
              Confidence of the shown boxes: {Math.round(Math.min(...confidences) * 100)}% to{" "}
              {Math.round(Math.max(...confidences) * 100)}% (threshold{" "}
              {Math.round(list.threshold * 100)}%).
            </p>
          )}
          {list.frames.length === 0 && <p>Nothing to review.</p>}
          {list.frames.length > 0 && (
            <>
              <label>
                Frame{" "}
                <select value={reviewFrame} onChange={(e) => setReviewFrame(e.target.value)}>
                  {list.frames.map((f) => (
                    <option key={f.frame} value={f.frame}>
                      {f.frame} — {f.state === "none" ? "no detection" : `${Math.round((f.boxes[0]?.conf ?? 0) * 100)}%`}
                      {f.state === "human" ? " (decided)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {reviewUrl && (
                <RoiCanvas
                  imageUrl={reviewUrl}
                  mode={reviewBox ? "edit" : "draw"}
                  box={reviewBox}
                  onChange={setReviewBox}
                  maxWidth={500}
                />
              )}
              <p>
                <button
                  disabled={!reviewBox}
                  onClick={() =>
                    reviewBox && decide(() => api.putDetection(camera, feature, reviewFrame, roundBox(reviewBox), "reviewed"))
                  }
                >
                  Accept box
                </button>{" "}
                <button onClick={() => decide(() => api.deleteDetection(camera, feature, reviewFrame))}>
                  Clear
                </button>{" "}
                <em>Adjusted boxes are saved as manual and kept when detection is re-run.</em>
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
