import { useEffect, useMemo, useRef, useState } from "react";
import { api, flowPictureUrl, FlowBox, FlowCrop, FlowFollow, FlowNodeDetail } from "../api";
import PictureSizeSlider, { usePictureSize } from "../PictureSize";
import RoiCanvas from "../RoiCanvas";
import { Box, MIN_SIZE } from "../roiGeometry";
import { FIT_VIEW, View } from "../zoomGeometry";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const boxOf = (rect: FlowCrop["rect"]): Box | null => (rect ? { x: rect[0], y: rect[1], w: rect[2], h: rect[3] } : null);

/**
 * The page of a Crop box: the ROI editor's canvas (wheel zoom, pan, Reset, 1:1) on the picture that enters the box,
 * one rectangle to draw, move and resize, and the cut-out it makes. The rectangle is saved when the pointer is
 * released. The same rectangle cuts every picture (it is stored as fractions of the input picture).
 */
type Props = {
  camera: string;
  nodeId: string;
  detail: FlowCrop;
  setDetail: (d: FlowNodeDetail) => void;
  onChanged: () => void;
  onError: (e: string | null) => void;
};

/** The page of a Crop box: a fixed rectangle, or - when a detector target feeds it - a rectangle that follows that target. */
export default function CropWork(p: Props) {
  return p.detail.follow ? <FollowCrop {...p} follow={p.detail.follow} /> : <StaticCrop {...p} />;
}

function StaticCrop(p: Props) {
  const { camera, nodeId, detail } = p;
  const [size, setSize] = usePictureSize("flow.cropSize", 900, 200, 1600);
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [view, setView] = useState<View>(FIT_VIEW);
  const [box, setBox] = useState<Box | null>(boxOf(detail.rect));
  const latest = useRef<Box | null>(box);
  const dirty = useRef(false);

  useEffect(() => {
    api.frames(p.camera).then((r) => {
      setFrames(r.frames);
      setFrame((cur) => (r.frames.includes(cur) ? cur : r.reference_frame && r.frames.includes(r.reference_frame) ? r.reference_frame : r.frames[0] ?? ""));
    }).catch((e) => p.onError(msg(e)));
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setBox(boxOf(detail.rect)); latest.current = boxOf(detail.rect); }, [detail.rect]);
  useEffect(() => setView(FIT_VIEW), [nodeId]);

  const change = (b: Box) => {
    latest.current = b;
    dirty.current = true;
    setBox(b);
  };
  const save = async (rect: FlowCrop["rect"]) => {
    try {
      const next = await api.flowUpdate(camera, nodeId, { rect });
      p.setDetail(await api.flowNode(camera, nodeId).catch(() => next as unknown as FlowNodeDetail));
      p.onError(null);
      p.onChanged();
    } catch (e) {
      p.onError(msg(e));
      setBox(boxOf(detail.rect));
    }
  };
  // Saved on release: a drag that ends (draw, move or resize) stores the rectangle as it is now.
  const release = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const b = latest.current;
    if (!b || b.w < MIN_SIZE || b.h < MIN_SIZE) { setBox(boxOf(detail.rect)); return; }
    void save([b.x, b.y, b.w, b.h]);
  };

  const at = frames.indexOf(frame);
  const key = [detail.crops, detail.rect];
  return (
    <div className="flow-work" data-testid="crop-work">
      <div className="flow-nav">
        <label>
          Picture{" "}
          <select value={frame} onChange={(e) => setFrame(e.target.value)}>
            {frames.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <button type="button" disabled={at <= 0} onClick={() => setFrame(frames[at - 1])}>‹ Previous</button>
        <button type="button" disabled={at < 0 || at >= frames.length - 1} onClick={() => setFrame(frames[at + 1])}>Next ›</button>
        <button type="button" disabled={!detail.rect} onClick={() => void save(null)}>Clear crop</button>
        <PictureSizeSlider value={size} onChange={setSize} min={200} max={1600} />
      </div>
      <p className="muted">
        {box
          ? "Drag the rectangle to move it, or a corner or edge to resize it; it is saved when you let go. Wheel zooms, drag the background to pan."
          : "Drag on the picture to draw the crop rectangle. Wheel zooms, middle button or Space + drag pans."}
      </p>
      {frame ? (
        <div onPointerUpCapture={release} onPointerCancelCapture={release}>
          <RoiCanvas
            imageUrl={flowPictureUrl(camera, nodeId, frame, { key: detail.crops })}
            mode={box ? "edit" : "draw"}
            box={box}
            onChange={change}
            width={size}
            view={view}
            onViewChange={setView}
          />
        </div>
      ) : (
        <p className="flow-empty">No pictures yet: add some in Ingest first.</p>
      )}
      {frame && detail.rect && (
        <div>
          <h4>Result</h4>
          <img src={flowPictureUrl(camera, nodeId, frame, { stage: "output", size: 360, key })} alt={`${frame} cropped`} style={{ maxWidth: "100%", border: "1px solid var(--border)" }} />
        </div>
      )}
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
 * A Crop fed by one target of a detector. The page shows the whole picture the detector works on, with the box the
 * detector found for the target (green outline). The rectangle is drawn once; on every other picture it is shown at the
 * same place next to the found target, so moving through the pictures shows what the Crop will cut. Saved on release.
 */
function FollowCrop(p: Props & { follow: FlowFollow }) {
  const { camera, nodeId, detail, follow } = p;
  const [size, setSize] = usePictureSize("flow.cropSize", 900, 200, 1600);
  const [frames, setFrames] = useState<string[]>([]);
  const [frame, setFrame] = useState("");
  const [view, setView] = useState<View>(FIT_VIEW);
  const [found, setFound] = useState<Record<string, Record<string, FlowBox>>>({});
  const [box, setBox] = useState<Box | null>(null);
  const latest = useRef<Box | null>(null);
  const dirty = useRef(false);
  const missing = useMemo(() => new Set(follow.missing), [follow.missing]);
  const url = frame ? flowPictureUrl(camera, nodeId, frame, { key: detail.crops }) : "";
  const pixels = usePictureSize2(url);
  const target = frame ? found[frame]?.[follow.target] : undefined;

  useEffect(() => {
    api.frames(camera).then((r) => {
      setFrames(r.frames);
      setFrame((cur) => (r.frames.includes(cur) ? cur : follow.frame && r.frames.includes(follow.frame) ? follow.frame : r.frames.find((f) => !follow.missing.includes(f)) ?? r.frames[0] ?? ""));
    }).catch((e) => p.onError(msg(e)));
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let current = true;
    api.flowBoxes(camera, follow.detector).then((b) => { if (current) setFound(b.boxes); }).catch((e) => p.onError(msg(e)));
    return () => { current = false; };
  }, [camera, follow.detector, follow.missing.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setView(FIT_VIEW), [nodeId]);

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
  const save = async (body: Record<string, unknown>) => {
    try {
      const next = await api.flowUpdate(camera, nodeId, body);
      p.setDetail(await api.flowNode(camera, nodeId).catch(() => next as unknown as FlowNodeDetail));
      p.onError(null);
      p.onChanged();
    } catch (e) {
      p.onError(msg(e));
      setBox(null);
    }
  };
  const release = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const b = latest.current;
    if (!b || !pixels || b.w * pixels.w < 2 || b.h * pixels.h < 2) return;
    void save({ follow: { frame, rect: [b.x * pixels.w, b.y * pixels.h, b.w * pixels.w, b.h * pixels.h] } });
  };

  const at = frames.indexOf(frame);
  const others = target && pixels ? [{ name: follow.target, box: { x: (target.x + 0.5 - target.w / 2) / pixels.w, y: (target.y + 0.5 - target.h / 2) / pixels.h, w: target.w / pixels.w, h: target.h / pixels.h } }] : [];
  const drawn = !!follow.size;
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
        <button type="button" disabled={!drawn} onClick={() => void save({ follow: null })}>Clear rectangle</button>
        <PictureSizeSlider value={size} onChange={setSize} min={200} max={1600} />
      </div>
      <p className="muted">
        {!target
          ? `${follow.detector} found no ${follow.target} on this picture, so there is no crop here. Pick a picture where it did.`
          : drawn
            ? "The green outline is the target the detector found. Drag the rectangle to move it, or a corner or edge to resize it; every picture is cut at the same place next to its target. Saved when you let go."
            : "The green outline is the target the detector found. Drag on the picture to draw the rectangle once; it then follows the target on every picture."}
      </p>
      {frame ? (
        <div onPointerUpCapture={release} onPointerCancelCapture={release} style={target ? undefined : { opacity: 0.55, pointerEvents: "none" }}>
          <RoiCanvas
            imageUrl={url}
            mode={box ? "edit" : "draw"}
            box={box}
            onChange={change}
            others={others}
            width={size}
            view={view}
            onViewChange={setView}
          />
        </div>
      ) : (
        <p className="flow-empty">No pictures yet: add some in Ingest first.</p>
      )}
      {frame && drawn && target && (
        <div>
          <h4>Result</h4>
          <img src={flowPictureUrl(camera, nodeId, frame, { stage: "output", size: 360, key: [detail.crops, follow.size, follow.offset] })} alt={`${frame} cropped`} style={{ maxWidth: "100%", border: "1px solid var(--border)" }} />
        </div>
      )}
    </div>
  );
}
