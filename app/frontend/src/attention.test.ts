import { expect, test } from "vitest";
import type { FlowBox, FlowPairState } from "./api";
import { attentionOf, attentionText, bandTimes, sortByAttention, zoneTimes } from "./attention";

const box = (x: number, y: number, score = 0.9, source: "auto" | "human" = "auto"): FlowBox => ({ x, y, w: 4, h: 4, angle: 0, score, source });
const circle = (c: [number, number], r: number) => ({ shape: "circle" as const, center: c, radius: r, half: [r, r] as [number, number] });

test("how far out is counted in zone sizes and tolerances", () => {
  expect(zoneTimes([20, 0], circle([0, 0], 10))).toBe(2);
  expect(zoneTimes([5, 9], { shape: "rect", center: [0, 0], radius: 1, half: [10, 3] })).toBe(3);
  expect(zoneTimes([1, 1], { ...circle([0, 0], 10), center: null })).toBeNull();
  expect(bandTimes(56, 50, 3, false)).toBe(2);
  expect(bandTimes(2, 358, 2, true)).toBe(2); // an angle wraps
});

test("the worst reason wins, a box placed by hand is a perfect match", () => {
  const zones = { hole: circle([10, 10], 5) };
  const pair = { pair: { a: "hole", b: "pin", op: "distance", clockwise: false, nominal: 50, tolerance: 2, zone: circle([0, 0], 1) }, mode: "tolerance", values: { "a.png": 60 }, points: {}, verdicts: {}, wrap: false } as unknown as FlowPairState;
  const a = attentionOf("a.png", { hole: box(25, 10, 0.5), pin: box(60, 10, 0.8, "human") }, ["hole", "pin"], zones, pair);
  expect(a.missing).toEqual([]);
  expect(a.outside).toEqual({ by: "pair", times: 5 }); // pair 10 / 2 beats hole 15 / 5
  expect(a.score).toBe(0.5);
  expect(attentionText(a)).toBe("pair 5.0× outside");
  const b = attentionOf("b.png", { hole: box(10, 10) }, ["hole", "pin"], zones, null);
  expect(attentionText(b)).toBe("pin not found");
  expect(attentionText(attentionOf("c.png", { hole: box(11, 10, 0.42) }, ["hole"], zones, null))).toBe("score 0.42");
});

test("needs attention first: not found, then furthest outside, then weakest match; the other orders take one signal", () => {
  const att = new Map([
    ["ok-strong.png", { missing: [], outside: null, score: 0.95 }],
    ["ok-weak.png", { missing: [], outside: null, score: 0.4 }],
    ["out-far.png", { missing: [], outside: { by: "hole zone", times: 3 }, score: 0.9 }],
    ["out-near.png", { missing: [], outside: { by: "pair", times: 1.2 }, score: 0.3 }],
    ["missing.png", { missing: ["pin"], outside: null, score: 0.9 }],
  ]);
  const frames = [...att.keys()];
  expect(sortByAttention(frames, att, "attention")).toEqual(["missing.png", "out-far.png", "out-near.png", "ok-weak.png", "ok-strong.png"]);
  expect(sortByAttention(frames, att, "outside").slice(0, 2)).toEqual(["out-far.png", "out-near.png"]);
  expect(sortByAttention(frames, att, "score")[0]).toBe("out-near.png");
  expect(sortByAttention(frames, att, "name")).toEqual([...frames].sort());
});
