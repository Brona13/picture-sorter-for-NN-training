import { PointerEvent as ReactPointerEvent, useRef } from "react";
import {
  Box,
  boxFromDrag,
  boxStyle,
  Handle,
  moveBox,
  Point,
  pointerToNorm,
  resizeBox,
} from "./roiGeometry";

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
const CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
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
  maxWidth?: number;
}

export default function RoiCanvas({ imageUrl, mode, box, onChange, others = [], maxWidth = 1100 }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const norm = (e: ReactPointerEvent) => pointerToNorm(e.clientX, e.clientY, area.current!.getBoundingClientRect());

  function begin(e: ReactPointerEvent, d: (p: Point) => Drag) {
    e.stopPropagation();
    e.preventDefault();
    drag.current = d(norm(e));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = norm(e);
    if (d.kind === "draw") onChange(boxFromDrag(d.start, p));
    else if (d.kind === "move") onChange(moveBox(d.origin, p.x - d.start.x, p.y - d.start.y));
    else onChange(resizeBox(d.origin, d.handle, p.x - d.start.x, p.y - d.start.y));
  }

  const end = () => {
    drag.current = null;
  };

  return (
    <div
      ref={area}
      data-testid="roi-canvas"
      style={{ position: "relative", maxWidth, lineHeight: 0, touchAction: "none", userSelect: "none" }}
      onPointerDown={mode === "draw" ? (e) => begin(e, (start) => ({ kind: "draw", start })) : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img src={imageUrl} alt="Frame to draw on" draggable={false} style={{ width: "100%", display: "block" }} />
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
                  cursor: CURSOR[h],
                }}
              />
            ))}
        </div>
      )}
    </div>
  );
}
