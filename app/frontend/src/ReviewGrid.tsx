import { useState } from "react";
import { DetectionRow } from "./api";
import { thumbUrl } from "./classify/Card";
import CardGrid from "./classify/CardGrid";
import { PagerSettings } from "./classify/Pager";
import { useGridCard } from "./classify/useGridCard";
import { lastSession } from "./lastSession";
import { markReviewPainted, reviewCursor, reviewPainter } from "./reviewPaint";

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

function ReviewCard({
  camera,
  feature,
  row,
  canUndo,
  onAccept,
  onClear,
  onDelete,
  onUndo,
  onAdjust,
}: {
  camera: string;
  feature: string;
  row: DetectionRow;
  canUndo: boolean;
  onAccept: () => void;
  onClear: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onAdjust: () => void;
}) {
  const box = row.boxes[0];
  const gone = !!row.deleted;
  const canAccept = !gone && !!box && row.state !== "human";
  // The shared grid-card behaviour (`useGridCard`): hover keys and painting. What the keys do is this page's part.
  const { props } = useGridCard(reviewPainter, row.frame, {
    onKey: (e) => {
      const key = e.key.toLowerCase();
      if (key === "z") return canUndo ? (onUndo(), true) : false;
      if (gone) return false; // a deleted picture only takes undo
      if (key === "enter" || key === "a") {
        if (key === "enter" && (e.target as HTMLElement | null)?.tagName === "BUTTON") return false; // Enter on a focused button presses it
        if (!canAccept) return false;
        markReviewPainted(row.frame);
        onAccept();
        return true;
      }
      if (key === "x") {
        if (!box) return false;
        markReviewPainted(row.frame);
        onClear();
        return true;
      }
      if (key === "delete") return onDelete(), true; // as on every grid; never painted
      if (key === "e") return onAdjust(), true;
      return false;
    },
    // Painting: A accepts, X clears, only on cards with a box that are not already your decision.
    paint: (mode) => {
      if (gone || !box || row.state === "human") return false;
      if (mode === "accept") onAccept();
      else onClear();
      return true;
    },
    cursorOf: reviewCursor,
  });
  const color = gone ? "var(--muted)" : STATE_COLOR[row.state] ?? "var(--border)";
  const release = (fn: () => void) => (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.blur(); // keep Enter / Delete for the hover keys, not for the button just pressed
    fn();
  };
  // Icons only; the hover hint says what each does and which key does it.
  const icon = { padding: "1px 8px", lineHeight: 1.3 } as const;
  return (
    <li
      data-testid={`review-card-${row.frame}`}
      {...props}
      style={{ listStyle: "none", border: `2px solid ${color}`, borderRadius: "var(--radius)", background: "var(--panel)", padding: 4, opacity: gone ? 0.55 : 1 }}
    >
      <button
        type="button"
        aria-label={`Adjust ${row.frame}`}
        title="Open to adjust the box (E)"
        disabled={gone}
        onClick={release(onAdjust)}
        style={{ position: "relative", display: "block", width: "100%", padding: 0, border: 0, background: "none", lineHeight: 0, cursor: "pointer" }}
      >
        <img src={thumbUrl(camera, row.frame, feature)} alt={row.frame} loading="lazy" style={{ width: "100%", display: "block" }} />
        {box && !gone && (
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
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ flex: 1, fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color }}>{gone ? "deleted" : STATE_TEXT[row.state] ?? row.state}</span>
          {box && !gone && ` · ${Math.round(box.conf * 100)}%`}
        </span>
        <button type="button" aria-label="Accept box" disabled={!canAccept} onClick={release(onAccept)} title={row.state === "human" ? "Accepted" : "Accept the box (Enter or A; hold and sweep to accept many)"} style={icon}>
          ✓
        </button>
        <button type="button" aria-label="Clear box" disabled={gone || !box} onClick={release(onClear)} title="Clear the box (X; hold and sweep to clear many)" style={icon}>
          ✕
        </button>
        <button type="button" aria-label="Delete picture" disabled={gone} onClick={release(onDelete)} title="Delete the picture, as everywhere (Delete)" style={icon}>
          🗑
        </button>
        {canUndo && (
          <button type="button" aria-label="Undo" onClick={release(onUndo)} title="Undo the last decision on this card (Z)" style={icon}>
            ↶
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The review queue as a paged grid of cards, like the other pages: each shows the frame with the detected box, its state
 * and confidence, and its own Accept / Clear buttons. A decision shows at once and the card stays where it is, marked
 * as decided (the save runs in the background); **Remove decided** tidies the grid when you want to. Hover keys act on
 * the card under the mouse: Enter or A accepts, X clears the box, Delete deletes the picture (as on every grid), Z undoes,
 * E opens the editor to adjust the box. Holding A or X and moving the mouse over the cards paints the action across them (see
 * `reviewPaint.ts`); deleting and undoing are never painted.
 */
export default function ReviewGrid({
  camera,
  feature,
  rows,
  canUndo,
  onAccept,
  onClear,
  onDelete,
  onUndo,
  onAdjust,
  onRemoveDecided,
}: {
  camera: string;
  feature: string;
  rows: DetectionRow[];
  canUndo: (frame: string) => boolean;
  onAccept: (frame: string) => void;
  onClear: (frame: string) => void;
  onDelete: (frame: string) => void;
  onUndo: (frame: string) => void;
  onAdjust: (frame: string) => void;
  onRemoveDecided: () => void;
}) {
  const [settings, setSettings] = useGridSettings();
  const [page, setPage] = useState(1);
  const decided = rows.filter((r) => r.state === "human" || r.deleted).length;
  return (
    <CardGrid
      label="Review grid"
      items={rows}
      keyOf={(r) => r.frame}
      settings={settings}
      onSettings={setSettings}
      page={page}
      onPage={setPage}
      where="review"
      header={
        decided > 0 && (
          <p style={{ margin: "6px 0" }}>
            {decided} decided or deleted.{" "}
            <button type="button" onClick={onRemoveDecided} title="Take the decided and deleted cards out of the grid">
              Remove them
            </button>
          </p>
        )
      }
      renderCard={(row) => (
        <ReviewCard
          camera={camera}
          feature={feature}
          row={row}
          canUndo={canUndo(row.frame)}
          onAccept={() => onAccept(row.frame)}
          onClear={() => onClear(row.frame)}
          onDelete={() => onDelete(row.frame)}
          onUndo={() => onUndo(row.frame)}
          onAdjust={() => onAdjust(row.frame)}
        />
      )}
    />
  );
}
