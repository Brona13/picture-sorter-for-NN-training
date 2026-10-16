import { useEffect, useRef, useState } from "react";
import { frameImageUrl } from "../api";
import { FIT_VIEW, View } from "../zoomGeometry";
import ZoomPane from "../ZoomPane";
import { classColor } from "./colors";
import { MAX_SHORTCUT_CLASSES } from "./Card";

interface Props {
  camera: string;
  /** The frames in the order of the grid underneath; the arrows walk this list. */
  frames: string[];
  /** The frame to start on. */
  start: string;
  classes: string[];
  marks: (frame: string) => { label: string | null; golden: string | null };
  busy: boolean;
  onLabel: (frame: string, cls: string | null) => void;
  onGolden: (frame: string, on: boolean) => void;
  onDelete: (frame: string) => void;
  /** Called whenever the shown frame changes, so the grid can turn to the page that holds it. */
  onShow?: (frame: string) => void;
  onClose: () => void;
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

/**
 * Full-size look at the frames of a grid, in an overlay: wheel zoom, pan, Reset and 1:1 (the same
 * pane the ROI editor uses), the left and right arrows for the previous and next frame, and the
 * card's own actions for the frame on screen (1-9 label, 0 clear, the key left of 1 golden, Delete).
 * Escape closes. Keys are taken before the page sees them, so a card under the overlay never acts too.
 */
export default function FrameViewer({ camera, frames, start, classes, marks, busy, onLabel, onGolden, onDelete, onShow, onClose }: Props) {
  const [current, setCurrent] = useState(start);
  const [size, setSize] = useState({ w: 4, h: 3 });
  const [view, setView] = useState<View>(FIT_VIEW);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const contentRef = useRef<HTMLDivElement>(null);
  const lastIndex = useRef(Math.max(0, frames.indexOf(start)));

  // A deleted frame leaves the list: carry on with the one now in its place, or close when none is left.
  const found = frames.indexOf(current);
  const index = found >= 0 ? found : Math.min(lastIndex.current, frames.length - 1);
  const frame = frames[index];
  useEffect(() => {
    if (frames.length === 0) onClose();
    else if (found < 0) setCurrent(frames[index]);
    else lastIndex.current = found;
  }, [frames, found]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (frame) onShow?.(frame);
    setView(FIT_VIEW);
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const go = (to: number) => {
    const next = frames[Math.min(frames.length - 1, Math.max(0, to))];
    if (next) setCurrent(next);
  };

  const latest = useRef({ frame, index, classes, busy, marks, onLabel, onGolden, onDelete, onClose, go });
  latest.current = { frame, index, classes, busy, marks, onLabel, onGolden, onDelete, onClose, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      const take = () => {
        e.preventDefault();
        e.stopPropagation(); // the cards under the overlay listen on window too
      };
      if (e.key === "Escape") return take(), cur.onClose();
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "ArrowLeft") return take(), cur.go(cur.index - 1);
      if (e.key === "ArrowRight") return take(), cur.go(cur.index + 1);
      const isGolden = e.code === "Backquote";
      const isDelete = e.key === "Delete";
      const digit = /^[0-9]$/.test(e.key);
      if (!isGolden && !isDelete && !digit) return;
      take();
      if (e.repeat || cur.busy || !cur.frame) return;
      const m = cur.marks(cur.frame);
      if (isDelete) cur.onDelete(cur.frame);
      else if (isGolden) {
        if (m.label !== null) cur.onGolden(cur.frame, !m.golden);
      } else {
        const n = Number(e.key);
        if (n === 0) {
          if (m.label !== null) cur.onLabel(cur.frame, null);
        } else {
          const cls = cur.classes[n - 1];
          if (cls !== undefined && n <= MAX_SHORTCUT_CLASSES) cur.onLabel(cur.frame, m.label === cls ? null : cls);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!frame) return null;
  const mark = marks(frame);
  const width = Math.max(240, Math.min(win.w - 64, Math.floor((win.h - 190) / 0.75)));
  const nav = { padding: "0 10px" } as const;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Full-size picture"
      data-testid="frame-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}
    >
      <div style={{ background: "var(--panel)", color: "var(--fg, inherit)", padding: 12, borderRadius: 8, maxWidth: "100%" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button type="button" style={nav} aria-label="Previous picture" title="Previous (←)" disabled={index <= 0} onClick={() => go(index - 1)}>
            ◀
          </button>
          <button type="button" style={nav} aria-label="Next picture" title="Next (→)" disabled={index >= frames.length - 1} onClick={() => go(index + 1)}>
            ▶
          </button>
          <strong data-testid="viewer-position">
            {index + 1} / {frames.length}
          </strong>
          <span style={{ opacity: 0.8 }}>{frame}</span>
          <span style={{ flex: 1 }} />
          {classes.map((c, i) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              aria-pressed={mark.label === c}
              title={i < MAX_SHORTCUT_CLASSES ? `Press ${i + 1}.` : undefined}
              onClick={() => onLabel(frame, mark.label === c ? null : c)}
              style={mark.label === c ? { background: classColor(c, classes), color: "#fff" } : undefined}
            >
              {i < MAX_SHORTCUT_CLASSES && <kbd style={{ opacity: 0.6, marginRight: 4, fontSize: 10 }}>{i + 1}</kbd>}
              {c}
            </button>
          ))}
          <button
            type="button"
            aria-label={mark.golden ? "Remove golden" : "Make golden"}
            disabled={busy || mark.label === null}
            title={mark.label === null ? "Label the frame first. Shortcut: the key left of 1." : "Golden reference for the label. Shortcut: the key left of 1."}
            onClick={() => onGolden(frame, !mark.golden)}
          >
            {mark.golden ? "⭐" : "☆"}
          </button>
          <button type="button" aria-label="Delete frame" disabled={busy} title="Soft-delete (Delete)" onClick={() => onDelete(frame)}>
            🗑
          </button>
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        <ZoomPane
          imageSize={size}
          width={width}
          view={view}
          onViewChange={setView}
          panOnBackground
          contentRef={contentRef}
          resetOnZero={false}
          info="wheel zoom · drag to pan · ← → browse · Esc close"
        >
          <img
            key={frame}
            src={frameImageUrl(camera, frame)}
            alt={frame}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth || 4, h: e.currentTarget.naturalHeight || 3 })}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        </ZoomPane>
      </div>
    </div>
  );
}
