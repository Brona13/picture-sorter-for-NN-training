import { useRef, useState } from "react";
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
export default function FramePane({ camera, frame, width, outline }: { camera: string; frame: string; width: number; outline?: Outline | null }) {
  const [size, setSize] = useState({ w: 4, h: 3 });
  const [view, setView] = useState<View>(FIT_VIEW);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <ZoomPane imageSize={size} width={width} view={view} onViewChange={setView} panOnBackground contentRef={contentRef} resetOnZero={false}>
      <img
        key={frame}
        src={frameImageUrl(camera, frame)}
        alt={frame}
        draggable={false}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 })}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
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
