import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { Point, pointerToNorm } from "./roiGeometry";
import { dragHandle, handlesOf, MaskShape, moveShape, removeVertex } from "./shapeGeometry";

type Drag =
  | { kind: "move"; start: Point; origin: MaskShape }
  | { kind: "handle"; id: string; start: Point; origin: MaskShape };

interface Props {
  imageUrl: string;
  shape: MaskShape | null;
  onChange: (shape: MaskShape) => void;
  maxWidth?: number;
}

const STROKE = "#ff3030";

/** Image with an editable rectangle / circle / polygon overlay (normalised coordinates). */
export default function ShapeCanvas({ imageUrl, shape, onChange, maxWidth = 700 }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [aspect, setAspect] = useState(1); // image width / height in pixels

  const norm = (e: ReactPointerEvent) =>
    pointerToNorm(e.clientX, e.clientY, area.current!.getBoundingClientRect());

  function begin(e: ReactPointerEvent, make: (start: Point) => Drag) {
    e.stopPropagation();
    e.preventDefault();
    drag.current = make(norm(e));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = norm(e);
    onChange(
      d.kind === "move"
        ? moveShape(d.origin, p.x - d.start.x, p.y - d.start.y, aspect)
        : dragHandle(d.origin, d.id, d.start, p, aspect),
    );
  }

  const end = () => {
    drag.current = null;
  };

  const outline = (s: MaskShape) => {
    const common = {
      fill: "rgba(255,165,0,0.2)",
      stroke: STROKE,
      strokeWidth: 2,
      vectorEffect: "non-scaling-stroke" as const,
      style: { cursor: "move", pointerEvents: "auto" as const },
      onPointerDown: (e: ReactPointerEvent) => begin(e, (start) => ({ kind: "move", start, origin: s })),
    };
    if (s.shape === "rect") return <rect data-testid="mask-outline" x={s.x} y={s.y} width={s.w} height={s.h} {...common} />;
    if (s.shape === "circle")
      return <ellipse data-testid="mask-outline" cx={s.cx} cy={s.cy} rx={s.r} ry={s.r * aspect} {...common} />;
    return <polygon data-testid="mask-outline" points={s.points.map((p) => `${p.x},${p.y}`).join(" ")} {...common} />;
  };

  return (
    <div
      ref={area}
      data-testid="shape-canvas"
      style={{ position: "relative", maxWidth, lineHeight: 0, touchAction: "none", userSelect: "none" }}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img
        src={imageUrl}
        alt="Crop to mask"
        draggable={false}
        style={{ width: "100%", display: "block" }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
        }}
      />
      {shape && (
        <>
          <svg
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          >
            {outline(shape)}
          </svg>
          {handlesOf(shape).map((h) => (
            <div
              key={h.id}
              data-testid={`handle-${h.id}`}
              title={shape.shape === "polygon" ? "Drag to move; double-click to remove" : undefined}
              onPointerDown={(e) => begin(e, (start) => ({ kind: "handle", id: h.id, start, origin: shape }))}
              onDoubleClick={() => shape.shape === "polygon" && onChange(removeVertex(shape, Number(h.id.slice(1))))}
              style={{
                position: "absolute",
                left: `${h.x * 100}%`,
                top: `${h.y * 100}%`,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                background: STROKE,
                border: "1px solid #fff",
                cursor: "pointer",
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
