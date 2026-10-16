import { classColor } from "./colors";

/**
 * "Painting": hold a class key (1-9) or 0 and move the mouse over cards. Each card the pointer enters
 * gets that label, but only when it has none; labeled cards keep their label and goldens never change.
 * With 0, labeled non-golden cards are cleared instead. Golden has no paint mode.
 */
let held: string | null = null;
const stroke = new Set<string>(); // cards this stroke has already acted on
let tracking = false;

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

/** The card the key was pressed on is already handled, so a jittering pointer cannot undo that press. */
export function markPainted(frame: string) {
  stroke.add(frame);
}

export function endPaint() {
  held = null;
  stroke.clear();
  if (typeof document !== "undefined") document.body.style.cursor = "";
}

/** Listens for the held key once, however many cards are on screen. */
export function trackPaintKey() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || !/^[0-9]$/.test(e.key)) return;
    held = e.key;
    stroke.clear();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === held) endPaint();
  });
  window.addEventListener("blur", endPaint);
}

export function cursorFor(digit: string, classes: string[]): string {
  const n = Number(digit);
  const cls = n >= 1 ? classes[n - 1] : undefined;
  const svg =
    n === 0
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#fff" stroke="#555" stroke-width="2"/><path d="M8 8l10 10M18 8L8 18" stroke="#555" stroke-width="2"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="${cls ? classColor(cls, classes) : "#888"}" stroke="#fff" stroke-width="2"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13, crosshair`;
}

/**
 * What a moving pointer should do to this card: ``undefined`` = nothing, ``null`` = clear the label,
 * a class name = label it. Marks the card as handled for the rest of the stroke when it acts.
 */
export function paintAction(
  e: { movementX: number; movementY: number },
  card: { frame: string; label: string | null; golden: string | null; deleted: boolean; busy: boolean },
  classes: string[],
  maxClasses: number,
): string | null | undefined {
  if (held === null || card.busy || card.deleted || card.golden) return undefined;
  const n = Number(held);
  if (n >= 1 && (n > maxClasses || classes[n - 1] === undefined)) return undefined;
  document.body.style.cursor = cursorFor(held, classes);
  if (!e.movementX && !e.movementY) return undefined; // a scroll moving cards under a still pointer is not painting
  if (stroke.has(card.frame)) return undefined;
  if (n === 0 ? card.label === null : card.label !== null) return undefined;
  stroke.add(card.frame);
  return n === 0 ? null : classes[n - 1];
}
