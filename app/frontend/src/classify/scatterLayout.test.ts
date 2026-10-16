import { expect, test } from "vitest";
import { layoutPoints } from "./scatterLayout";

const pt = (frame: string, x: number, y: number) => ({ frame, x, y, cluster: 0, representative: false, golden: null, label: null });

test("fits points into the padded box, preserving order and corners", () => {
  const out = layoutPoints([pt("a", -5, 10), pt("b", 5, 30)], 200, 100, 10);
  expect(out[0]).toMatchObject({ frame: "a", px: 10, py: 10 });
  expect(out[1]).toMatchObject({ frame: "b", px: 190, py: 90 });
});

test("degenerate axes are centred; empty input is fine", () => {
  const out = layoutPoints([pt("a", 3, 7), pt("b", 3, 7)], 200, 100);
  expect(out.map((p) => [p.px, p.py])).toEqual([[100, 50], [100, 50]]);
  expect(layoutPoints([], 200, 100)).toEqual([]);
});
