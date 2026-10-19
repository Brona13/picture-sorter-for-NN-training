import { ReactNode, useRef, useState } from "react";
import { frameImageUrl } from "../api";
import { FIT_VIEW, View } from "../zoomGeometry";
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
export default function FramePane({ camera, frame, width, outline, info, imageUrl, overlay }: {
  camera: string;
  frame: string;
  width: number;
  outline?: Outline | null;
  info?: ReactNode;
  /** Show this picture instead of the frame itself (a Chain box's cut-out), and draw `overlay` over it. */
  imageUrl?: string;
  /** Drawn over the picture, given the picture's own size in pixels (an SVG with that viewBox fits it exactly). */
  overlay?: (size: { w: number; h: number }) => ReactNode;
}) {
  const [size, setSize] = useState({ w: 4, h: 3 });
  const [view, setView] = useState<View>(FIT_VIEW);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <ZoomPane imageSize={size} width={width} view={view} onViewChange={setView} panOnBackground contentRef={contentRef} resetOnZero={false} info={info}>
      <img
        key={frame}
        src={imageUrl ?? frameImageUrl(camera, frame)}
        alt={frame}
        draggable={false}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 })}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {overlay?.(size)}
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
