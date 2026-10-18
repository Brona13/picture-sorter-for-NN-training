/**
 * "Painting", the one behaviour every card grid shares: hold a key and move the mouse over the cards, and each card the
 * pointer enters gets that key's action, once per stroke. What differs between pages is only which keys paint, what the
 * cursor looks like and what the action does to a card (labels on Classify, accept / clear on the Detector review); that
 * comes in as `modeOf`, the cursor function and the card's own `paint`.
 *
 * The cursor is a class on the page with one rule the painter adds itself (`html.painting`), so it wins over the hand cursor of links and
 * buttons and is the same everywhere on the page while the key is held. It shows from the moment the key goes down with the
 * pointer over a card, not only after the first move.
 */
export interface Painter<M extends string> {
  /** Listens for the held key once, however many cards are on screen. */
  track: () => void;
  /** The card the key was pressed on is already handled, so a jittering pointer cannot act on it twice. */
  mark: (frame: string) => void;
  end: () => void;
  /** The pointer is over a card (so the cursor can show as soon as a key goes down) or left it. */
  enter: (cursorOf: (mode: M) => string | null) => void;
  leave: () => void;
  /** The pointer moved over a card; paints it when a key is held. `paint` acts if the card is eligible and says whether it did. */
  move: (e: { movementX: number; movementY: number }, frame: string, cursorOf: (mode: M) => string | null, paint: (mode: M) => boolean) => void;
  /** The mode being painted, if a key is held (for tests). */
  held: () => M | null;
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

/** The one rule that makes the painting cursor win over the hand cursor of links and buttons, added once. */
function ensureRule() {
  if (document.querySelector("style[data-painting-cursor]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-painting-cursor", "");
  style.textContent = "html.painting, html.painting * { cursor: var(--paint-cursor, crosshair) !important; }";
  document.head.appendChild(style);
}

export function createPainter<M extends string>(modeOf: (e: KeyboardEvent) => M | null): Painter<M> {
  let held: { key: string; mode: M } | null = null;
  let over: ((mode: M) => string | null) | null = null;
  let tracking = false;
  const stroke = new Set<string>(); // cards this stroke has already acted on

  const root = () => (typeof document === "undefined" ? null : document.documentElement);
  const show = () => {
    const el = root();
    if (!el) return;
    ensureRule();
    const cursor = held && over ? over(held.mode) : null;
    if (cursor) {
      el.style.setProperty("--paint-cursor", cursor);
      el.classList.add("painting");
    } else el.classList.remove("painting");
  };
  const end = () => {
    held = null;
    stroke.clear();
    root()?.classList.remove("painting");
  };

  return {
    track() {
      if (tracking || typeof window === "undefined") return;
      tracking = true;
      window.addEventListener("keydown", (e) => {
        const mode = modeOf(e);
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || mode === null) return;
        held = { key: e.key, mode };
        stroke.clear();
        show();
      });
      window.addEventListener("keyup", (e) => {
        if (held && e.key === held.key) end();
      });
      window.addEventListener("blur", end);
    },
    mark: (frame) => void stroke.add(frame),
    end,
    enter(cursorOf) {
      over = cursorOf;
      show();
    },
    leave() {
      over = null; // the cursor stays while the key is held, so a stroke that leaves a card keeps its look
    },
    move(e, frame, cursorOf, paint) {
      over = cursorOf;
      if (!held) return;
      show();
      if (!e.movementX && !e.movementY) return; // a scroll moving cards under a still pointer is not painting
      if (stroke.has(frame)) return;
      if (paint(held.mode)) stroke.add(frame);
    },
    held: () => (held ? held.mode : null),
  };
}
