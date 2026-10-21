import { ReactNode, useEffect, useRef, useState } from "react";
import { api, flowPictureUrl, RoiInfo } from "../api";
import FramePane from "./FramePane";
import PictureViewer from "./PictureViewer";
import { useBrowse } from "./useBrowse";
import { classColor } from "./colors";
import { MAX_SHORTCUT_CLASSES } from "./Card";
import { isClearKey } from "./paint";

interface Props {
  camera: string;
  /** The feature (ROI) the grid shows; its rectangle is drawn on the full frame. */
  feature?: string;
  /** The frames in the order of the grid underneath; the arrows walk this list. */
  frames: string[];
  /** The frame to start on. */
  start: string;
  classes: string[];
  marks: (frame: string) => { label: string | null; golden: string | null };
  busy: boolean;
  onLabel: (frame: string, cls: string | null) => void;
  onGolden: (frame: string, on: boolean) => void;
  onDelete: (frame: string) => void;
  /** A grid that keeps deleted frames on show: they cannot be labeled, and can be restored. */
  deleted?: (frame: string) => boolean;
  onRestore?: (frame: string) => void;
  /** Frames whose labels and golden cannot be changed here (a picture outside the ROI's scope found by search). */
  labelsLocked?: (frame: string) => boolean;
  /** Controls that start the label line, before the OK / NG buttons (a found picture's Product buttons). */
  lead?: (frame: string) => ReactNode;
  /** The caption of the OK / NG buttons when something precedes them on the line ("Feature"), or null for none. */
  leadCaption?: (frame: string) => string | null;
  /** Controls that end the label line, after the buttons (a found picture's "Show again"). */
  trail?: (frame: string) => ReactNode;
  /** A short note for the zoom line above the picture (one line, so nothing moves when it appears). */
  note?: (frame: string) => ReactNode;
  /** Called whenever the shown frame changes, so the grid can turn to the page that holds it. */
  onShow?: (frame: string) => void;
  onClose: () => void;
}

/**
 * Full-size look at the frames of a grid: the shared `PictureViewer` with the full frame in a zoom pane (wheel zoom,
 * pan, the same pane the ROI editor uses), the ROI outline, and the card's own actions for the frame on screen
 * (1-9 label, 0 or X clear, the key left of 1 golden, Delete).
 */
export default function FrameViewer({ camera, feature, frames, start, classes, marks, busy, onLabel, onGolden, onDelete, deleted, onRestore, labelsLocked, lead, leadCaption, trail, note, onShow, onClose }: Props) {
  const [roi, setRoi] = useState<RoiInfo | null>(null);
  const [showRoi, setShowRoi] = useState(true);
  useEffect(() => {
    if (!feature) return;
    let cancelled = false;
    const product = feature.includes("::") ? feature.split("::")[0] : undefined;
    api
      .rois(camera, product)
      .then((r) => !cancelled && setRoi(r.rois.find((x) => x.feature === feature) ?? null))
      .catch(() => !cancelled && setRoi(null)); // cosmetic: the picture is useful without the outline
    return () => {
      cancelled = true;
    };
  }, [camera, feature]);
  const { frame, index, go } = useBrowse(frames, start, onClose, onShow);
  // A detector-anchored ROI sits somewhere else on every picture (or nowhere: the detector found no box).
  const [placed, setPlaced] = useState<{ frame: string; rect: { x: number; y: number; w: number; h: number } | null } | null>(null);
  useEffect(() => {
    if (!feature || !roi?.anchored || !frame) { setPlaced(null); return; }
    let cancelled = false;
    api.roiRect(camera, feature, frame).then((r) => !cancelled && setPlaced({ frame, rect: r.rect })).catch(() => !cancelled && setPlaced(null));
    return () => { cancelled = true; };
  }, [camera, feature, frame, roi?.anchored]);
  const outline = roi && showRoi ? (roi.anchored ? (placed && placed.frame === frame && placed.rect ? { ...roi, ...placed.rect } : null) : roi) : null;
  const noAnchor = !!roi?.anchored && placed?.frame === frame && placed.rect === null;

  const latest = useRef({ frame, classes, busy, marks, onLabel, onGolden, onDelete, deleted, labelsLocked });
  latest.current = { frame, classes, busy, marks, onLabel, onGolden, onDelete, deleted, labelsLocked };
  // The label keys: 1-9 label, 0 clear, the key left of 1 golden, Delete deletes (the shell has Esc and the arrows).
  const onKey = (e: KeyboardEvent): boolean => {
    const cur = latest.current;
    const isGolden = e.code === "Backquote";
    const isDelete = e.key === "Delete";
    const digit = /^[0-9]$/.test(e.key);
    const clear = isClearKey(e);
    if (!isGolden && !isDelete && !digit && !clear) return false;
    if (e.repeat || cur.busy || !cur.frame || cur.deleted?.(cur.frame)) return true; // a deleted frame takes no label
    if (!isDelete && cur.labelsLocked?.(cur.frame)) return true; // nor does a frame outside the ROI's scope
    const m = cur.marks(cur.frame);
    if (isDelete) cur.onDelete(cur.frame);
    else if (isGolden) {
      if (m.label !== null) cur.onGolden(cur.frame, !m.golden);
    } else if (clear) {
      if (m.label !== null) cur.onLabel(cur.frame, null);
    } else {
      const n = Number(e.key);
      if (n === 0) {
        if (m.label !== null) cur.onLabel(cur.frame, null);
      } else {
        const cls = cur.classes[n - 1];
        if (cls !== undefined && n <= MAX_SHORTCUT_CLASSES) cur.onLabel(cur.frame, m.label === cls ? null : cls);
      }
    }
    return true;
  };

  if (!frame) return null;
  const mark = marks(frame);
  const isDeleted = !!deleted?.(frame);
  const locked = !!labelsLocked?.(frame);

  return (
    <PictureViewer
      label="Full-size picture"
      testId="frame-viewer"
      name={frame}
      index={index}
      total={frames.length}
      onGo={go}
      onClose={onClose}
      onKey={onKey}
      hint="Wheel zooms · drag pans · ← → browse · 1-9 label · 0 / X clear · ` golden · Delete deletes · Esc closes"
      toolbar={
        <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {lead?.(frame)}
        <div role="group" aria-label="Label" style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
          {leadCaption?.(frame) && <span style={{ fontSize: 12 }}>{leadCaption(frame)}</span>}
          {classes.map((c, i) => (
            <button
              key={c}
              type="button"
              disabled={busy || isDeleted || locked}
              aria-pressed={mark.label === c}
              title={i < MAX_SHORTCUT_CLASSES ? `Shortcut: press ${i + 1}.` : undefined}
              onClick={() => onLabel(frame, mark.label === c ? null : c)}
              style={mark.label === c ? { background: classColor(c, classes), color: "#fff" } : undefined}
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            aria-label={mark.golden ? "Remove golden" : "Make golden"}
            disabled={busy || isDeleted || locked || mark.label === null}
            title={mark.label === null ? "Label the frame first. Shortcut: the key left of 1." : "Golden reference for the label. Shortcut: the key left of 1."}
            onClick={() => onGolden(frame, !mark.golden)}
          >
            {mark.golden ? "⭐" : "☆"}
          </button>
          {trail?.(frame)}
        </div>
        </div>
        </div>
      }
      tools={
        <>
          {roi && (
            <button
              type="button"
              aria-label="Show ROI"
              aria-pressed={showRoi}
              title={`${showRoi ? "Hide" : "Show"} the ${roi.short_name} ROI outline on the frame`}
              onClick={() => setShowRoi((v) => !v)}
              style={showRoi ? { background: "rgba(255,212,0,.25)", borderColor: "#d9b300" } : undefined}
            >
              ▭
            </button>
          )}
          {isDeleted ? (
            <button type="button" aria-label="Restore frame" disabled={busy || !onRestore} title="Bring the deleted frame back" onClick={() => onRestore?.(frame)}>
              ♻
            </button>
          ) : (
            <button type="button" aria-label="Delete frame" disabled={busy} title="Soft-delete (Delete)" onClick={() => onDelete(frame)}>
              🗑
            </button>
          )}
        </>
      }
    >
      {(width) => <FramePane camera={camera} frame={frame} width={width} outline={outline} imageUrl={roi?.input ? flowPictureUrl(camera, roi.input, frame, { stage: "output" }) : undefined} info={noAnchor ? `${roi!.short_name}: the detector found no box here, so there is no ROI on this picture` : note?.(frame)} />}
    </PictureViewer>
  );
}
