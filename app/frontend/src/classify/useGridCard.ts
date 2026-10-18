import { useEffect, useRef, useState } from "react";
import { Painter } from "./painter";

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
};

/**
 * What every card of every grid does with the mouse and the keyboard, so the grids behave the same:
 * - the card under the pointer takes the page's hover keys (`onKey`: return true when the key was used; Ctrl / Alt / Meta,
 *   repeats and typing in a field are never passed on);
 * - holding a painting key and moving the pointer over the cards paints them (`paint`), with the shared cursor.
 * The page-specific parts are the callbacks; spread `props` on the card's element. The callbacks are reread from a ref,
 * so the window listener only comes and goes with hovering, not with every render.
 */
export function useGridCard<M extends string>(
  painter: Painter<M>,
  frame: string,
  opts: {
    onKey: (e: KeyboardEvent) => boolean;
    paint: (mode: M) => boolean;
    cursorOf: (mode: M) => string | null;
  },
) {
  const [hovered, setHovered] = useState(false);
  const hoveredNow = useRef(false);
  useEffect(painter.track, [painter]);
  // A card that goes away under the pointer (a decision removed it) must not leave the painter thinking the pointer is over a card.
  useEffect(
    () => () => {
      if (hoveredNow.current) painter.leave();
    },
    [painter],
  );
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      if (latest.current.onKey(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);
  const cursorOf = (m: M) => latest.current.cursorOf(m);
  return {
    hovered,
    props: {
      onMouseEnter: () => {
        hoveredNow.current = true;
        setHovered(true);
        painter.enter(cursorOf);
      },
      onMouseLeave: () => {
        hoveredNow.current = false;
        setHovered(false);
        painter.leave();
      },
      onMouseMove: (e: { nativeEvent: { movementX: number; movementY: number } }) =>
        painter.move(e.nativeEvent, frame, cursorOf, (m) => latest.current.paint(m)),
    },
  };
}
