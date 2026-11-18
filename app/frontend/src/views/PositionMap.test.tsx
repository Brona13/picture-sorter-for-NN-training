import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import FlowBoxView from "./FlowBoxView";
import PositionMap, { countOutside, mapBounds, startRadius } from "./PositionMap";
import type { Zone } from "../zoneGeometry";

const circle = (center: [number, number], radius: number): Zone => ({ shape: "circle", center, radius, half: [radius, radius] });

test("the map covers the picture, every dot and the zone", () => {
  expect(mapBounds([[50, 40]], { w: 100, h: 80 }, null)).toEqual({ x: -4, y: -4, w: 108, h: 88 });
  const b = mapBounds([[150, 40]], { w: 100, h: 80 }, circle([0, 0], 20));
  expect(b.x).toBeLessThan(-20);
  expect(b.x + b.w).toBeGreaterThan(150);
});

test("pictures outside the zone are counted, and the first radius holds about nine in ten", () => {
  const pts: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [100, 0]];
  expect(countOutside(pts, circle([0, 0], 5))).toBe(4); // 6, 7, 8 and 100 (the edge counts as inside)
  expect(countOutside(pts, null)).toBe(0);
  expect(startRadius(pts, [0, 0])).toBe(100); // index 9 of 10 sorted distances
  expect(startRadius(pts.slice(0, 9), [0, 0])).toBe(8);
  expect(startRadius([[1, 1]], [1, 1])).toBe(5); // never under 5 px
});

test("dots are green inside, red outside, and the count follows the zone", () => {
  render(<PositionMap points={{ "a.png": [10, 10], "b.png": [90, 70], "c.png": null }} extent={{ w: 100, h: 80 }} zone={circle([10, 10], 5)} onZone={() => {}} onSpot={() => {}} missing={1} label="hole" />);
  const dots = screen.getAllByTestId("position-dot");
  expect(dots).toHaveLength(2);
  expect(dots.map((d) => d.getAttribute("fill"))).toEqual(["#1a7f37", "#c62828"]);
  expect(screen.getByTestId("position-count")).toHaveTextContent("1 of 2 outside the zone · 1 not found");
});

test("a click on the chart asks for the pictures near that spot", () => {
  const onSpot = vi.fn();
  render(<PositionMap points={{ "a.png": [10, 10] }} extent={{ w: 100, h: 100 }} zone={null} onZone={() => {}} onSpot={onSpot} missing={0} label="hole" />);
  const svg = screen.getByTestId("position-map");
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 108, height: 108, right: 108, bottom: 108, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(svg, { clientX: 54, clientY: 54 });
  expect(onSpot).toHaveBeenCalledTimes(1);
  const [at, radius] = onSpot.mock.calls[0];
  expect(at[0]).toBeCloseTo(50);
  expect(at[1]).toBeCloseTo(50);
  expect(radius).toBeCloseTo(2.7);
  expect(screen.getByTestId("position-count")).toHaveTextContent("1 found");
});

test("dragging the square handle resizes the zone and saves it on release", () => {
  const onZone = vi.fn();
  render(<PositionMap points={{ "a.png": [50, 50] }} extent={{ w: 100, h: 100 }} zone={circle([50, 50], 10)} onZone={onZone} onSpot={() => {}} missing={0} label="hole" />);
  const svg = screen.getByTestId("position-map");
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 108, height: 108, right: 108, bottom: 108, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(screen.getByTestId("review-zone-edge"));
  fireEvent.pointerMove(window, { clientX: 84, clientY: 54 }); // x 80 on the picture
  expect(screen.getByTestId("review-zone").getAttribute("r")).toBe("30");
  fireEvent.pointerUp(window);
  expect(onZone).toHaveBeenCalledWith({ ...circle([50, 50], 30), half: [10, 10] });
});

// --- on the detector page -----------------------------------------------------------------------------------------
let calls: { url: string; method: string; body?: any }[];
let node: any;
const BOXES = {
  "a.png": { hole: { x: 10, y: 10, w: 4, h: 4, angle: 0, score: 0.9 }, pin: { x: 60, y: 10, w: 4, h: 4, angle: 0, score: 0.9 } },
  "b.png": { hole: { x: 11, y: 10, w: 4, h: 4, angle: 0, score: 0.9 }, pin: { x: 61, y: 11, w: 4, h: 4, angle: 0, score: 0.9 } },
  "c.png": { hole: { x: 80, y: 70, w: 4, h: 4, angle: 0, score: 0.9 }, pin: { x: 60, y: 12, w: 4, h: 4, angle: 0, score: 0.9 } },
  "d.png": { pin: { x: 59, y: 10, w: 4, h: 4, angle: 0, score: 0.9 } },
};

beforeEach(() => {
  calls = [];
  node = {
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh",
    targets: [{ name: "hole", outputs: ["position"], examples: [{ frame: "a.png", box: [8, 8, 4, 4], png: "data:,", scale: 1, angle: 0 }] }, { name: "pin", outputs: ["position"], examples: [{ frame: "a.png", box: [58, 8, 4, 4], png: "data:,", scale: 1, angle: 0 }] }],
    summary: { frames: 4, found: { hole: 3, pin: 4 }, complete: 3, review: 1 },
    review_zones: { hole: circle([10.5, 10], 5) },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/chain")) return new Response(JSON.stringify({ nodes: [{ id: "det:1", label: "Detector 1" }] }));
    if (/\/flow\/nodes\/[^/]+\/frames$/.test(url)) return new Response(JSON.stringify({ frames: ["a.png", "b.png", "c.png", "d.png"], has_input: true, reference_frame: null }));
    if (url.includes("/boxes")) return new Response(JSON.stringify({ boxes: BOXES, review: ["d.png"] }));
    if (url.endsWith("/pair")) return new Response(JSON.stringify(pairState()));
    if (method === "PUT" && "review_pair" in (body ?? {})) {
      node = { ...node, review_pair: body.review_pair === null ? null : { a: "hole", b: "pin", op: "distance", clockwise: false, nominal: null, tolerance: 3, ...node.review_pair, ...body.review_pair, zone: { ...circle([0, 0], 10), ...node.review_pair?.zone, ...body.review_pair.zone } } };
    }
    if (method === "PUT" && body?.review_zone) {
      const { slot, zone } = body.review_zone;
      const zones = { ...node.review_zones };
      if (zone === null) delete zones[slot];
      else zones[slot] = { ...circle([0, 0], 10), ...zones[slot], ...zone };
      node = { ...node, review_zones: zones };
    }
    return new Response(JSON.stringify(node));
  }));
});
afterEach(() => vi.unstubAllGlobals());

// The pair "hole" → "pin" by distance, as the backend measures it: a 50, b about 50, c about 61.4, d not measured.
function pairState() {
  const pair = node.review_pair ?? null;
  const values: Record<string, number | null> = {};
  const verdicts: Record<string, string> = {};
  if (pair) {
    for (const [f, here] of Object.entries(BOXES) as [string, any][]) {
      const v = here.hole && here.pin ? Math.hypot(here.pin.x - here.hole.x, here.pin.y - here.hole.y) : null;
      values[f] = v;
      verdicts[f] = v === null || pair.nominal == null ? "undetermined" : Math.abs(v - pair.nominal) <= pair.tolerance ? "pass" : "fail";
    }
  }
  const counts = { pass: 0, fail: 0, undetermined: 0 } as Record<string, number>;
  for (const v of Object.values(verdicts)) counts[v] += 1;
  return { pair, operations: { distance: "Distance A to B", angle: "Angle A to B" }, mode: "tolerance", values, points: {}, verdicts, counts, histogram: pair ? { low: 50, high: 62, bins: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] } : null, wrap: false, unit: "px" };
}

const strip = () => screen.getAllByRole("button", { name: /^Show [a-d]\.png$/ }).map((b) => b.getAttribute("aria-label"));

test("Detector page: the position map counts the pictures outside the zone and the strip can show only those", async () => {
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  expect(await screen.findByTestId("position-map")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("position-count")).toHaveTextContent("1 of 3 outside the zone · 1 not found"));
  expect(screen.getByRole("button", { name: "Outside (1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not found (1)" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Outside (1)" }));
  await waitFor(() => expect(strip()).toEqual(["Show c.png"]));
  await userEvent.click(screen.getByRole("button", { name: "Not found (1)" }));
  await waitFor(() => expect(strip()).toEqual(["Show d.png"]));
  await userEvent.click(screen.getByRole("button", { name: "All (4)" }));
  await waitFor(() => expect(strip()).toHaveLength(4));
});

test("Detector page: the target switch changes the dots, the densest spot puts a zone that holds most of them", async () => {
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  await screen.findByTestId("position-map");
  await waitFor(() => expect(screen.getAllByTestId("position-dot")).toHaveLength(3));
  await userEvent.click(within(screen.getByRole("group", { name: "Target on the map" })).getByRole("button", { name: /pin/ }));
  await waitFor(() => expect(screen.getAllByTestId("position-dot")).toHaveLength(4));
  expect(screen.getByTestId("position-count")).toHaveTextContent("4 found");
  await userEvent.click(screen.getByRole("button", { name: "Put the zone on the densest spot" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.review_zone?.slot === "pin" && c.body.review_zone.zone.shape === "circle" && c.body.review_zone.zone.radius >= 5)).toBe(true));
  await waitFor(() => expect(screen.getByTestId("position-count")).toHaveTextContent(/of 4 outside the zone/));
  await userEvent.click(screen.getByRole("button", { name: "Remove zone" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.review_zone?.slot === "pin" && c.body.review_zone.zone === null)).toBe(true));
});

test("Detector page: a click on the map shows only the pictures near the spot, Show all brings the rest back", async () => {
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  const svg = await screen.findByTestId("position-map");
  await waitFor(() => expect(strip()).toHaveLength(4));
  const r = { x: 0, y: 0, w: 0, h: 0 };
  const vb = svg.getAttribute("viewBox")!.split(" ").map(Number);
  [r.x, r.y, r.w, r.h] = vb;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: r.w, height: r.h, right: r.w, bottom: r.h, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(svg, { clientX: 80 - r.x, clientY: 70 - r.y }); // the stray hole of c.png
  await waitFor(() => expect(strip()).toEqual(["Show c.png"]));
  expect(screen.getByText(/near x 80, y 70: 1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(strip()).toHaveLength(4));
});

test("Detector page: the pair map measures two targets, its band joins Outside and the histogram zoom narrows the strip", async () => {
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  await userEvent.click(await screen.findByRole("button", { name: "Measure hole → pin" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.review_pair?.a === "hole" && c.body.review_pair.b === "pin" && c.body.review_pair.op === "distance")).toBe(true));
  expect(await screen.findByRole("img", { name: "Histogram of the measured values" })).toBeInTheDocument();
  expect(screen.getByTestId("pair-count")).toHaveTextContent("3 measured · click a bar or use the densest value to set the nominal · 1 not measured");
  await userEvent.click(screen.getByRole("button", { name: "Use densest value as nominal" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && typeof c.body?.review_pair?.nominal === "number")).toBe(true));
  await waitFor(() => expect(screen.getByTestId("pair-count")).toHaveTextContent("1 of 3 outside the band"));
  // c.png is outside both the hole zone and the pair band: counted once, and the tip names both reasons
  const outside = screen.getByRole("button", { name: "Outside (1)" });
  expect(outside.getAttribute("title")).toBe("Outside: 1 by the hole zone, 1 by the pair hole → pin");
  await userEvent.selectOptions(screen.getByLabelText("Pair operation"), "angle");
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.review_pair?.op === "angle")).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Remove pair" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.review_pair === null)).toBe(true));
  expect(await screen.findByRole("button", { name: "Measure hole → pin" })).toBeInTheDocument();
});

test("Detector page: zooming the pair histogram shows only the pictures in that range", async () => {
  node.review_pair = { a: "hole", b: "pin", op: "distance", clockwise: false, nominal: 50, tolerance: 1, zone: circle([0, 0], 10) };
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  const chart = await screen.findByRole("img", { name: "Histogram of the measured values" });
  await waitFor(() => expect(strip()).toHaveLength(4));
  chart.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 50, right: 90, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(chart, { button: 0, clientX: 75 }); // 50 + 75 / 90 * 12 = 60
  fireEvent.pointerMove(window, { clientX: 90 });
  fireEvent.pointerUp(window, { clientX: 90 }); // to 62
  await waitFor(() => expect(strip()).toEqual(["Show c.png"]));
  expect(screen.getByText(/pair value is 60.0 to 62.0 px: 1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(strip()).toHaveLength(4));
});
