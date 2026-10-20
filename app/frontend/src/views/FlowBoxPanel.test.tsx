import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowNodeDetail, FlowEvaluation } from "../api";
import FlowBoxPanel, { deviation, dragBand, EvaluationHistogram, rebin } from "./FlowBoxPanel";
import FlowBoxView, { grabCursor, Handle, rectOf, resizeRect } from "./FlowBoxView";

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
  const tol: FlowEvaluation = {
    kind: "evaluation", nominal: 5, tolerance: 10, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 1, fail: 0, undetermined: 0 }, histogram: { low: 0, high: 360, bins: [3, 0, 0, 1, ...Array(32).fill(0)] }, features: [],
  };
  render(<EvaluationHistogram detail={tol} onPick={onPick} />);
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

test("Evaluation panel sends the typed nominal and shows the counts", async () => {
  detail = {
    kind: "evaluation", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 0, fail: 0, undetermined: 4 }, histogram: null, features: ["part"],
  };
  render(<FlowBoxPanel camera="camA" nodeId="eval:1" detail={detail as FlowNodeDetail} onDetail={() => {}} onChanged={() => {}} />);
  const input = await screen.findByLabelText(/Nominal/);
  fireEvent.change(input, { target: { value: "175" } });
  fireEvent.blur(input);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.nominal === 175)).toBe(true));
  expect(screen.getByRole("status")).toHaveTextContent("4 undetermined");
});

test("Detector panel: adds a target, lists its examples and keeps Run off until there is one", async () => {
  detail = {
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "none",
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
    if (url.endsWith("/chain")) return new Response(JSON.stringify({ nodes: [{ id: "det:1", label: "Detector 1" }, { id: "eval:1", label: "Evaluation 1" }] }));
    if (url.includes("/frames") && !url.includes("/flow/")) return new Response(JSON.stringify({ frames: ["a.png", "b.png"], showing_all: true, total: 2, reference_frame: null }));
    if (url.includes("/boxes")) return new Response(JSON.stringify({ boxes: {}, review: [] }));
    return new Response(JSON.stringify(nodes));
  }));
};

test("Detector page: opens on the box, shows targets as chips, has the back button and a thumbnail strip", async () => {
  const onBack = vi.fn();
  routes({
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "none",
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
  routes({ kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "none", targets: [], summary: { frames: 0, found: {}, complete: 0, review: 0 } });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  expect(await screen.findByRole("img", { name: "a.png" }, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.getAllByText(/Drag a rectangle around what to find/).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "+ New target" })).toHaveAttribute("aria-pressed", "true");
});

test("Evaluation page: lists the pictures by value and takes a picture's value as the nominal", async () => {
  const tol = {
    kind: "evaluation", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 0, fail: 0, undetermined: 2 }, histogram: null, features: [],
  };
  routes(tol, (url) => (url.includes("/values")
    ? { values: { "a.png": 174.6, "b.png": 10.2 }, verdicts: { "a.png": "undetermined", "b.png": "undetermined" }, unit: "deg" }
    : undefined));
  render(<FlowBoxView camera="camA" focus={{ nodeId: "eval:1", onBack: () => {} }} />);
  const buttons = await screen.findAllByRole("button", { name: "Use as nominal" });
  expect(buttons).toHaveLength(2);
  const cards = screen.getAllByTestId(/^value-card-/);
  expect(cards[0]).toHaveTextContent("b.png"); // sorted by value, smallest first
  await userEvent.click(buttons[1]);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.nominal === 174.6)).toBe(true));
});

test("Cascade detector page shows one picture per box of the input detector, zoomed to that box", async () => {
  const parentDetail = { kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh", targets: [{ name: "left hole", examples: [{ frame: "a.png", box: [0, 0, 60, 40], png: "data:image/png;base64,AA" }] }], summary: { frames: 2, found: { "left hole": 1 }, complete: 1, review: 1 } };
  const own = { ...parentDetail, input: "det:1", parent_targets: ["left hole"], targets: [], status: "none" };
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
  expect(screen.getByRole("group", { name: "Search inside" })).toHaveTextContent("left hole");
  expect(screen.getByRole("button", { name: "+ New target" })).toBeInTheDocument(); // a cascaded detector names its own targets
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
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh",
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

test("resizeRect stops at the picture: never past the top or left, and past the bottom or right when its size is given", () => {
  expect(resizeRect([10, 10, 40, 30], "nw", -100, -100)).toEqual([0, 0, 50, 40]);
  expect(resizeRect([10, 10, 40, 30], "se", 500, 500)).toEqual([10, 10, 540, 530]); // no size given: as before
  expect(resizeRect([10, 10, 40, 30], "se", 500, 500, 5, { w: 100, h: 80 })).toEqual([10, 10, 90, 70]);
  expect(resizeRect([10, 10, 40, 30], "e", 500, 0, 5, { w: 100, h: 80 })).toEqual([10, 10, 90, 30]);
});

test("grabCursor: resize arrows per handle, move inside a box (the ROI editor's cursors)", () => {
  expect(grabCursor("move")).toBe("move");
  expect(["nw", "se"].map((h) => grabCursor(h as Handle))).toEqual(["nwse-resize", "nwse-resize"]);
  expect(["ne", "sw"].map((h) => grabCursor(h as Handle))).toEqual(["nesw-resize", "nesw-resize"]);
  expect(["n", "s"].map((h) => grabCursor(h as Handle))).toEqual(["ns-resize", "ns-resize"]);
  expect(["e", "w"].map((h) => grabCursor(h as Handle))).toEqual(["ew-resize", "ew-resize"]);
});

async function openDetectorOn100px() {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const detector = {
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh",
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
  return overlay;
}

test("Detector page: the cursor tells what a press would do - move over an example, resize arrows on a handle, crosshair elsewhere", async () => {
  const overlay = await openDetectorOn100px();
  const canvas = screen.getByTestId("flow-canvas");
  const at = (x: number, y: number) => { fireEvent.pointerMove(overlay, { clientX: x, clientY: y }); return canvas.style.cursor; };
  expect(at(80, 80)).toBe("crosshair"); // empty picture: a drag draws
  expect(at(30, 25)).toBe("move"); // inside an example, not yet selected
  expect(at(50, 40)).toBe("move");
  fireEvent.pointerDown(overlay, { clientX: 30, clientY: 25 }); // select it
  fireEvent.pointerUp(overlay, { clientX: 30, clientY: 25 });
  expect(await screen.findByTestId("handle-se")).toBeInTheDocument();
  expect(at(50, 40)).toBe("nwse-resize"); // se
  expect(at(10, 10)).toBe("nwse-resize"); // nw
  expect(at(50, 10)).toBe("nesw-resize"); // ne
  expect(at(10, 40)).toBe("nesw-resize"); // sw
  expect(at(30, 10)).toBe("ns-resize"); // n
  expect(at(50, 25)).toBe("ew-resize"); // e
  expect(at(30, 25)).toBe("move");
  expect(at(80, 80)).toBe("crosshair");
  vi.unstubAllGlobals();
});

test("Detector page: while a handle is dragged the cursor keeps its arrows, and the box stops at the picture edge", async () => {
  const overlay = await openDetectorOn100px();
  const canvas = screen.getByTestId("flow-canvas");
  fireEvent.pointerDown(overlay, { clientX: 30, clientY: 25 });
  fireEvent.pointerUp(overlay, { clientX: 30, clientY: 25 });
  await screen.findByTestId("handle-se");
  fireEvent.pointerDown(overlay, { clientX: 50, clientY: 40 }); // the se handle
  fireEvent.pointerMove(overlay, { clientX: 400, clientY: 400 }); // far outside the picture
  expect(canvas.style.cursor).toBe("nwse-resize");
  fireEvent.pointerUp(overlay, { clientX: 400, clientY: 400 });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/examples/left%20hole/0"))).toBe(true));
  expect(calls.find((c) => c.method === "PUT" && c.url.includes("/examples/"))?.body).toEqual({ box: [10, 10, 90, 90] });
  vi.unstubAllGlobals();
});

test("Detector page: a new rectangle dragged past the picture edge ends at the edge", async () => {
  const overlay = await openDetectorOn100px();
  fireEvent.pointerDown(overlay, { clientX: 60, clientY: 60 });
  fireEvent.pointerMove(overlay, { clientX: 300, clientY: 250 });
  fireEvent.pointerUp(overlay, { clientX: 300, clientY: 250 });
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/examples"))).toBe(true));
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/examples"))?.body.box).toEqual([60, 60, 40, 40]);
  vi.unstubAllGlobals();
});

test("dragBand: the middle moves the nominal, an edge sets the tolerance from the nominal", () => {
  expect(dragBand("centre", 100, 50, 3)).toEqual({ nominal: 100, tolerance: 3 });
  expect(dragBand("high", 58, 50, 3)).toEqual({ nominal: 50, tolerance: 8 });
  expect(dragBand("low", 40, 50, 3)).toEqual({ nominal: 50, tolerance: 10 });
});

test("histogram: dragging the band's edge saves the new tolerance on release", () => {
  const onBand = vi.fn();
  const tol: FlowEvaluation = {
    kind: "evaluation", nominal: 180, tolerance: 10, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 1, fail: 0, undetermined: 0 }, histogram: { low: 0, high: 360, bins: Array(36).fill(1) }, features: [],
  };
  render(<EvaluationHistogram detail={tol} onPick={() => {}} onBand={onBand} />);
  const chart = screen.getByRole("img");
  chart.getBoundingClientRect = () => ({ left: 0, width: 360, top: 0, right: 360, bottom: 100, height: 100, x: 0, y: 0, toJSON() {} });
  fireEvent.pointerDown(screen.getByTestId("band-high"), { pointerId: 1 });
  fireEvent(window, Object.assign(new Event("pointermove"), { clientX: 200 }));
  fireEvent(window, new Event("pointerup"));
  expect(onBand).toHaveBeenCalledWith({ nominal: 180, tolerance: 20 });
});

const wrapped = (over: object = {}): FlowEvaluation => ({
  kind: "evaluation", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
  counts: { pass: 0, fail: 0, undetermined: 0 }, histogram: { low: 0, high: 360, bins: Array(36).fill(0) }, features: [], ...over,
} as FlowEvaluation);

test("rebin counts the values of a range in equal bins, top edge included", () => {
  expect(rebin([170, 171, 175, 180, 99, 181], [170, 180], 5)).toEqual([2, 0, 1, 0, 1]);
});

test("histogram: dragging across the chart zooms the x axis, a click after a drag does not pick, right-click restores", () => {
  const onRange = vi.fn();
  const onPick = vi.fn();
  const { rerender } = render(<EvaluationHistogram detail={wrapped()} values={[10, 175, 176, 177]} onPick={onPick} onRange={onRange} />);
  const chart = screen.getByRole("img");
  chart.getBoundingClientRect = () => ({ left: 0, width: 360, top: 0, right: 360, bottom: 100, height: 100, x: 0, y: 0, toJSON() {} });
  fireEvent.pointerDown(chart, { button: 0, clientX: 170 });
  fireEvent(window, Object.assign(new Event("pointermove"), { clientX: 180 }));
  expect(screen.getByTestId("zoom-selection")).toBeInTheDocument();
  fireEvent(window, Object.assign(new Event("pointerup"), { clientX: 180 }));
  expect(onRange).toHaveBeenCalledWith([170, 180]);
  fireEvent.click(screen.getAllByRole("button")[4]); // the click that ends a drag is not a pick
  expect(onPick).not.toHaveBeenCalled();
  // zoomed: the axis shows the range and the bars are the values in it, binned again
  rerender(<EvaluationHistogram detail={wrapped()} values={[10, 175, 176, 177]} range={[170, 180]} onPick={onPick} onRange={onRange} />);
  expect(screen.getByText("170")).toBeInTheDocument();
  expect(screen.getByText("180 deg")).toBeInTheDocument();
  fireEvent.contextMenu(chart);
  expect(onRange).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getAllByRole("button")[0]);
  expect(onPick).toHaveBeenCalledWith(170.14);
});

test("histogram: a plain click still picks, and a tiny drag is not a zoom", () => {
  const onRange = vi.fn();
  const onPick = vi.fn();
  render(<EvaluationHistogram detail={wrapped()} onPick={onPick} onRange={onRange} />);
  const chart = screen.getByRole("img");
  chart.getBoundingClientRect = () => ({ left: 0, width: 360, top: 0, right: 360, bottom: 100, height: 100, x: 0, y: 0, toJSON() {} });
  fireEvent.pointerDown(chart, { button: 0, clientX: 100 });
  fireEvent(window, Object.assign(new Event("pointerup"), { clientX: 101 }));
  fireEvent.click(screen.getAllByRole("button")[3]);
  expect(onRange).not.toHaveBeenCalled();
  expect(onPick).toHaveBeenCalledWith(35);
});

test("Evaluation page: the histogram can be hidden, a zoomed range narrows the grid and the chip clears it", async () => {
  localStorage.clear();
  const tol = wrapped({ counts: { pass: 0, fail: 0, undetermined: 3 }, histogram: { low: 0, high: 360, bins: Array(36).fill(1) } });
  routes(tol as unknown as Record<string, unknown>, (url) => (url.includes("/values")
    ? { values: { "a.png": 174.6, "b.png": 10.2, "c.png": 176 }, verdicts: { "a.png": "undetermined", "b.png": "undetermined", "c.png": "undetermined" }, unit: "deg" }
    : undefined));
  render(<FlowBoxView camera="camA" focus={{ nodeId: "eval:1", onBack: () => {} }} />);
  await screen.findAllByTestId(/^value-card-/);
  expect(screen.getByRole("img", { name: "Histogram of the measured values" })).toBeInTheDocument();
  const chart = screen.getByRole("img", { name: "Histogram of the measured values" });
  chart.getBoundingClientRect = () => ({ left: 0, width: 360, top: 0, right: 360, bottom: 100, height: 100, x: 0, y: 0, toJSON() {} });
  fireEvent.pointerDown(chart, { button: 0, clientX: 170 });
  fireEvent(window, Object.assign(new Event("pointermove"), { clientX: 180 }));
  fireEvent(window, Object.assign(new Event("pointerup"), { clientX: 180 }));
  await waitFor(() => expect(screen.getAllByTestId(/^value-card-/)).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: /range 170–180/ }));
  await waitFor(() => expect(screen.getAllByTestId(/^value-card-/)).toHaveLength(3));
  await userEvent.click(screen.getByLabelText("Histogram"));
  expect(screen.queryByRole("img", { name: "Histogram of the measured values" })).toBeNull();
  expect(localStorage.getItem("flow.histogram")).toBe("off");
});

test("Calculate page: the viewer draws the geometry behind the number (both boxes, the line, the arc and the value)", async () => {
  const box = (x: number, y: number) => ({ x, y, w: 40, h: 40, angle: 0, score: 0.9, source: "auto" });
  const calcDetail = { kind: "calc", op: "angle", operations: { angle: "Angle A to B" }, points: ["left", "right"], a: "left", b: "right", clockwise: false, measured: 2, input: "det:1", crops: [] };
  routes(calcDetail, (url) => {
    if (url.includes("/nodes/calc%3A1/values")) return { values: { "a.png": 45, "b.png": 10 }, unit: "deg" };
    if (url.includes("/nodes/det%3A1/boxes")) return { boxes: { "a.png": { left: box(100, 200), right: box(200, 100) }, "b.png": { left: box(100, 200) } }, review: [] };
    if (url.includes("/nodes/calc%3A1")) return calcDetail;
    return undefined;
  });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "calc:1", onBack: () => {} }} />);
  await userEvent.click(await screen.findByRole("button", { name: "Open a.png" }));
  const svg = await screen.findByTestId("calc-geometry");
  expect(svg).toHaveTextContent("45 °");
  expect(svg).toHaveTextContent("left");
  expect(svg).toHaveTextContent("right");
  expect(svg.querySelectorAll("path").length).toBeGreaterThan(0); // the arc
  expect(screen.getByTestId("viewer-value")).toHaveTextContent("Angle A to B: left → right");
  // a picture where a point is missing draws what it has and says what is missing
  fireEvent.keyDown(window, { key: "ArrowLeft" }); // sorted by value: b.png (10) comes before a.png (45)
  expect(await screen.findByText(/not found here: right/)).toBeInTheDocument();
  expect(screen.getByTestId("calc-geometry").querySelectorAll("path")).toHaveLength(0);
});

test("Cascade detector page: a drawn rectangle becomes a new target with its own name, searching inside the chosen parent target", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const parentDetail = { kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh", targets: [{ name: "hole left", examples: [{ frame: "a.png", box: [0, 0, 60, 40], png: "data:image/png;base64,AA" }] }, { name: "hole right", examples: [{ frame: "a.png", box: [0, 0, 60, 40], png: "data:image/png;base64,AA" }] }], summary: { frames: 2, found: {}, complete: 0, review: 0 } };
  const own = { ...parentDetail, input: "det:1", parent_targets: ["hole left", "hole right"], targets: [], status: "none" };
  const box = { x: 100, y: 100, w: 60, h: 40, angle: 0, score: 0.9, source: "auto" };
  routes(own, (url, method) => {
    if (url.includes("/nodes/det%3A1/boxes")) return { boxes: { "a.png": { "hole left": box, "hole right": { ...box, x: 300 } } }, review: [] };
    if (url.includes("/nodes/det%3A1")) return parentDetail;
    if (method === "POST" && url.endsWith("/targets")) return { ...own, targets: [{ name: "hole right detail", inside: "hole right", examples: [] }] };
    if (method === "POST" && url.endsWith("/examples")) return own;
    return undefined;
  });
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:2", onBack: () => {} }} />);
  const img = await screen.findByAltText("a.png", {}, { timeout: 4000 });
  Object.defineProperty(img, "naturalWidth", { value: 400 });
  Object.defineProperty(img, "naturalHeight", { value: 300 });
  fireEvent.load(img);
  // choose the right hole's box, then draw: the new target is named next (suggested from the parent target)
  await userEvent.click(screen.getByRole("button", { name: "hole right" }));
  const overlay = await screen.findByTestId("flow-overlay", {}, { timeout: 4000 });
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20 });
  fireEvent.pointerMove(overlay, { clientX: 60, clientY: 60 });
  fireEvent.pointerUp(overlay, { clientX: 60, clientY: 60 });
  const name = await screen.findByLabelText(/What is this/);
  expect(name).toHaveValue("hole right detail");
  await userEvent.click(screen.getByRole("button", { name: "Save target" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/targets"))).toBe(true));
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/targets"))!.body).toEqual({ name: "hole right detail", inside: "hole right" });
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/examples"))).toBe(true));
  expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/examples"))!.body.target).toBe("hole right detail");
  vi.unstubAllGlobals();
});

test("Detector panel in a cascade: each target says which parent target it searches inside, and the choice can be changed", async () => {
  const detail = {
    kind: "detector", input: "det:1", crops: [], parent_targets: ["hole left", "hole right"], rotate: true, angle_range: null, pad: 0.3, status: "none",
    targets: [{ name: "hole left detail", inside: "hole left", examples: [] }], summary: { frames: 0, found: {}, complete: 0, review: 0 },
  };
  routes(detail, (url, method) => (method === "PUT" && url.includes("/targets/") ? { ...detail, targets: [{ ...detail.targets[0], inside: "hole right" }] } : undefined));
  render(<FlowBoxPanel camera="camA" nodeId="det:2" detail={detail as unknown as FlowNodeDetail} onDetail={() => {}} onChanged={() => {}} />);
  const select = screen.getByLabelText("Searches inside, target hole left detail");
  expect(select).toHaveValue("hole left");
  await userEvent.selectOptions(select, "hole right");
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/targets/hole%20left%20detail"))).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ inside: "hole right" });
});

test("Detector page: the picture size belongs to the picture it was measured on - a new picture never keeps the old size, and a cached load is not lost", async () => {
  const detector = {
    kind: "detector", input: "ingest", crops: [], rotate: true, angle_range: null, pad: 0.3, status: "fresh",
    targets: [{ name: "left hole", examples: [{ frame: "a.png", box: [10, 10, 40, 30], png: "data:image/png;base64,AA" }] }],
    summary: { frames: 2, found: { "left hole": 0 }, complete: 0, review: 0 },
  };
  routes(detector);
  render(<FlowBoxView camera="camA" focus={{ nodeId: "det:1", onBack: () => {} }} />);
  const a = await screen.findByAltText("a.png", {}, { timeout: 4000 });
  Object.defineProperty(a, "naturalWidth", { value: 100, configurable: true });
  Object.defineProperty(a, "naturalHeight", { value: 100, configurable: true });
  fireEvent.load(a);
  expect((await screen.findByTestId("flow-overlay", {}, { timeout: 4000 })).getAttribute("viewBox")).toBe("0 0 100 100");

  await userEvent.click(await screen.findByRole("button", { name: "Show b.png" }));
  // b.png has not reported its size yet: the 100x100 of a.png must not be applied to it
  await waitFor(() => expect(screen.queryByTestId("flow-overlay")).toBeNull());
  const b = await screen.findByAltText("b.png"); // the same <img> element, new src
  Object.defineProperty(b, "naturalWidth", { value: 200, configurable: true });
  Object.defineProperty(b, "naturalHeight", { value: 150, configurable: true });
  fireEvent.load(b);
  expect((await screen.findByTestId("flow-overlay")).getAttribute("viewBox")).toBe("0 0 200 150");
});
