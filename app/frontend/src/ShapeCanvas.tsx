import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { Point, pointerToNorm } from "./roiGeometry";
import { dragHandle, handlesOf, insertVertex, MaskShape, MIN_POLYGON_POINTS, moveShape, removeVertex } from "./shapeGeometry";

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
  const [selected, setSelected] = useState<number | null>(null); // polygon vertex

  const norm = (e: { clientX: number; clientY: number }) =>
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
    return (
      <>
        <polygon data-testid="mask-outline" points={s.points.map((p) => `${p.x},${p.y}`).join(" ")} {...common} />
        {s.points.map((a, i) => {
          const b = s.points[(i + 1) % s.points.length];
          return (
            <line
              key={i}
              data-testid={`edge-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="transparent"
              strokeWidth={12}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: "copy", pointerEvents: "stroke" }}
              onPointerDown={common.onPointerDown}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onChange(insertVertex(s, norm(e)));
              }}
            />
          );
        })}
      </>
    );
  };

  const polygonPoints = shape?.shape === "polygon" ? shape.points.length : 0;
  const removeAt = (i: number) => {
    if (shape?.shape !== "polygon") return;
    onChange(removeVertex(shape, i));
    setSelected(null);
  };

  return (
    <>
    <div
      ref={area}
      data-testid="shape-canvas"
      style={{ position: "relative", width: "fit-content", maxWidth, lineHeight: 0, touchAction: "none", userSelect: "none" }}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img
        src={imageUrl}
        alt="Crop to mask"
        draggable={false}
        style={{ maxWidth: "100%", display: "block" }}
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
              title={shape.shape === "polygon" ? "Drag to move; double-click or right-click to remove" : undefined}
              onPointerDown={(e) => {
                if (shape.shape === "polygon") setSelected(Number(h.id.slice(1)));
                begin(e, (start) => ({ kind: "handle", id: h.id, start, origin: shape }));
              }}
              onDoubleClick={() => shape.shape === "polygon" && removeAt(Number(h.id.slice(1)))}
              onContextMenu={(e) => {
                if (shape.shape !== "polygon") return;
                e.preventDefault();
                removeAt(Number(h.id.slice(1)));
              }}
              style={{
                position: "absolute",
                left: `${h.x * 100}%`,
                top: `${h.y * 100}%`,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                background: shape.shape === "polygon" && selected === Number(h.id.slice(1)) ? "#1a73e8" : STROKE,
                border: "1px solid #fff",
                cursor: "pointer",
              }}
            />
          ))}
        </>
      )}
    </div>
    {shape?.shape === "polygon" && (
      <p>
        Drag a point to move it. Double-click an edge to add a point there; double-click or
        right-click a point to remove it (at least {MIN_POLYGON_POINTS} stay).{" "}
        <button
          onClick={() => selected !== null && removeAt(selected)}
          disabled={selected === null || selected >= polygonPoints || polygonPoints <= MIN_POLYGON_POINTS}
        >
          Remove selected point
        </button>
      </p>
    )}
    </>
  );
}
