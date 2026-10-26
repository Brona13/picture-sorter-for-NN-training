import { useEffect, useMemo, useRef, useState } from "react";
import { api, flowPictureUrl, FlowBox, FlowCrop, FlowEdit, FlowFollow } from "../api";
import FramePane from "../classify/FramePane";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import RoiCanvas from "../RoiCanvas";
import { Box, MIN_SIZE } from "../roiGeometry";
import { FIT_VIEW, View } from "../zoomGeometry";
import type { PictureEdits } from "./pictureEdits";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const boxOf = (rect: [number, number, number, number] | null | undefined): Box | null => (rect ? { x: rect[0], y: rect[1], w: rect[2], h: rect[3] } : null);

/** The value after `ms` without a change: a slider dragged across a big picture asks the server for the last position only. */
function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return shown;
}

/**
 * The steps up to and including `index`, with that step blank (no rectangle, default parameters): the picture that
 * *enters* the step does not depend on the step itself, so drawing or tuning it must not reload that picture.
 */
export function entering(steps: FlowEdit[], index: number): FlowEdit[] {
  return steps.slice(0, index + 1).map((s, i) => (i < index ? s : s.op === "crop" ? { ...s, rect: null } : { ...s, params: {} }));
}

type Props = {
  camera: string;
  nodeId: string;
  detail: FlowCrop;
  edits: PictureEdits;
  onError: (e: string | null) => void;
};

/**
 * The work area of a Picture Edits box: the big picture of the selected step, live. A filter shows what it does to the
 * picture (**Before** / **After** toggle, one zoom for both); a crop step is drawn on the picture that enters it
 * (**Before**) and shows the cut-out (**After**). Zoom, pan and the picture size are shared with the ROI editor's canvas.
 */
export default function PictureEditsWork({ camera, nodeId, detail, edits, onError }: Props) {
  const { steps } = edits;
  const [size, setSize] = usePictureSize("flow.cropSize", 900, 200, 1600);
  const [frames, setFrames] = useState<string[]>([]);
  const [hasInput, setHasInput] = useState(true);
  const [frame, setFrame] = useState("");
  const [view, setView] = useState<View>(FIT_VIEW);
  const step = steps.find((s) => s.id === edits.selected) ?? null;
  const index = step ? steps.indexOf(step) : -1;
  const [show, setShow] = useState<"before" | "after">("before");
  const follow = detail.follow ?? null;
  const followIndex = follow ? steps.findIndex((s) => s.id === detail.follow_step) : -1;
  const isFollowStep = !!follow && step?.id === detail.follow_step;
  const missing = useMemo(() => new Set(follow?.missing ?? []), [follow?.missing]);
  const straight = isFollowStep && follow?.mode === "straighten"; // the picture is shown turned back by the found angle: the rectangle is drawn on the upright part

  useEffect(() => setShow(step?.op === "filter" ? "after" : "before"), [step?.id, step?.op]); // a filter is judged by its result, a crop is drawn first
  useEffect(() => setView(FIT_VIEW), [nodeId]);
  useEffect(() => {
    api.flowNodeFrames(camera, nodeId).then((r) => {
      setFrames(r.frames);
      setHasInput(r.has_input);
      setFrame((cur) => (r.frames.includes(cur) ? cur
        : follow?.frame && r.frames.includes(follow.frame) ? follow.frame
        : follow ? r.frames.find((f) => !follow.missing.includes(f)) ?? r.frames[0] ?? ""
        : r.reference_frame && r.frames.includes(r.reference_frame) ? r.reference_frame : r.frames[0] ?? ""));
    }).catch((e) => onError(msg(e)));
  }, [camera, nodeId, detail.input_box]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = useDebounced(steps, 120);
  const liveIndex = step ? live.findIndex((s) => s.id === step.id) : -1;
  const stepUrl = (stage: "input" | "output", extra: { size?: number; straighten?: boolean } = {}): string => {
    if (!frame) return "";
    if (!step || liveIndex < 0) return flowPictureUrl(camera, nodeId, frame, { key: detail.crops, ...extra });
    return flowPictureUrl(camera, nodeId, frame, {
      step: step.id, stage, key: detail.crops, steps: stage === "input" ? entering(live, liveIndex) : live.slice(0, liveIndex + 1), ...extra,
    });
  };
  // Behind the step that follows a detector target there is no picture where the target was not found.
  const blocked = (stage: "input" | "output") => !!follow && !!frame && missing.has(frame) && index >= 0 && (stage === "output" ? index >= followIndex : index > followIndex);

  const at = frames.indexOf(frame);
  const canvasMode = !!step && step.op === "crop" && show === "before";
  const title = step ? `Step ${index + 1} · ${step.op === "filter" ? edits.filters[step.name]?.label ?? step.name : "Crop"}` : "No step selected";

  return (
    <div className="flow-work" data-testid="crop-work">
      <div className="flow-nav">
        <label>
          Picture{" "}
          <select value={frame} onChange={(e) => setFrame(e.target.value)}>
            {frames.map((f) => <option key={f} value={f}>{f}{missing.has(f) ? " — no target found" : ""}</option>)}
          </select>
        </label>
        <button type="button" disabled={at <= 0} onClick={() => setFrame(frames[at - 1])}>‹ Previous</button>
        <button type="button" disabled={at < 0 || at >= frames.length - 1} onClick={() => setFrame(frames[at + 1])}>Next ›</button>
        <span role="group" aria-label="Show" style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {(["before", "after"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={show === v}
              disabled={!step}
              onClick={() => setShow(v)}
              style={{ border: 0, borderRadius: 0, padding: "4px 10px", background: show === v ? "var(--accent)" : "var(--panel)", color: show === v ? "var(--accent-fg)" : "var(--fg)", fontWeight: show === v ? 600 : 400 }}
            >
              {v === "before" ? "Before" : "After"}
            </button>
          ))}
        </span>
        <PictureSizeSlider value={size} onChange={setSize} min={200} max={1600} />
      </div>
      <p className="muted" data-testid="pe-hint">
        <strong>{title}.</strong>{" "}
        {!step
          ? "Add a step on the right. The picture shown is the one that enters this box."
          : step.op === "filter"
            ? show === "after" ? "The picture after this filter, live as you change it. Switch to Before to compare; the zoom stays." : "The picture as it enters this filter."
            : show === "after"
              ? "The picture after this crop."
              : isFollowStep ? "" : "Drag on the picture to draw the crop rectangle, or drag the rectangle to move it or a corner or edge to resize it; it is saved when you let go. Wheel zooms, middle button or Space + drag pans."}
      </p>
      {!frame ? (
        <p className="flow-empty">{hasInput ? "No pictures reach this box yet: add some in Ingest, or check what the box before it passes on." : "Nothing is drawn into this box, so it has no pictures. Draw a line into it on the Chain."}</p>
      ) : canvasMode && step && isFollowStep && follow ? (
        <FollowCanvas camera={camera} nodeId={nodeId} frame={frame} frames={frames} detail={detail} follow={follow} size={size} view={view} setView={setView} url={stepUrl("input", { straighten: straight })} straight={!!straight} edits={edits} onError={onError} />
      ) : canvasMode && step && step.op === "crop" ? (
        <StaticCanvas camera={camera} nodeId={nodeId} frame={frame} step={step} size={size} view={view} setView={setView} url={stepUrl("input")} edits={edits} blocked={blocked("input")} />
      ) : blocked(show === "after" ? "output" : "input") ? (
        <p className="flow-missing" role="status">{follow?.detector} found no {follow?.target} on this picture, so there is no picture here at this step.</p>
      ) : (
        <FramePane camera={camera} frame={frame} width={size} imageUrl={stepUrl(show === "after" ? "output" : "input")} view={view} onViewChange={setView} />
      )}
      {canvasMode && step?.op === "crop" && !isFollowStep && step.rect && !blocked("output") && (
        <div>
          <h4>Result</h4>
          <img src={stepUrl("output", { size: 360 })} alt={`${frame} cropped`} style={{ maxWidth: "100%", border: "1px solid var(--border)" }} />
        </div>
      )}
    </div>
  );
}

/** A fixed crop step drawn on the picture that enters it. Saved on release. */
function StaticCanvas({ frame, step, size, view, setView, url, edits, blocked }: {
  camera: string; nodeId: string; frame: string; step: Extract<FlowEdit, { op: "crop" }>; size: number; view: View; setView: (v: View) => void; url: string; edits: PictureEdits; blocked: boolean;
}) {
  const [box, setBox] = useState<Box | null>(boxOf(step.rect));
  const latest = useRef<Box | null>(box);
  const dirty = useRef(false);
  useEffect(() => { setBox(boxOf(step.rect)); latest.current = boxOf(step.rect); }, [step.rect, step.id]);

  const change = (b: Box) => {
    latest.current = b;
    dirty.current = true;
    setBox(b);
  };
  // Saved on release: a drag that ends (draw, move or resize) stores the rectangle as it is now.
  const release = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const b = latest.current;
    if (!b || b.w < MIN_SIZE || b.h < MIN_SIZE) { setBox(boxOf(step.rect)); return; }
    edits.setRect(step.id, [b.x, b.y, b.w, b.h]);
  };
  if (blocked) return <p className="flow-missing" role="status">There is no picture here: the crop before this step has no rectangle on it.</p>;
  return (
    <div onPointerUpCapture={release} onPointerCancelCapture={release} data-frame={frame}>
      <RoiCanvas imageUrl={url} mode={box ? "edit" : "draw"} box={box} onChange={change} width={size} view={view} onViewChange={setView} />
    </div>
  );
}

/** Size of a picture in pixels once it has loaded (null while loading or when it cannot be loaded). */
function usePictureSize2(url: string): { w: number; h: number } | null {
  const [size, setSize] = useState<{ src: string; w: number; h: number } | null>(null);
  const same = size && size.src === url ? size : null; // the state object itself: a new object every render would restart the effects that depend on it
  useEffect(() => {
    if (!url) return;
    let current = true;
    const img = new Image();
    img.onload = () => { if (current && img.naturalWidth) setSize({ src: url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = url;
    return () => { current = false; };
  }, [url]);
  return same;
}

/**
 * The crop step that follows one target of a detector. The page shows the whole picture the detector works on, with the
 * box the detector found for the target (green outline). The rectangle is drawn once; on every other picture it is shown at the
 * same place next to the found target, so moving through the pictures shows what the step will cut. Saved on release.
 */
function FollowCanvas({ camera, nodeId, frame, frames, detail, follow, size, view, setView, url, straight, edits, onError }: {
  camera: string; nodeId: string; frame: string; frames: string[]; detail: FlowCrop; follow: FlowFollow; size: number; view: View; setView: (v: View) => void; url: string; straight: boolean; edits: PictureEdits; onError: (e: string | null) => void;
}) {
  const [found, setFound] = useState<Record<string, Record<string, FlowBox>>>({});
  const [box, setBox] = useState<Box | null>(null);
  const latest = useRef<Box | null>(null);
  const dirty = useRef(false);
  const pixels = usePictureSize2(url);
  const target = found[frame]?.[follow.target];

  useEffect(() => {
    let current = true;
    api.flowBoxes(camera, follow.detector).then((b) => { if (current) setFound(b.boxes); }).catch((e) => onError(msg(e)));
    return () => { current = false; };
  }, [camera, follow.detector, follow.missing.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the rectangle lies on this picture: the drawn size and offset, next to the target found here (as the cut does).
  useEffect(() => {
    if (!pixels || !target || !follow.size || !follow.offset) { setBox(null); latest.current = null; return; }
    const [w, h] = follow.size;
    const x = target.x + 0.5 + follow.offset[0] - w / 2;
    const y = target.y + 0.5 + follow.offset[1] - h / 2;
    const b = { x: x / pixels.w, y: y / pixels.h, w: w / pixels.w, h: h / pixels.h };
    setBox(b);
    latest.current = b;
  }, [pixels, target, follow.size, follow.offset]);

  const change = (b: Box) => { latest.current = b; dirty.current = true; setBox(b); };
  const release = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const b = latest.current;
    if (!b || !pixels || b.w * pixels.w < 2 || b.h * pixels.h < 2) return;
    void edits.update({ follow: { frame, rect: [b.x * pixels.w, b.y * pixels.h, b.w * pixels.w, b.h * pixels.h] } });
  };

  const others = target && pixels ? [{ name: follow.target, box: { x: (target.x + 0.5 - target.w / 2) / pixels.w, y: (target.y + 0.5 - target.h / 2) / pixels.h, w: target.w / pixels.w, h: target.h / pixels.h } }] : [];
  const drawn = !!follow.size;
  const stepId = detail.follow_step;
  return (
    <>
      <p className="muted">
        {!target
          ? `${follow.detector} found no ${follow.target} on this picture, so there is no crop here. Pick a picture where it did.`
          : drawn
            ? "The green outline is the target the detector found. Drag the rectangle to move it, or a corner or edge to resize it; every picture is cut at the same place next to its target. Saved when you let go."
            : "The green outline is the target the detector found. Drag on the picture to draw the rectangle once; it then follows the target on every picture."}
        {straight && " The picture is shown turned back by the found angle, as the cut will be."}
      </p>
      <div onPointerUpCapture={release} onPointerCancelCapture={release} style={target ? undefined : { opacity: 0.55, pointerEvents: "none" }} data-step={stepId ?? undefined}>
        <RoiCanvas imageUrl={url} mode={box ? "edit" : "draw"} box={box} onChange={change} others={others} width={size} view={view} onViewChange={setView} />
      </div>
      <p>
        <button type="button" disabled={!drawn} onClick={() => void edits.update({ follow: null })}>Clear rectangle</button>
      </p>
      {drawn && target && frames.length > 0 && (
        <div>
          <h4>Result</h4>
          <img src={flowPictureUrl(camera, nodeId, frame, { step: stepId ?? undefined, stage: "output", size: 360, key: [detail.crops, follow.size, follow.offset] })} alt={`${frame} cropped`} style={{ maxWidth: "100%", border: "1px solid var(--border)" }} />
        </div>
      )}
    </>
  );
}
