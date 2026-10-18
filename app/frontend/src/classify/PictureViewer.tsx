import { ReactNode, useEffect, useRef, useState } from "react";

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

interface Props {
  /** Accessible name of the dialog. */
  label: string;
  testId?: string;
  /** The file name, shown selectable under the picture (not at the top, where long names take the room). */
  name: string;
  /** Position in the list being browsed, and the way to move: the arrows and the buttons use it. */
  index: number;
  total: number;
  onGo: (to: number) => void;
  /** The page's own actions, between browsing and the picture tools (labels, accept / clear, ...). */
  toolbar?: ReactNode;
  /** Picture tools before Close (ROI outline, delete, ...). */
  tools?: ReactNode;
  /** The line of key hints under the file name. */
  hint: string;
  onClose: () => void;
  /** The page's own keys. Return true when the key was used, so nothing else sees it. Esc and the arrows belong to the viewer. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** The picture area; it gets the width the window leaves for it. */
  children: (width: number) => ReactNode;
}

/**
 * The picture viewer every page shares: a full-window overlay with browsing (◀ n / N ▶, the arrow keys), the page's
 * own toolbar, a Close button, the picture area, the file name underneath and a line of key hints. Esc closes. Its
 * keys are taken before the page sees them, so the cards under the overlay never act as well. What differs
 * between pages (the actions, and whether the picture is a plain frame or an editable box) comes in through
 * `toolbar`, `tools`, `onKey` and `children`.
 */
export default function PictureViewer({ label, testId, name, index, total, onGo, toolbar, tools, hint, onClose, onKey, children }: Props) {
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const latest = useRef({ index, total, onGo, onClose, onKey });
  latest.current = { index, total, onGo, onClose, onKey };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cur = latest.current;
      const take = () => {
        e.preventDefault();
        e.stopPropagation(); // the cards under the overlay listen on window too
      };
      if (e.key === "Escape") return take(), cur.onClose();
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "ArrowLeft") return take(), cur.onGo(Math.max(0, cur.index - 1));
      if (e.key === "ArrowRight") return take(), cur.onGo(Math.min(cur.total - 1, cur.index + 1));
      if (cur.onKey?.(e)) take();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const width = Math.max(240, Math.min(win.w - 64, Math.floor((win.h - 190) / 0.75)));
  const nav = { padding: "0 10px" } as const;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}
    >
      <div style={{ background: "var(--panel)", color: "var(--fg, inherit)", padding: 12, borderRadius: 8, width: width + 2 + 24, maxWidth: "100%" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <div role="group" aria-label="Browse" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button type="button" style={nav} aria-label="Previous picture" title="Previous (←)" disabled={index <= 0} onClick={() => onGo(index - 1)}>
              ◀
            </button>
            <strong data-testid="viewer-position" style={{ minWidth: 56, textAlign: "center" }}>
              {index + 1} / {total}
            </strong>
            <button type="button" style={nav} aria-label="Next picture" title="Next (→)" disabled={index >= total - 1} onClick={() => onGo(index + 1)}>
              ▶
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>{toolbar}</div>
          <div role="group" aria-label="Picture" style={{ display: "flex", gap: 24, alignItems: "center" }}>
            {tools}
            <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        {children(width)}
        <div data-testid="viewer-filename" title={name} style={{ marginTop: 8, fontSize: 13, overflowWrap: "anywhere", userSelect: "text" }}>
          {name}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>{hint}</div>
      </div>
    </div>
  );
}
