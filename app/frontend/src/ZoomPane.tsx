import {
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  contentRect,
  FIT_VIEW,
  fitSize,
  oneToOneZoom,
  panBy,
  PIXELATE_FROM,
  screenScale,
  View,
  WHEEL_SENSITIVITY,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  zoomAt,
} from "./zoomGeometry";

type Handlers = Pick<HTMLAttributes<HTMLDivElement>, "onClick" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onPointerLeave">;

interface Props {
  /** The picture's own size in pixels (for the aspect ratio, the zoom percentage and 1:1). */
  imageSize: { w: number; h: number };
  /** Viewport width in px; the height is 3/4 of it. */
  width: number;
  /** The view is owned by the caller, so it can survive a change of picture. */
  view: View;
  onViewChange: (view: View) => void;
  /** Also pan by dragging the background with the left button (set it when a left click draws nothing). */
  panOnBackground?: boolean;
  /** Ref to the layer that holds the picture and its overlays; pointer positions are measured against it. */
  contentRef: RefObject<HTMLDivElement | null>;
  contentTestId?: string;
  contentHandlers?: Handlers;
  contentCursor?: string;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  /** Extra text on the tool row (coordinates, measurements). */
  info?: ReactNode;
  /** The picture and its overlays; they fill the layer (positions in %). */
  children: ReactNode;
}

const PAN_THRESHOLD = 3; // px a left-button drag must move before it counts as a pan, not a click

/**
 * A bordered, fixed-size viewport for a picture that can be zoomed with the mouse wheel (the point
 * under the cursor stays put), panned (middle button, Space + drag, or background drag) and reset.
 * The layer inside is resized rather than scaled, so handles and lines keep their screen size and
 * every overlay that works in normalised coordinates keeps working at any zoom.
 */
export default function ZoomPane({
  imageSize,
  width,
  view,
  onViewChange,
  panOnBackground = false,
  contentRef,
  contentTestId,
  contentHandlers,
  contentCursor,
  onKeyDown,
  info,
  children,
}: Props) {
  const vw = Math.round(width);
  const vh = Math.round(width * 0.75);
  const base = fitSize(imageSize.w, imageSize.h, vw, vh);
  const rect = contentRect(view, base, vw, vh);
  const scale = screenScale(view, base, imageSize.w);

  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ view, base, vw, vh, onViewChange });
  const pan = useRef<{ sx: number; sy: number; origin: View; moved: boolean; button: number } | null>(null);
  const suppressClick = useRef(false);
  const hovering = useRef(false);
  const space = useRef(false);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    latest.current = { view, base, vw, vh, onViewChange };
  });

  // The wheel listener must be non-passive, or the page scrolls while zooming.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = latest.current;
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * WHEEL_SENSITIVITY);
      cur.onViewChange(zoomAt(cur.view, factor, e.clientX - r.left, e.clientY - r.top, cur.base, cur.vw, cur.vh));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space + drag pans, but only while the pointer is over the viewport and not typing in a control.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !hovering.current) return;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test((e.target as HTMLElement).tagName)) return;
      e.preventDefault();
      space.current = true;
      setSpaceHeld(true);
    };
    const up = () => {
      space.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", up);
    };
  }, []);

  function zoomCentre(factor: number) {
    onViewChange(zoomAt(view, factor, vw / 2, vh / 2, base, vw, vh));
  }

  function actualPixels() {
    zoomCentre(oneToOneZoom(imageSize.w, base) / view.zoom);
  }

  function startPan(e: ReactPointerEvent) {
    e.preventDefault();
    pan.current = { sx: e.clientX, sy: e.clientY, origin: view, moved: false, button: e.button };
    setPanning(true);
    box.current?.setPointerCapture?.(e.pointerId);
  }

  // Middle button and Space + drag win over whatever the layer inside does with a press (drawing a
  // rectangle, say), so they are taken in the capture phase.
  function onPointerDownCapture(e: ReactPointerEvent) {
    box.current?.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.stopPropagation();
      startPan(e);
    }
  }

  // A plain left press that nothing inside claimed pans, when the caller allows it.
  function onPointerDown(e: ReactPointerEvent) {
    if (e.button === 0 && panOnBackground) startPan(e);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    p.moved = true;
    onViewChange(panBy(p.origin, dx, dy, base, vw, vh));
  }

  function endPan() {
    const p = pan.current;
    if (!p) return;
    pan.current = null;
    setPanning(false);
    if (p.moved && p.button === 0) {
      // The click that follows a left-button pan must not place a point.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  }

  function keys(e: ReactKeyboardEvent) {
    if (e.key === "+" || e.key === "=") zoomCentre(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomCentre(1 / ZOOM_STEP);
    else if (e.key === "0") onViewChange(FIT_VIEW);
    onKeyDown?.(e);
  }

  const cursor = panning ? "grabbing" : spaceHeld ? "grab" : contentCursor;
  const button = { padding: "0 8px", minWidth: 28 } as const;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4, fontSize: 13 }}>
        <button type="button" style={button} aria-label="Zoom out" title="Zoom out (-)" disabled={view.zoom <= ZOOM_MIN} onClick={() => zoomCentre(1 / ZOOM_STEP)}>
          −
        </button>
        <button type="button" style={button} aria-label="Zoom in" title="Zoom in (+)" disabled={view.zoom >= ZOOM_MAX} onClick={() => zoomCentre(ZOOM_STEP)}>
          +
        </button>
        <button type="button" style={button} aria-label="Reset zoom" title="Fit the picture in the box (0)" onClick={() => onViewChange(FIT_VIEW)}>
          Reset
        </button>
        <button type="button" style={button} aria-label="Actual pixels" title="One picture pixel per screen pixel" onClick={actualPixels}>
          1:1
        </button>
        <span data-testid="zoom-level" style={{ minWidth: 44 }}>
          {Math.round(scale * 100)}%
        </span>
        {info && <span style={{ color: "var(--muted)" }}>{info}</span>}
      </div>
      <div
        style={{
          width: vw,
          height: vh,
          border: `1px solid ${focused ? "#1976d2" : "#888"}`,
          background: "rgba(128,128,128,0.15)",
          boxSizing: "content-box",
        }}
      >
        <div
          ref={box}
          data-testid="zoom-viewport"
          tabIndex={0}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={keys}
          onPointerDownCapture={onPointerDownCapture}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onPointerEnter={() => {
            hovering.current = true;
          }}
          onPointerLeave={() => {
            hovering.current = false;
          }}
          onMouseDown={(e: ReactMouseEvent) => {
            if (e.button === 1) e.preventDefault(); // no autoscroll on a middle-click
          }}
          onAuxClick={(e: ReactMouseEvent) => e.preventDefault()}
          onClickCapture={(e: ReactMouseEvent) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              e.stopPropagation();
            }
          }}
          style={{ position: "relative", width: vw, height: vh, overflow: "hidden", outline: "none", touchAction: "none", userSelect: "none" }}
        >
          <div
            ref={contentRef}
            data-testid={contentTestId}
            {...contentHandlers}
            style={{
              position: "absolute",
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              lineHeight: 0,
              touchAction: "none",
              userSelect: "none",
              imageRendering: scale >= PIXELATE_FROM ? "pixelated" : "auto",
              cursor,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
