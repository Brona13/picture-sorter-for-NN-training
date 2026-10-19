import { useEffect, useState } from "react";
import { api, ChainNode } from "../api";

type Props = {
  camera: string;
  roi: ChainNode;
  detectors: ChainNode[];
  onChanged: () => void;
  onError: (message: string) => void;
};

/**
 * Right-panel section of an ROI box: make it follow a box a detector finds (`anchor.py`). Usually set by dragging a
 * target's dot of the detector onto the ROI; here the options change. Either the ROI is the found box plus a margin, or
 * the user draws a rectangle (in the ROI editor, on the chosen example picture) and it keeps its place relative to the
 * box on every other picture. A picture without that box has no ROI there.
 */
export default function AnchorSection({ camera, roi, detectors, onChanged, onError }: Props) {
  const anchor = roi.anchor ?? null;
  const [detector, setDetector] = useState(anchor?.detector ?? detectors[0]?.id ?? "");
  const targets = detectors.find((d) => d.id === detector)?.flow?.targets ?? [];
  const [target, setTarget] = useState(anchor?.target ?? targets[0] ?? "");
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [follow, setFollow] = useState(anchor?.follow_rotation ?? false);
  const [mode, setMode] = useState<"box" | "rect">(anchor?.mode ?? "box");
  const [margin, setMargin] = useState(Math.round((anchor?.margin ?? 0.1) * 100));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  useEffect(() => {
    if (!targets.includes(target)) setTarget(targets[0] ?? "");
  }, [detector]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!detector || !target) { setFrames([]); return; }
    let live = true;
    api.flowBoxes(camera, detector).then((b) => {
      if (!live) return;
      const found = Object.entries(b.boxes).filter(([, boxes]) => boxes[target]).map(([f]) => f).sort();
      setFrames(found);
      setFrame((current) => (found.includes(current) ? current : found[0] ?? ""));
    }).catch((e) => onError(msg(e)));
    return () => { live = false; };
  }, [camera, detector, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try {
      await api.setRoiAnchor(camera, roi.ref!, mode === "box"
        ? { detector, target, mode, margin: Math.min(100, Math.max(0, margin)) / 100 }
        : { detector, target, mode, frame, follow_rotation: follow });
      onChanged();
    } catch (e) { onError(msg(e)); }
  };
  const remove = async () => {
    try {
      await api.clearRoiAnchor(camera, roi.ref!);
      onChanged();
    } catch (e) { onError(msg(e)); }
  };

  if (detectors.length === 0) return <p className="muted">Add a detector to let this ROI follow what it finds.</p>;
  return (
    <div className="chain-anchor">
      <h3>Anchor</h3>
      {anchor && (
        <p className="muted">
          {anchor.mode === "box" ? "Is the box found for" : "Follows a rectangle drawn relative to"} <strong>{anchor.target}</strong> of {anchor.detector}
          {anchor.mode === "rect" && anchor.follow_rotation ? ", turning with it" : ""}. Pictures without that box have no ROI.
        </p>
      )}
      <label>
        Detector
        <select value={detector} onChange={(e) => setDetector(e.target.value)}>
          {detectors.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </label>
      <label>
        Target
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>The ROI is</legend>
        <label>
          <input type="radio" name={`anchor-mode-${roi.id}`} checked={mode === "box"} onChange={() => setMode("box")} /> the found box (plus a margin)
        </label>
        <label>
          <input type="radio" name={`anchor-mode-${roi.id}`} checked={mode === "rect"} onChange={() => setMode("rect")} /> my own rectangle, related to the box
        </label>
      </fieldset>
      {mode === "box" ? (
        <label>
          Margin on each side (%)
          <input type="number" min={0} max={100} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
        </label>
      ) : (
        <>
          <label>
            Rectangle drawn on
            <select value={frame} onChange={(e) => setFrame(e.target.value)} disabled={frames.length === 0}>
              {frames.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow rotation
          </label>
          <p className="muted">Draw or change the rectangle in the ROI editor: it opens on this picture with the found box outlined.</p>
          {frames.length === 0 && <p className="muted">Run the detector first: this target has no box on any picture yet.</p>}
        </>
      )}
      <button type="button" disabled={!detector || !target || (mode === "rect" && !frame)} onClick={() => void save()}>{anchor ? "Update anchor" : "Set anchor"}</button>
      {anchor && <button type="button" onClick={() => void remove()}>Remove anchor</button>}
    </div>
  );
}
