import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import {
  Box,
  boxFromDrag,
  boxStyle,
  Handle,
  HANDLE_CURSOR,
  moveBox,
  Point,
  pointerToNorm,
  resizeBox,
} from "./roiGeometry";
import ZoomPane from "./ZoomPane";
import { FIT_VIEW, View } from "./zoomGeometry";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_POS: Record<Handle, [string, string]> = {
  nw: ["0%", "0%"],
  n: ["50%", "0%"],
  ne: ["100%", "0%"],
  e: ["100%", "50%"],
  se: ["100%", "100%"],
  s: ["50%", "100%"],
  sw: ["0%", "100%"],
  w: ["0%", "50%"],
};

type Drag =
  | { kind: "draw"; start: Point }
  | { kind: "move"; start: Point; origin: Box }
  | { kind: "resize"; start: Point; origin: Box; handle: Handle };

interface Props {
  imageUrl: string;
  /** "draw": drag on the image to create a rectangle. "edit": move/resize ``box``. */
  mode: "draw" | "edit";
  box: Box | null;
  onChange: (box: Box) => void;
  /** Other ROIs, drawn as green outlines for reference. */
  others?: { name: string; box: Box }[];
  /** Alternative text of the picture (default: "Frame to draw on"). */
  alt?: string;
  maxWidth?: number;
  /** Exact display width in px (the picture may be scaled up); without it the picture keeps its own size up to ``maxWidth``. */
  width?: number;
  /** Zoom and position; give both to keep them across frames, leave both out to let the canvas keep its own. */
  view?: View;
  onViewChange?: (view: View) => void;
}

/**
 * The frame in a zoomable box (wheel zooms at the cursor; pan with the middle button or Space + drag, and in
 * edit mode also by dragging the background). Draw mode: drag to create a rectangle. Edit mode: drag the box
 * to move it or a handle to resize it. The box stays in normalised coordinates at any zoom.
 */
export default function RoiCanvas({ imageUrl, mode, box, onChange, others = [], alt = "Frame to draw on", maxWidth = 1100, width, view, onViewChange }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 4, h: 3 }); // picture size in pixels (a placeholder shape until it loads)
  const [hover, setHover] = useState<Point | null>(null);
  const [ownView, setOwnView] = useState<View>(FIT_VIEW);

  const norm = (e: ReactPointerEvent) => pointerToNorm(e.clientX, e.clientY, area.current!.getBoundingClientRect());

  function begin(e: ReactPointerEvent, d: (p: Point) => Drag) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = d(norm(e));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const p = norm(e);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "draw") onChange(boxFromDrag(d.start, p));
    else if (d.kind === "move") onChange(moveBox(d.origin, p.x - d.start.x, p.y - d.start.y));
    else onChange(resizeBox(d.origin, d.handle, p.x - d.start.x, p.y - d.start.y));
  }

  const end = () => {
    drag.current = null;
  };

  const readout = [
    hover ? `pixel ${Math.min(Math.floor(hover.x * size.w), size.w - 1)}, ${Math.min(Math.floor(hover.y * size.h), size.h - 1)}` : null,
    box ? `box ${Math.round(box.w * size.w)} × ${Math.round(box.h * size.h)} px` : null,
  ]
    .filter(Boolean)
    .join("  |  ");

  return (
    <ZoomPane
      imageSize={size}
      width={width ?? maxWidth}
      view={view ?? ownView}
      onViewChange={onViewChange ?? setOwnView}
      panOnBackground={mode === "edit"}
      contentRef={area}
      contentTestId="roi-canvas"
      contentHandlers={{
        onPointerDown: mode === "draw" ? (e) => begin(e, (start) => ({ kind: "draw", start })) : undefined,
        onPointerMove,
        onPointerUp: end,
        onPointerCancel: end,
        onPointerLeave: () => setHover(null),
      }}
      contentCursor={mode === "draw" ? "crosshair" : "default"}
      info={readout}
    >
      <img
        src={imageUrl}
        alt={alt}
        draggable={false}
        style={{ width: "100%", height: "100%", display: "block" }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) setSize({ w: img.naturalWidth, h: img.naturalHeight });
        }}
      />
      {others.map((o) => (
        <div
          key={o.name}
          title={o.name}
          style={{ position: "absolute", border: "2px solid #1a7f37", pointerEvents: "none", ...boxStyle(o.box) }}
        />
      ))}
      {box && (
        <div
          data-testid="roi-box"
          style={{
            position: "absolute",
            border: "2px solid #ff3030",
            background: "rgba(255,165,0,0.2)",
            cursor: mode === "edit" ? "move" : "crosshair",
            pointerEvents: mode === "edit" ? "auto" : "none",
            ...boxStyle(box),
          }}
          onPointerDown={
            mode === "edit" ? (e) => begin(e, (start) => ({ kind: "move", start, origin: box })) : undefined
          }
        >
          {mode === "edit" &&
            HANDLES.map((h) => (
              <div
                key={h}
                data-testid={`handle-${h}`}
                onPointerDown={(e) => begin(e, (start) => ({ kind: "resize", start, origin: box, handle: h }))}
                style={{
                  position: "absolute",
                  left: HANDLE_POS[h][0],
                  top: HANDLE_POS[h][1],
                  width: 12,
                  height: 12,
                  marginLeft: -6,
                  marginTop: -6,
                  background: "#ff3030",
                  border: "1px solid #fff",
                  cursor: HANDLE_CURSOR[h],
                }}
              />
            ))}
        </div>
      )}
    </ZoomPane>
  );
}
