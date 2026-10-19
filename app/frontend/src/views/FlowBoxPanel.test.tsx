import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowNodeDetail, FlowTolerance } from "../api";
import FlowBoxPanel, { deviation, ToleranceHistogram } from "./FlowBoxPanel";
import FlowBoxView, { rectOf, resizeRect } from "./FlowBoxView";

let calls: { url: string; method: string; body?: any }[];
let detail: any;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(detail));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("deviation wraps angles around 0/360", () => {
  expect(deviation(359, 1, true)).toBe(-2);
  expect(deviation(1, 359, true)).toBe(2);
  expect(deviation(359, 1, false)).toBe(358);
});

test("rectOf is the same for any drag direction", () => {
  expect(rectOf({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual([10, 10, 40, 30]);
});

test("histogram: clicking a bar proposes its value as the nominal; bars inside the band are marked", async () => {
  const onPick = vi.fn();
  const tol: FlowTolerance = {
    kind: "tolerance", nominal: 5, tolerance: 10, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 1, fail: 0, undetermined: 0 }, histogram: { low: 0, high: 360, bins: [3, 0, 0, 1, ...Array(32).fill(0)] }, features: [],
  };
  render(<ToleranceHistogram detail={tol} onPick={onPick} />);
  const bars = screen.getAllByRole("button");
  expect(bars).toHaveLength(36);
  expect(bars[0]).toHaveClass("inside");
  expect(bars[35]).toHaveClass("inside"); // 355 deg is 10 deg from 5: wraps around
  expect(bars[18]).not.toHaveClass("inside");
  await userEvent.click(bars[3]);
  expect(onPick).toHaveBeenCalledWith(35);
});

test("Calculate panel offers the operations and the direction toggle, and sends the choice", async () => {
  detail = { kind: "calc", op: "angle", operations: { angle: "Angle A to B", distance: "Distance A to B" }, points: ["A", "B"], a: "A", b: "B", clockwise: false, measured: 3 };
  render(<FlowBoxPanel camera="camA" nodeId="calc:1" detail={detail as FlowNodeDetail} onDetail={() => {}} onChanged={() => {}} />);
  expect(await screen.findByRole("option", { name: "Distance A to B" })).toBeInTheDocument();
  expect(screen.getByLabelText(/Counter-clockwise/)).toBeChecked();
  fireEvent.click(screen.getByLabelText(/^↻ Clockwise/));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.clockwise === true)).toBe(true));
});

test("Tolerance panel sends the typed nominal and shows the counts", async () => {
  detail = {
    kind: "tolerance", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 0, fail: 0, undetermined: 4 }, histogram: null, features: ["part"],
  };
  render(<FlowBoxPanel camera="camA" nodeId="tol:1" detail={detail as FlowNodeDetail} onDetail={() => {}} onChanged={() => {}} />);
  const input = await screen.findByLabelText(/Nominal/);
  fireEvent.change(input, { target: { value: "175" } });
  fireEvent.blur(input);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.nominal === 175)).toBe(true));
  expect(screen.getByRole("status")).toHaveTextContent("4 undetermined");
});

test("Detector panel: adds a target, lists its examples and keeps Run off until there is one", async () => {
  detail = {
    kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "none",
    targets: [{ name: "left hole", examples: [] }], summary: { frames: 0, found: {}, complete: 0, review: 0 },
  };
  render(<FlowBoxPanel camera="camA" nodeId="det:1" detail={detail as FlowNodeDetail} onDetail={() => {}} onChanged={() => {}} />);
  await userEvent.type(screen.getByLabelText("New target name"), "right hole");
  await userEvent.click(screen.getByRole("button", { name: "Add target" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/targets") && c.body.name === "right hole")).toBe(true));
  expect(screen.getByText("No example yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

const routes = (nodes: Record<string, unknown>, extra: (url: string, method: string) => unknown = () => undefined) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const special = extra(url, method);
    if (special !== undefined) return new Response(JSON.stringify(special));
    if (url.endsWith("/chain")) return new Response(JSON.stringify({ nodes: [{ id: "det:1", label: "Detector 1" }, { id: "tol:1", label: "Tolerance 1" }] }));
    if (url.includes("/frames") && !url.includes("/flow/")) return new Response(JSON.stringify({ frames: ["a.png", "b.png"], showing_all: true, total: 2, reference_frame: null }));
    if (url.includes("/boxes")) return new Response(JSON.stringify({ boxes: {}, review: [] }));
    return new Response(JSON.stringify(nodes));
  }));
};

test("Detector page: opens on the box, shows targets as chips, has the back button and a thumbnail strip", async () => {
  const onBack = vi.fn();
  routes({
    kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "none",
    targets: [{ name: "left hole", examples: [] }, { name: "right hole", examples: [] }], summary: { frames: 0, found: {}, complete: 0, review: 0 },
  });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack }} />);
  expect(await screen.findByRole("heading", { name: /Detector — camA › Detector 1/ })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /^left hole/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^right hole/ })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Show b.png" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Place box" }));
  expect(screen.getByText(/Click where the centre of “left hole” is/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "← Back to chain" }));
  expect(onBack).toHaveBeenCalled();
});

test("Detector page without a target still shows the picture and asks to drag a rectangle, then name it", async () => {
  routes({ kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "none", targets: [], summary: { frames: 0, found: {}, complete: 0, review: 0 } });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  expect(await screen.findByRole("img", { name: "a.png" }, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.getAllByText(/Drag a rectangle around what to find/).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "+ New target" })).toHaveAttribute("aria-pressed", "true");
});

test("Tolerance page: lists the pictures by value and takes a picture's value as the nominal", async () => {
  const tol = {
    kind: "tolerance", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 0, fail: 0, undetermined: 2 }, histogram: null, features: [],
  };
  routes(tol, (url) => (url.includes("/values")
    ? { values: { "a.png": 174.6, "b.png": 10.2 }, verdicts: { "a.png": "undetermined", "b.png": "undetermined" }, unit: "deg" }
    : undefined));
  render(<FlowBoxView camera="camA" focus={{ nodeId: "tol:1", onBack: () => {} }} />);
  const buttons = await screen.findAllByRole("button", { name: "Use as nominal" });
  expect(buttons).toHaveLength(2);
  const rows = screen.getAllByRole("row");
  expect(rows[1]).toHaveTextContent("b.png"); // sorted by value, smallest first
  await userEvent.click(buttons[1]);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.nominal === 174.6)).toBe(true));
});

test("Cascade detector page shows one picture per box of the input detector, zoomed to that box", async () => {
  const parentDetail = { kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "fresh", targets: [{ name: "left hole", examples: [{ frame: "a.png", box: [0, 0, 60, 40], png: "data:image/png;base64,AA" }] }], summary: { frames: 2, found: { "left hole": 1 }, complete: 1, review: 1 } };
  const own = { ...parentDetail, input: "det:1", targets: [], status: "none" };
  const box = { x: 100, y: 100, w: 60, h: 40, angle: 0, score: 0.9, source: "auto" };
  routes(own, (url) => {
    if (url.includes("/nodes/det%3A1/boxes")) return { boxes: { "a.png": { "left hole": box } }, review: [] };
    if (url.includes("/nodes/det%3A1")) return parentDetail;
    return undefined;
  });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:2", onBack: () => {} }} />);
  const img = await screen.findByAltText("a.png", {}, { timeout: 4000 });
  Object.defineProperty(img, "naturalWidth", { value: 400 });
  Object.defineProperty(img, "naturalHeight", { value: 300 });
  fireEvent.load(img);
  const overlay = await screen.findByTestId("flow-overlay", {}, { timeout: 4000 });
  // 60 x 40 box at (100,100), padded 0.3 on every side: 1.6 x the box, centred on it.
  expect(overlay.getAttribute("viewBox")).toBe("52 68 96 64");
  expect(screen.getByText(/Each picture is the “left hole” box found by det:1/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show b.png" })).not.toBeInTheDocument(); // b.png has no box in the input detector
  expect(screen.queryByRole("button", { name: "+ New target" })).not.toBeInTheDocument();
});

test("resizeRect moves the dragged edges only and keeps a minimum size", () => {
  expect(resizeRect([10, 10, 40, 30], "se", 5, 5)).toEqual([10, 10, 45, 35]);
  expect(resizeRect([10, 10, 40, 30], "nw", 5, -5)).toEqual([15, 5, 35, 35]);
  expect(resizeRect([10, 10, 40, 30], "e", -100, 0)).toEqual([10, 10, 5, 30]);
  expect(resizeRect([10, 10, 40, 30], "n", 0, 100)).toEqual([10, 35, 40, 5]);
});

test("Detector page: clicking an example rectangle selects it; dragging it moves it and saves the new box", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const detector = {
    kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "fresh",
    targets: [{ name: "left hole", examples: [{ frame: "a.png", box: [10, 10, 40, 30], png: "data:image/png;base64,AA" }] }],
    summary: { frames: 2, found: { "left hole": 0 }, complete: 0, review: 0 },
  };
  routes(detector, (url, method) => (method === "PUT" && url.includes("/examples/") ? { ...detector, status: "stale" } : undefined));
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  const img = await screen.findByAltText("a.png", {}, { timeout: 4000 });
  Object.defineProperty(img, "naturalWidth", { value: 100 });
  Object.defineProperty(img, "naturalHeight", { value: 100 });
  fireEvent.load(img);
  const overlay = await screen.findByTestId("flow-overlay", {}, { timeout: 4000 });
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  expect(screen.queryByTestId("handle-se")).not.toBeInTheDocument();
  fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20 });
  expect(await screen.findByTestId("handle-se")).toBeInTheDocument();
  fireEvent.pointerMove(overlay, { clientX: 30, clientY: 25 });
  fireEvent.pointerUp(overlay, { clientX: 30, clientY: 25 });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/examples/left%20hole/0"))).toBe(true));
  expect(calls.find((c) => c.method === "PUT" && c.url.includes("/examples/"))?.body).toEqual({ box: [20, 15, 40, 30] });
  vi.unstubAllGlobals();
});
