import { useEffect, useRef, useState } from "react";
import { DetectionRow } from "./api";
import { thumbUrl } from "./classify/Card";
import Pager, { PagerSettings } from "./classify/Pager";
import { lastSession } from "./lastSession";

const STATE_COLOR: Record<string, string> = { trusted: "#2e9e5b", human: "#1a73e8", review: "#e08a00", none: "#c0392b" };
const STATE_TEXT: Record<string, string> = { trusted: "trusted", human: "decided", review: "unsure", none: "no detection" };

const OPTIONS = { per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };

/** Page size and columns of the review grid, remembered in this browser like the other panel choices. */
function useGridSettings(): [PagerSettings, (perPage: number, cols: number) => void] {
  const [chosen, setChosen] = useState(() => {
    const [p, c] = lastSession.reviewGrid().split("x").map(Number);
    return { per_page: OPTIONS.per_page_options.includes(p) ? p : 24, cols: OPTIONS.cols_options.includes(c) ? c : 4 };
  });
  const change = (per_page: number, cols: number) => {
    lastSession.setReviewGrid(`${per_page}x${cols}`);
    setChosen({ per_page, cols });
  };
  return [{ ...chosen, ...OPTIONS }, change];
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
}

/** Hover keys of one card: Enter or A accepts the detected box, Delete or X clears it, E opens it to adjust. */
function useCardKeys(hovered: boolean, h: { accept?: () => void; clear: () => void; adjust: () => void }) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "enter" || key === "a") {
        if ((e.target as HTMLElement | null)?.tagName === "BUTTON" && key === "enter") return; // Enter on a focused button presses it
        e.preventDefault();
        ref.current.accept?.();
      } else if (key === "delete" || key === "x") {
        e.preventDefault();
        ref.current.clear();
      } else if (key === "e") {
        e.preventDefault();
        ref.current.adjust();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);
}

function ReviewCard({
  camera,
  feature,
  row,
  busy,
  keysOn,
  onAccept,
  onClear,
  onAdjust,
}: {
  camera: string;
  feature: string;
  row: DetectionRow;
  busy: boolean;
  keysOn: boolean;
  onAccept: () => void;
  onClear: () => void;
  onAdjust: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const box = row.boxes[0];
  const canAccept = !!box && !busy && row.state !== "human";
  useCardKeys(hovered && keysOn, { accept: canAccept ? onAccept : undefined, clear: () => !busy && onClear(), adjust: onAdjust });
  const color = STATE_COLOR[row.state] ?? "var(--border)";
  return (
    <li
      data-testid={`review-card-${row.frame}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ listStyle: "none", border: `2px solid ${color}`, borderRadius: "var(--radius)", background: "var(--panel)", padding: 4, opacity: busy ? 0.6 : 1 }}
    >
      <button
        type="button"
        aria-label={`Adjust ${row.frame}`}
        title="Open to adjust the box (E)"
        onClick={(e) => {
          e.currentTarget.blur(); // keep Enter / Delete for the hover keys and the editor, not for this button
          onAdjust();
        }}
        style={{ position: "relative", display: "block", width: "100%", padding: 0, border: 0, background: "none", lineHeight: 0, cursor: "pointer" }}
      >
        <img src={thumbUrl(camera, row.frame, feature)} alt={row.frame} loading="lazy" style={{ width: "100%", display: "block" }} />
        {box && (
          <span
            data-testid={`review-box-${row.frame}`}
            style={{
              position: "absolute",
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
              border: "2px solid #ff3b30",
              boxSizing: "border-box",
              pointerEvents: "none",
            }}
          />
        )}
      </button>
      <div style={{ fontSize: 11, margin: "4px 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.frame}>
        {row.frame}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
        <span style={{ color }}>{STATE_TEXT[row.state] ?? row.state}</span>
        {box && ` · ${Math.round(box.conf * 100)}%`}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" disabled={!canAccept} onClick={(e) => { e.currentTarget.blur(); onAccept(); }} title="Accept the box (Enter or A)" style={{ flex: 1 }}>
          ✓ Accept
        </button>
        <button type="button" disabled={busy || !box} onClick={(e) => { e.currentTarget.blur(); onClear(); }} title="Clear the box (Delete or X)" style={{ flex: 1 }}>
          ✕ Clear
        </button>
      </div>
    </li>
  );
}

/**
 * The review queue as a paged grid of cards, like the other pages: each shows the frame with the detected box,
 * its state and confidence, and its own Accept / Clear buttons. Hover keys act on the card under the mouse
 * (Enter or A accepts, Delete or X clears, E opens the editor to adjust the box).
 */
export default function ReviewGrid({
  camera,
  feature,
  rows,
  keysOn = true,
  onAccept,
  onClear,
  onAdjust,
}: {
  camera: string;
  feature: string;
  rows: DetectionRow[];
  /** False while the editor is open on top of the grid, so the hover keys do not act on the cards behind it. */
  keysOn?: boolean;
  onAccept: (frame: string) => Promise<unknown>;
  onClear: (frame: string) => Promise<unknown>;
  onAdjust: (frame: string) => void;
}) {
  const [settings, setSettings] = useGridSettings();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const nPages = Math.max(1, Math.ceil(rows.length / settings.per_page));
  const cur = Math.min(page, nPages);
  const shown = rows.slice((cur - 1) * settings.per_page, cur * settings.per_page);
  const pagerGrid = { page: cur, per_page: settings.per_page, n_pages: nPages, total: rows.length };

  async function act(frame: string, call: (f: string) => Promise<unknown>) {
    setBusy(frame);
    try {
      await call(frame);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div aria-label="Review grid">
      <Pager grid={pagerGrid} settings={settings} onPage={setPage} onSettings={setSettings} where="review top" />
      <ul style={{ display: "grid", gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`, gap: 8, padding: 0, margin: 0 }}>
        {shown.map((row) => (
          <ReviewCard
            key={row.frame}
            camera={camera}
            feature={feature}
            row={row}
            busy={busy === row.frame}
            keysOn={keysOn}
            onAccept={() => act(row.frame, onAccept)}
            onClear={() => act(row.frame, onClear)}
            onAdjust={() => onAdjust(row.frame)}
          />
        ))}
      </ul>
      <Pager grid={pagerGrid} settings={settings} onPage={setPage} onSettings={setSettings} where="review bottom" />
    </div>
  );
}
