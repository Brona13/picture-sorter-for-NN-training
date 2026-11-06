import { ReactNode, useEffect, useRef, useState } from "react";
import { makePictureCache } from "./pictureCache";
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
export default function FramePane({ camera, frame, width, outline, info, imageUrl, preload, overlay, view: given, onViewChange, fixPoint, compare }: {
  camera: string;
  frame: string;
  width: number;
  outline?: Outline | null;
  info?: ReactNode;
  /** Show this picture instead of the frame itself (a Chain box's cut-out), and draw `overlay` over it. */
  imageUrl?: string;
  /**
   * Pictures the viewer is likely to show next (the neighbours in the list). Given, they are fetched and decoded ahead, and
   * the picture being left stays on screen until the next one is ready, so browsing never shows an empty gap. Left out, the
   * pane loads the picture the plain way, but still keeps the old one on screen until the new one has arrived.
   */
  preload?: string[];
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
  // The picture on screen stays until the next one has loaded and decoded, so a change of picture never shows a gap.
  const wanted = imageUrl ?? frameImageUrl(camera, frame);
  const [shown, setShown] = useState({ url: wanted, src: wanted, frame });
  const shownSrc = useRef(shown.src);
  shownSrc.current = shown.src;
  const cache = useRef<ReturnType<typeof makePictureCache> | null>(null);
  if (!cache.current) cache.current = makePictureCache(() => shownSrc.current);
  useEffect(() => () => cache.current?.dispose(), []);
  useEffect(() => {
    if (shown.url === wanted) return;
    let dead = false;
    const arrive = (src: string, w: number, h: number) => {
      if (dead) return;
      if (w && h) setSize({ w, h });
      setLoaded(frame);
      setShown({ url: wanted, src, frame });
    };
    if (typeof Image.prototype.decode !== "function") return arrive(wanted, 0, 0); // no decode() to wait for (a test DOM): swap at once
    const resolve = preload ? cache.current!.load(wanted) : Promise.resolve(wanted);
    resolve
      .then((src) => {
        const im = new Image();
        im.src = src;
        if (!im.decode) return { src, w: 0, h: 0 }; // no decode(): show it at once, its onLoad gives the size
        return im.decode().then(() => ({ src, w: im.naturalWidth, h: im.naturalHeight }));
      })
      .catch(() => ({ src: wanted, w: 0, h: 0 })) // a picture that cannot be had (404): show it the usual way
      .then((r) => arrive(r.src, r.w, r.h));
    return () => { dead = true; };
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const preloadKey = (preload ?? []).join("\n");
  useEffect(() => {
    if (!preload || typeof Image.prototype.decode !== "function") return;
    preload.forEach((u) => cache.current!.warm(u));
  }, [preloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
          src={shown.src}
          alt={shown.frame}
          draggable={false}
          onLoad={(e) => { setSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 }); setLoaded(shown.frame); }}
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
