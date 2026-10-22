import { expect, test } from "vitest";
import { allKeys, buildMatrix, cellKey, columnKeys, effects, rowKeys, sizeOf, toggleGroup } from "./ingestTable";

const at = (iso: string) => new Date(iso).getTime() / 1000;
const f = (frame: string, w: number | null, h: number | null, day: string, removed = false) => ({ frame, width: w, height: h, created: at(`${day}T09:30:00`), removed });
const frames = [
  f("a", 1920, 1080, "2026-10-20"), f("b", 1920, 1080, "2026-10-20"), f("c", 1920, 1080, "2026-10-21"),
  f("d", 640, 480, "2026-10-21"), f("e", 640, 480, "2026-10-21", true), f("x", 0, 0, "2026-10-20"),
];

test("sizes are rows (most pictures first), days are columns (newest first), removed pictures are counted apart", () => {
  const m = buildMatrix(frames);
  expect(m.sizes).toEqual(["1920 × 1080", "640 × 480", "unknown"]);
  expect(m.days).toEqual(["2026-10-21", "2026-10-20"]);
  expect(m.cells.get(cellKey("640 × 480", "2026-10-21"))).toEqual({ active: ["d"], removed: ["e"] });
  expect(sizeOf({ width: null, height: null })).toBe("unknown");
});

test("rows, columns and the whole table pick their cells; a second press drops them", () => {
  const m = buildMatrix(frames);
  let sel = toggleGroup(new Set(), rowKeys(m, "1920 × 1080"));
  expect([...sel].sort()).toEqual([cellKey("1920 × 1080", "2026-10-20"), cellKey("1920 × 1080", "2026-10-21")].sort());
  sel = toggleGroup(sel, columnKeys(m, "2026-10-21")); // one of its cells was picked already: the rest are added
  expect(sel.has(cellKey("640 × 480", "2026-10-21"))).toBe(true);
  expect(toggleGroup(toggleGroup(new Set(), allKeys(m)), allKeys(m)).size).toBe(0);
});

test("what each action would do: remove the picked, keep only the picked (remove the rest), bring back the removed", () => {
  const m = buildMatrix(frames);
  const sel = new Set([cellKey("1920 × 1080", "2026-10-20"), cellKey("640 × 480", "2026-10-21")]);
  const fx = effects(m, sel);
  expect(fx.remove.sort()).toEqual(["a", "b", "d"]);
  expect(fx.bringBack).toEqual(["e"]);
  expect(fx.keepOnlyKeep.sort()).toEqual(["a", "b", "d"]);
  expect(fx.keepOnlyRemove.sort()).toEqual(["c", "x"]); // removed pictures are never "removed again"
});
