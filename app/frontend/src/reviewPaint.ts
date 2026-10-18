import { DetectionRow } from "./api";

/**
 * "Painting" on the Detector review grid, like the labeling pages: hold A to accept, or X (or Delete) to clear, and move
 * the mouse over the cards. Each card the pointer enters gets the action, once per stroke. It only acts on cards nobody has
 * decided yet, so a sweep never overrides an earlier decision of yours (accepted boxes are not cleared by a stray pass).
 */
export type PaintMode = "accept" | "clear";

let held: { key: string; mode: PaintMode } | null = null;
const stroke = new Set<string>(); // cards this stroke has already acted on
let tracking = false;

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

const modeOf = (key: string): PaintMode | null => {
  const k = key.toLowerCase();
  return k === "a" ? "accept" : k === "x" || k === "delete" ? "clear" : null;
};

/** The card the key was pressed on is already handled, so a jittering pointer cannot act on it twice. */
export function markReviewPainted(frame: string) {
  stroke.add(frame);
}

export function endReviewPaint() {
  held = null;
  stroke.clear();
  if (typeof document !== "undefined") document.body.style.cursor = "";
}

/** Listens for the held key once, however many cards are on screen. */
export function trackReviewPaint() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener("keydown", (e) => {
    const mode = modeOf(e.key);
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || !mode) return;
    held = { key: e.key, mode };
    stroke.clear();
  });
  window.addEventListener("keyup", (e) => {
    if (held && e.key === held.key) endReviewPaint();
  });
  window.addEventListener("blur", endReviewPaint);
}

function cursorFor(mode: PaintMode): string {
  const svg =
    mode === "accept"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#2e9e5b" stroke="#fff" stroke-width="2"/><path d="M8 13l4 4 7-8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#c0392b" stroke="#fff" stroke-width="2"/><path d="M8.5 8.5l9 9M17.5 8.5l-9 9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13, crosshair`;
}

/**
 * What a moving pointer should do to this card: ``undefined`` = nothing, otherwise the held mode. Marks the card as handled
 * for the rest of the stroke when it acts.
 */
export function reviewPaintAction(e: { movementX: number; movementY: number }, row: Pick<DetectionRow, "frame" | "state" | "boxes">): PaintMode | undefined {
  if (held === null) return undefined;
  document.body.style.cursor = cursorFor(held.mode);
  if (!e.movementX && !e.movementY) return undefined; // a scroll moving cards under a still pointer is not painting
  if (stroke.has(row.frame)) return undefined;
  if (!row.boxes[0] || row.state === "human") return undefined; // nothing to accept or clear, or already your decision
  stroke.add(row.frame);
  return held.mode;
}
