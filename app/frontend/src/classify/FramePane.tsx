import { ReactNode, useEffect, useRef, useState } from "react";
import { frameImageUrl } from "../api";
import { FIT_VIEW, pointOffset, View, viewForOffset } from "../zoomGeometry";
import ZoomPane from "../ZoomPane";

/** A rectangle in the frame's own normalised coordinates, e.g. an ROI. */
export interface Outline {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The full frame in a zoom pane (wheel zoom at the cursor, drag pans, the same pane the ROI editor uses), with an
 * optional yellow outline. The zoom and pan are kept when the frame changes, so the same spot can be compared across
 * pictures. Shared by the viewers that show a plain frame.
 */
export default function FramePane({ camera, frame, width, outline, info, imageUrl, overlay, view: given, onViewChange, fixPoint, compare }: {
  camera: string;
  frame: string;
  width: number;
  outline?: Outline | null;
  info?: ReactNode;
  /** Show this picture instead of the frame itself (a Chain box's cut-out), and draw `overlay` over it. */
  imageUrl?: string;
  /** Drawn over the picture, given the picture's own size in pixels (an SVG with that viewBox fits it exactly). */
  overlay?: (size: { w: number; h: number }) => ReactNode;
  /** Zoom and pan owned by the caller (so two views of one picture can share them); the pane keeps its own when not given. */
  view?: View;
  onViewChange?: (view: View) => void;
  /**
   * A reference point of this picture (picture pixels). While `on`, the view moves with it from picture to picture, so the
   * point stays where it was on screen (zoom kept) and the picture shifts under it; a zoom or pan of the user's own sets
   * the place to keep. A picture with no point (`null`) leaves the view as it is. Off: the view stays on the same place
   * of the picture, as before.
   */
  fixPoint?: { on: boolean; point: { x: number; y: number } | null };
  /**
   * A second picture to flip to (an Evaluation's reference picture). While `on` it is shown instead of `frame`, at the zoom
   * of the shown view and placed so its `point` lies exactly where `fixPoint.point` of `frame` was on screen; pans and zooms
   * are ignored meanwhile. Off, it is only preloaded. The two pictures are then comparable by eye around the reference point.
   */
  compare?: { on: boolean; frame: string; imageUrl?: string; point: { x: number; y: number } | null; overlay?: (size: { w: number; h: number }) => ReactNode };
}) {
  const [size, setSize] = useState({ w: 4, h: 3 });
  const [own, setOwn] = useState<View>(FIT_VIEW);
  const view = given ?? own;
  const setView = onViewChange ?? setOwn;
  const contentRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState("");
  const fix = useRef<{ off: { x: number; y: number } | null; frame: string | null }>({ off: null, frame: null });
  const on = !!fixPoint?.on;
  const point = fixPoint?.point ?? null;
  // A new picture: once it has loaded (its size is known) and has its point, put the point where it was; with nothing to keep yet, remember where it is now.
  useEffect(() => {
    if (!on) { fix.current = { off: null, frame: null }; return; }
    if (!point || loaded !== frame || fix.current.frame === frame) return;
    fix.current.frame = frame;
    if (fix.current.off) setView(viewForOffset(view, point, fix.current.off, size));
    else fix.current.off = pointOffset(view, point, size);
  }, [on, point?.x, point?.y, loaded, frame]); // eslint-disable-line react-hooks/exhaustive-deps
  const [altSize, setAltSize] = useState({ w: 4, h: 3 });
  const showAlt = !!compare?.on;
  const aligned = showAlt && point && compare?.point ? viewForOffset(view, compare.point, pointOffset(view, point, size), altSize) : view;
  const altUrl = compare ? compare.imageUrl ?? frameImageUrl(camera, compare.frame) : null;
  const change = (v: View) => {
    if (showAlt) return;
    setView(v);
    if (on && point && loaded === frame) fix.current.off = pointOffset(v, point, size);
  };
  return (
    <ZoomPane imageSize={showAlt ? altSize : size} width={width} view={aligned} onViewChange={change} panOnBackground contentRef={contentRef} resetOnZero={false} info={info}>
      {showAlt && compare ? (
        <img
          key={`alt:${compare.frame}`}
          src={altUrl ?? undefined}
          alt={compare.frame}
          draggable={false}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      ) : (
        <img
          key={frame}
          src={imageUrl ?? frameImageUrl(camera, frame)}
          alt={frame}
          draggable={false}
          onLoad={(e) => { setSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 }); setLoaded(frame); }}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}
      {showAlt && compare ? compare.overlay?.(altSize) : overlay?.(size)}
      {compare && !showAlt && <img src={altUrl ?? undefined} alt="" aria-hidden="true" onLoad={(e) => setAltSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 })} style={{ display: "none" }} />}
      {outline && (
        <div
          data-testid="viewer-roi"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${outline.x * 100}%`,
            top: `${outline.y * 100}%`,
            width: `${outline.w * 100}%`,
            height: `${outline.h * 100}%`,
            boxSizing: "border-box",
            border: "2px solid #ffd400",
            boxShadow: "0 0 0 1px rgba(0,0,0,.65), inset 0 0 0 1px rgba(0,0,0,.65)",
            pointerEvents: "none",
          }}
        />
      )}
    </ZoomPane>
  );
}
