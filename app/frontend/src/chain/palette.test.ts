import { expect, test } from "vitest";
import { BOX_SIZE, HUE, PALETTE, dropPosition, freeSpot, paletteItem } from "./palette";

test("every box type has one colour and one fixed size", () => {
  for (const kind of Object.keys(HUE)) expect(BOX_SIZE[kind as keyof typeof BOX_SIZE]).toBeDefined();
  expect(new Set(Object.values(HUE)).size).toBe(Object.keys(HUE).length); // no two types share a colour
});

test("the palette is grouped by in / out type and offers every box the Chain can add", () => {
  expect(PALETTE.flatMap((g) => g.items.map((i) => i.kind)).sort()).toEqual(["calc", "crop", "dedup", "detector", "evaluation", "feature", "product"]);
  expect(paletteItem("product").box).toBe("roi");
});

test("a box dropped at the pointer is centred on it", () => {
  expect(dropPosition({ x: 500, y: 300 }, "detector")).toEqual({ x: 400, y: 257 });
});

test("a free spot is the wanted one, or the first one below that overlaps nothing", () => {
  expect(freeSpot([], { x: 10, y: 20 }, "calc")).toEqual({ x: 10, y: 20 });
  const taken = [{ x: 10, y: 20, kind: "calc" as const }];
  const moved = freeSpot(taken, { x: 10, y: 20 }, "calc");
  expect(moved.x).toBe(10);
  expect(moved.y).toBeGreaterThanOrEqual(20 + 86 + 24);
  expect(freeSpot(taken, { x: 400, y: 20 }, "calc")).toEqual({ x: 400, y: 20 }); // beside it is free
});
