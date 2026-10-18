import { expect, test } from "vitest";
import { DetectionRow } from "./api";
import { countByFilter, matchesFilter, reviewRows, REVIEW_FILTERS, REVIEW_SORTS, sortRows } from "./reviewList";

const row = (frame: string, state: DetectionRow["state"], conf: number | null, x = 0.1, status: string | null = state === "human" ? "reviewed" : "auto"): DetectionRow => ({
  frame, state, status, boxes: conf === null ? [] : [{ x, y: 0.1, w: 0.2, h: 0.2, conf }],
});
const rows = [
  row("a10.png", "review", 0.4, 0.1),
  row("a2.png", "trusted", 0.95, 0.12),
  row("b.png", "none", null),
  row("c.png", "human", 0.8, 0.5, "reviewed"),
  row("d.png", "human", 0.6, 0.3, "manual"),
  row("e.png", "review", 0.2, 0.7),
];

test("every filter lists the frames it names", () => {
  const names = (f: Parameters<typeof matchesFilter>[1]) => rows.filter((r) => matchesFilter(r, f)).map((r) => r.frame);
  expect(names("needs")).toEqual(["a10.png", "b.png", "e.png"]);
  expect(names("unsure")).toEqual(["a10.png", "e.png"]);
  expect(names("none")).toEqual(["b.png"]);
  expect(names("trusted")).toEqual(["a2.png"]);
  expect(names("accepted")).toEqual(["c.png"]);
  expect(names("adjusted")).toEqual(["d.png"]);
  expect(names("all")).toHaveLength(6);
  expect(REVIEW_FILTERS[0][0]).toBe("needs"); // what needs a look comes first
});

test("the counts say how many frames each filter would list", () => {
  expect(countByFilter(rows)).toEqual({ needs: 3, unsure: 2, none: 1, trusted: 1, accepted: 1, adjusted: 1, all: 6 });
});

test("least and most confident put the frames without a box first and last respectively", () => {
  expect(sortRows(rows, "least", null).map((r) => r.frame)).toEqual(["b.png", "e.png", "a10.png", "d.png", "c.png", "a2.png"]);
  expect(sortRows(rows, "most", null).map((r) => r.frame)).toEqual(["a2.png", "c.png", "d.png", "a10.png", "e.png", "b.png"]);
});

test("by name sorts numbers as numbers", () => {
  expect(sortRows(rows, "name", null).map((r) => r.frame)).toEqual(["a2.png", "a10.png", "b.png", "c.png", "d.png", "e.png"]);
});

test("by position, furthest or nearest to the exemplar's centre; frames without a box last", () => {
  const centre = { x: 0.2, y: 0.2 }; // the exemplar's box centre: the detections are at x + 0.1
  expect(sortRows(rows, "far", centre).map((r) => r.frame)).toEqual(["e.png", "c.png", "d.png", "a2.png", "a10.png", "b.png"]);
  expect(sortRows(rows, "near", centre).map((r) => r.frame)).toEqual(["a10.png", "a2.png", "d.png", "c.png", "e.png", "b.png"]);
});

test("the list is the filter's frames in the chosen order, and the input is left alone", () => {
  const before = rows.map((r) => r.frame);
  expect(reviewRows(rows, "needs", "least", null).map((r) => r.frame)).toEqual(["b.png", "e.png", "a10.png"]);
  expect(rows.map((r) => r.frame)).toEqual(before);
  expect(REVIEW_SORTS.map(([id]) => id)).toEqual(["least", "most", "name", "far", "near"]);
});
