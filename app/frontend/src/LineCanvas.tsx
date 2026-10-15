import { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { bandCorners, bandHandle, halfWidthFromPointer, Line, longEnough } from "./lineGeometry";
import { Point, pointerToNorm } from "./roiGeometry";

type Drag = { kind: "p1" | "p2" | "band" };

interface Props {
  imageUrl: string;
  line: Line | null;
  halfWidth: number;
  /** What the detector found in the band: the points it used and the line it fitted. */
  overlay?: { points: Point[]; fitted: Point[] } | null;
  onChange: (line: Line | null, halfWidth: number) => void;
  maxWidth?: number;
}

const LINE = "#ff3030";
const FITTED = "#00c853";

/**
 * The ROI crop with the edge-angle line and its band. Click once to place the first point (the line
 * follows the cursor), click again to place the second; the band appears around the line. Drag
 * either end to adjust the line and the handle on one long side of the band to resize it.
 */
export default function LineCanvas({ imageUrl, line, halfWidth, overlay, onChange, maxWidth = 760 }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 1, h: 1 }); // image size in pixels
  const [first, setFirst] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const drawing = line === null;

  const norm = (e: { clientX: number; clientY: number }) => pointerToNorm(e.clientX, e.clientY, area.current!.getBoundingClientRect());

  function onClick(e: ReactMouseEvent) {
    if (!drawing) return;
    const p = norm(e);
    if (first === null) {
      setFirst(p);
      setCursor(p);
    } else if (longEnough(first, p, size.w, size.h)) {
      onChange({ p1: first, p2: p }, halfWidth);
      setFirst(null);
      setCursor(null);
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (drawing) {
      if (first !== null) setCursor(norm(e));
      return;
    }
    const d = drag.current;
    if (!d || !line) return;
    const p = norm(e);
    if (d.kind === "band") onChange(line, halfWidthFromPointer(p, line, size.w, size.h));
    else {
      const next = { ...line, [d.kind]: p };
      if (longEnough(next.p1, next.p2, size.w, size.h)) onChange(next, halfWidth);
    }
  }

  function begin(e: ReactPointerEvent, kind: Drag["kind"]) {
    e.stopPropagation();
    e.preventDefault();
    drag.current = { kind };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  const end = () => {
    drag.current = null;
  };

  const handle = (id: string, p: Point, kind: Drag["kind"], title: string) => (
    <div
      key={id}
      data-testid={`handle-${id}`}
      title={title}
      onPointerDown={(e) => begin(e, kind)}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: `${p.x * 100}%`,
        top: `${p.y * 100}%`,
        width: 12,
        height: 12,
        marginLeft: -6,
        marginTop: -6,
        borderRadius: kind === "band" ? 2 : 6,
        background: kind === "band" ? "#ffb300" : LINE,
        border: "1px solid #fff",
        cursor: kind === "band" ? "ns-resize" : "move",
      }}
    />
  );

  const live: Line | null = line ?? (first && cursor ? { p1: first, p2: cursor } : null);
  const poly = line ? bandCorners(line, halfWidth, size.w, size.h).map((p) => `${p.x},${p.y}`).join(" ") : null;

  return (
    <>
      <div
        ref={area}
        data-testid="line-canvas"
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        style={{ position: "relative", maxWidth, lineHeight: 0, touchAction: "none", userSelect: "none", cursor: drawing ? "crosshair" : "default" }}
      >
        <img
          src={imageUrl}
          alt="Crop to measure"
          draggable={false}
          style={{ width: "100%", display: "block" }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) setSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {poly && <polygon data-testid="band" points={poly} fill="rgba(255,165,0,0.15)" stroke="#ffb300" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          {live && (
            <line
              data-testid="drawn-line"
              x1={live.p1.x}
              y1={live.p1.y}
              x2={live.p2.x}
              y2={live.p2.y}
              stroke={LINE}
              strokeWidth={2}
              strokeDasharray={line ? undefined : "6 4"}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {overlay && overlay.fitted.length === 2 && (
            <line
              data-testid="fitted-line"
              x1={overlay.fitted[0].x}
              y1={overlay.fitted[0].y}
              x2={overlay.fitted[1].x}
              y2={overlay.fitted[1].y}
              stroke={FITTED}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {overlay?.points.map((p, i) => (
          <div
            key={i}
            data-testid="edge-point"
            style={{ position: "absolute", left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: 3, background: FITTED, border: "1px solid #000", pointerEvents: "none" }}
          />
        ))}
        {first && (
          <div
            data-testid="first-point"
            style={{ position: "absolute", left: `${first.x * 100}%`, top: `${first.y * 100}%`, width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: 5, background: LINE, border: "1px solid #fff", pointerEvents: "none" }}
          />
        )}
        {line && (
          <>
            {handle("p1", line.p1, "p1", "Drag to move this end of the line")}
            {handle("p2", line.p2, "p2", "Drag to move this end of the line")}
            {handle("band", bandHandle(line, halfWidth, size.w, size.h), "band", "Drag to make the band wider or narrower")}
          </>
        )}
      </div>
      <p style={{ margin: "4px 0", lineHeight: 1.4, fontSize: 13 }}>
        {drawing
          ? first
            ? "Now click the second point of the line."
            : "Click once to place the first point of the line along the edge, then click again for the second."
          : "Drag the red ends to adjust the line and the orange handle to resize the band."}{" "}
        <button
          type="button"
          disabled={drawing && first === null}
          onClick={() => {
            setFirst(null);
            setCursor(null);
            onChange(null, halfWidth);
          }}
        >
          {drawing ? "Cancel" : "Draw a new line"}
        </button>
      </p>
    </>
  );
}
