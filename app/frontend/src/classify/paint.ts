import { classColor } from "./colors";
import { createPainter } from "./painter";

/**
 * Painting on the labeling grids: hold a class key (1-9) or 0 and move the mouse over cards. Each card the pointer enters
 * gets that label, but only when it has none; labeled cards keep their label and goldens never change. With 0, labeled
 * non-golden cards are cleared instead. Golden has no paint mode. The holding, stroke and cursor logic is the shared
 * `painter.ts`; this is only the key map and the look of the cursor.
 */
export const labelPainter = createPainter<string>((e) => (/^[0-9]$/.test(e.key) ? e.key : null));

export const markPainted = (frame: string) => labelPainter.mark(frame);
export const endPaint = () => labelPainter.end();
export const trackPaintKey = () => labelPainter.track();

/** The cursor while painting: a circle in the class's colour (grey with a cross for 0), or none for a key with no class. */
export function cursorFor(digit: string, classes: string[]): string | null {
  const n = Number(digit);
  const cls = n >= 1 ? classes[n - 1] : undefined;
  if (n >= 1 && cls === undefined) return null;
  const svg =
    n === 0
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#fff" stroke="#555" stroke-width="2"/><path d="M8 8l10 10M18 8L8 18" stroke="#555" stroke-width="2"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="${classColor(cls as string, classes)}" stroke="#fff" stroke-width="2"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13, crosshair`;
}
