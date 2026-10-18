import { createPainter } from "./classify/painter";

/**
 * Painting on the Detector review grid: hold A to accept, or X (or Delete) to clear, and move the mouse over the cards. Each
 * card the pointer enters gets the action, once per stroke, and only cards nobody has decided yet (see `ReviewGrid`), so a
 * sweep never overrides an earlier decision. The holding, stroke and cursor logic is the shared `classify/painter.ts`;
 * this is only the key map and the look of the cursor.
 */
export type PaintMode = "accept" | "clear";

export const reviewPainter = createPainter<PaintMode>((e) => {
  const k = e.key.toLowerCase();
  return k === "a" ? "accept" : k === "x" || k === "delete" ? "clear" : null;
});

export const markReviewPainted = (frame: string) => reviewPainter.mark(frame);
export const endReviewPaint = () => reviewPainter.end();

/** A green circle with a tick to accept, a red one with a cross to clear. */
export function reviewCursor(mode: PaintMode): string {
  const svg =
    mode === "accept"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#2e9e5b" stroke="#fff" stroke-width="2"/><path d="M8 13l4 4 7-8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#c0392b" stroke="#fff" stroke-width="2"/><path d="M8.5 8.5l9 9M17.5 8.5l-9 9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13, crosshair`;
}
