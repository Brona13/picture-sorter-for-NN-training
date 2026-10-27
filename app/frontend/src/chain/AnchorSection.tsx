import { useEffect, useState } from "react";
import { api, ChainNode } from "../api";

type Props = {
  camera: string;
  roi: ChainNode;
  detectors: ChainNode[];
  onChanged: () => void;
  onError: (message: string) => void;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Right-panel section of a Classifier that follows a detector box (`anchor.py`). The line drawn from the detector's target
 * dot to the Classifier already says which detector and which target, so none is asked for here: only how the Classifier
 * uses that box. Either it is exactly the found box, or the user draws a rectangle (in the ROI editor, on the chosen
 * example picture) and it keeps its place relative to the box on every other picture. Every change is saved at once.
 * A picture without that box has no ROI there. Without a line there is no anchor and nothing is shown.
 */
export default function AnchorSection({ camera, roi, detectors, onChanged, onError }: Props) {
  const anchor = roi.anchor ?? null;
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState(anchor?.frame ?? "");
  const [follow, setFollow] = useState(anchor?.follow_rotation ?? false);
  const detector = anchor?.detector ?? "";
  const target = anchor?.target ?? "";
  const groups = detectors.find((d) => d.id === detector)?.flow?.groups ?? [];
  const together = groups.includes(target); // every box of the target becomes its own picture: no rectangle of one's own

  useEffect(() => {
    if (!detector || !target) { setFrames([]); return; }
    let live = true;
    api.flowBoxes(camera, detector).then((b) => {
      if (!live) return;
      const found = Object.entries(b.boxes).filter(([, boxes]) => boxes[target]).map(([f]) => f).sort();
      setFrames(found);
      setFrame((current) => (current && found.includes(current) ? current : found[0] ?? ""));
    }).catch((e) => onError(msg(e)));
    return () => { live = false; };
  }, [camera, detector, target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!anchor || !roi.ref) return null;
  const feature = roi.ref;

  const save = async (body: { mode: "box" } | { mode: "rect"; frame: string; follow_rotation: boolean }) => {
    try {
      await api.setRoiAnchor(camera, feature, { detector, target, ...body });
      onChanged();
    } catch (e) { onError(msg(e)); }
  };
  const chooseRect = (nextFrame: string, nextFollow: boolean) => {
    if (nextFrame) void save({ mode: "rect", frame: nextFrame, follow_rotation: nextFollow });
  };

  return (
    <div className="chain-anchor">
      <h3>Detector box</h3>
      <p className="muted">
        Uses the box found for <strong>{target}</strong> of {detector}. Pictures without that box have no ROI.
      </p>
      {together && <p className="muted">Every box of {target} becomes its own picture in the Classifier (picture name · box 1, 2, …, left to right): each one is labeled, sorted and plotted on its own.</p>}
      <fieldset>
        <legend>The ROI is</legend>
        <label>
          <input type="radio" name={`anchor-mode-${roi.id}`} checked={anchor.mode === "box"} onChange={() => void save({ mode: "box" })} /> the found box
        </label>
        <label>
          <input type="radio" name={`anchor-mode-${roi.id}`} checked={anchor.mode === "rect"} disabled={together || (anchor.mode !== "rect" && !frame)} onChange={() => chooseRect(frame, follow)} /> my own rectangle, related to the box
        </label>
      </fieldset>
      {anchor.mode === "rect" && (
        <>
          <label>
            Rectangle drawn on
            <select value={frame} onChange={(e) => { setFrame(e.target.value); chooseRect(e.target.value, follow); }} disabled={frames.length === 0}>
              {frames.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => { setFollow(e.target.checked); chooseRect(frame, e.target.checked); }} /> Follow rotation
          </label>
          <p className="muted">Draw or change the rectangle in the ROI editor: it opens on this picture with the found box outlined.</p>
        </>
      )}
      {anchor.mode !== "rect" && frames.length === 0 && <p className="muted">Run the detector first: this target has no box on any picture yet, so my own rectangle cannot be drawn.</p>}
      <p className="muted">To remove the link, delete the line on the Chain.</p>
    </div>
  );
}
