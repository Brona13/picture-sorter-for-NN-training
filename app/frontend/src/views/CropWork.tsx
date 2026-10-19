import { useEffect, useRef, useState } from "react";
import { api, flowPictureUrl, FlowCrop, FlowNodeDetail } from "../api";
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
export default function CropWork(p: {
  camera: string;
  nodeId: string;
  detail: FlowCrop;
  setDetail: (d: FlowNodeDetail) => void;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
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
