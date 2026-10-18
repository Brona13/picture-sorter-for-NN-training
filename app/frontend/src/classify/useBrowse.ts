import { useEffect, useRef, useState } from "react";

/**
 * Which frame of a list the viewer shows. When the shown frame leaves the list (it was deleted, or decided and filtered
 * out) the viewer carries on with the one now in its place, or closes when none is left. `onShow` is told whenever
 * the shown frame changes, so a grid can turn to the page that holds it.
 */
export function useBrowse(frames: string[], start: string, onClose: () => void, onShow?: (frame: string) => void) {
  const [current, setCurrent] = useState(start);
  const lastIndex = useRef(Math.max(0, frames.indexOf(start)));
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
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (to: number) => {
    const next = frames[Math.min(frames.length - 1, Math.max(0, to))];
    if (next) setCurrent(next);
  };
  return { frame, index, go };
}
