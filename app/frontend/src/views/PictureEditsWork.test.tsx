import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowCrop, FlowEdit, FlowNodeDetail } from "../api";
import { usePictureEdits } from "./pictureEdits";
import PictureEditsWork, { entering } from "./PictureEditsWork";

// jsdom has no layout: pretend the canvas is 200x100 at (10, 20).
let calls: { url: string; method: string; body?: any }[];
let saved: FlowEdit[];

const FILTERS = { gaussian: { label: "Gaussian blur", params: { sigma: { min: 0.1, max: 10, step: 0.1, default: 1.5 } } } };

function stubFetch(extra: (url: string, method: string) => unknown = () => undefined) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const special = extra(url, method);
    if (special !== undefined) return new Response(JSON.stringify(special));
    if (url.includes("/vision/filters")) return new Response(JSON.stringify({ filters: FILTERS }));
    if (url.includes("/frames")) return new Response(JSON.stringify({ frames: ["a.png", "b.png"], showing_all: true, total: 2, reference_frame: null }));
    if (method === "PUT" && calls.at(-1)!.body.steps) saved = calls.at(-1)!.body.steps;
    return new Response(JSON.stringify({ kind: "crop", steps: saved, input_box: "ingest", crops: [] }));
  }));
}

beforeEach(() => {
  calls = [];
  saved = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON() {} } as DOMRect);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  stubFetch();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target, { clientX, clientY, pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target, ev);
}

const puts = () => calls.filter((c) => c.method === "PUT");
const crop = (rect: [number, number, number, number] | null = null, id = "s1"): FlowEdit => ({ id, op: "crop", rect });
const base = (steps: FlowEdit[] = [crop()], over: Partial<FlowCrop> = {}): FlowCrop => ({ kind: "crop", steps, input_box: "ingest", crops: [], ...over });

/** The page's state holder (as `FlowBoxView` has it) around the work area. */
function Harness({ detail, onError = () => {} }: { detail: FlowCrop; onError?: (e: string | null) => void }) {
  const [d, setD] = useState<FlowNodeDetail>(detail);
  const edits = usePictureEdits("camA", "crop:1", d as FlowCrop, setD, () => {}, onError);
  return (
    <>
      {edits.steps.map((s) => <button key={s.id} type="button" onClick={() => edits.select(s.id)}>pick {s.id}</button>)}
      <PictureEditsWork camera="camA" nodeId="crop:1" detail={d as FlowCrop} edits={edits} onError={onError} />
    </>
  );
}
const setup = (detail: FlowCrop = base()) => {
  saved = detail.steps;
  const onError = vi.fn();
  render(<Harness detail={detail} onError={onError} />);
  return { onError };
};

test("shows the picture that enters the step and offers every picture of the camera", async () => {
  setup();
  const img = await screen.findByAltText("Frame to draw on");
  expect(img).toHaveAttribute("src", expect.stringContaining("/flow/nodes/crop%3A1/picture?frame=a.png"));
  expect(img.getAttribute("src")).toContain("step=s1");
  expect(await screen.findByRole("button", { name: "Show b.png" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset zoom" })).toBeInTheDocument(); // the shared zoom pane: Reset and 1:1
});

test("drawing a rectangle saves it as fractions in the step when the pointer is released, not before", async () => {
  setup();
  await screen.findByAltText("Frame to draw on");
  const area = screen.getByTestId("roi-canvas");
  pointer(area, "pointerDown", 10 + 20, 20 + 10);
  pointer(area, "pointerMove", 10 + 120, 20 + 60);
  expect(puts()).toHaveLength(0);
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  await waitFor(() => expect(puts()).toHaveLength(1));
  const put = puts()[0];
  expect(put.url).toContain("/flow/nodes/crop%3A1");
  expect(put.body.steps).toHaveLength(1);
  expect(put.body.steps[0]).toMatchObject({ id: "s1", op: "crop" });
  expect(put.body.steps[0].rect[0]).toBeCloseTo(0.1);
  expect(put.body.steps[0].rect[2]).toBeCloseTo(0.5);
});

test("moving the rectangle saves once on release; a click without a drag saves nothing", async () => {
  setup(base([crop([0.2, 0.2, 0.4, 0.4])]));
  await screen.findByAltText("Frame to draw on");
  const area = screen.getByTestId("roi-canvas");
  pointer(screen.getByTestId("roi-box"), "pointerDown", 10 + 100, 20 + 50);
  pointer(screen.getByTestId("roi-box"), "pointerUp", 10 + 100, 20 + 50);
  expect(puts()).toHaveLength(0);
  pointer(screen.getByTestId("roi-box"), "pointerDown", 10 + 100, 20 + 50);
  pointer(area, "pointerMove", 10 + 120, 20 + 60);
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].body.steps[0].rect[0]).toBeCloseTo(0.3);
});

test("the picture that enters a crop step does not reload while its rectangle is drawn", async () => {
  const blank = entering([{ id: "s1", op: "filter", name: "gaussian", params: { sigma: 3 } }, crop([0.2, 0.2, 0.4, 0.4], "s2")], 1);
  expect(blank).toEqual([{ id: "s1", op: "filter", name: "gaussian", params: { sigma: 3 } }, { id: "s2", op: "crop", rect: null }]);
  const blankFilter = entering([crop([0.2, 0.2, 0.4, 0.4]), { id: "s2", op: "filter", name: "gaussian", params: { sigma: 3 } }], 1);
  expect(blankFilter[1]).toEqual({ id: "s2", op: "filter", name: "gaussian", params: {} }); // the picture entering a filter is the same whatever its parameters
});

test("shows the cut-out as the result once a rectangle exists", async () => {
  setup(base([crop([0.2, 0.2, 0.4, 0.4])]));
  const result = await screen.findByAltText("a.png cropped");
  expect(result).toHaveAttribute("src", expect.stringContaining("stage=output"));
});

test("a filter step opens on its result; Before shows the picture entering it", async () => {
  setup(base([{ id: "s1", op: "filter", name: "gaussian", params: { sigma: 2 } }]));
  const after = await screen.findByAltText("a.png");
  expect(after.getAttribute("src")).toContain("stage=output");
  expect(after.getAttribute("src")).toContain("step=s1");
  expect(decodeURIComponent(after.getAttribute("src")!)).toContain('"name":"gaussian"');
  expect(screen.getByRole("button", { name: "After" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Before" }));
  await waitFor(() => expect(screen.getByAltText("a.png").getAttribute("src")).toContain("stage=input"));
  expect(screen.getByRole("button", { name: "Before" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/The picture as it enters this filter/)).toBeInTheDocument();
});

test("a crop step opens on Before, where the rectangle is drawn; After shows the cut", async () => {
  setup(base([crop([0.2, 0.2, 0.4, 0.4])]));
  await screen.findByAltText("Frame to draw on");
  expect(screen.getByRole("button", { name: "Before" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "After" }));
  const img = await screen.findByAltText("a.png");
  expect(img.getAttribute("src")).toContain("stage=output");
  expect(screen.queryByTestId("roi-canvas")).toBeNull();
});

test("with no step the picture entering the box is shown and the toggle is off", async () => {
  setup(base([]));
  const img = await screen.findByAltText("a.png");
  expect(img.getAttribute("src")).not.toContain("step=");
  expect(screen.getByRole("button", { name: "After" })).toBeDisabled();
  expect(screen.getByText(/Add a step on the right/)).toBeInTheDocument();
});

// --- a crop step that follows a detector target ---
const followDetail = (over: object = {}): FlowCrop => ({
  kind: "crop", steps: [crop()], follow_step: "s1", input_box: "det:1", crops: [],
  follow: { detector: "det:1", target: "hole", mode: "keep", frame: "a.png", size: [40, 20], offset: [10, -5], missing: ["b.png"], offered: ["position"], modes: [{ id: "keep", label: "Position only: the picture stays upright", enabled: true, needs: [] }] },
  ...over,
});

function followFetch(detail: FlowCrop = followDetail()) {
  vi.stubGlobal("Image", class { naturalWidth = 200; naturalHeight = 100; onload: (() => void) | null = null; set src(_: string) { queueMicrotask(() => this.onload?.()); } });
  stubFetch((url) => {
    if (url.includes("/boxes")) return { boxes: { "a.png": { hole: { x: 99.5, y: 49.5, angle: 0, score: 1, w: 30, h: 20, source: "auto" } } }, review: [] };
    if (!url.includes("/frames") && !url.includes("/vision/filters")) return detail;
    return undefined;
  });
}

test("a following step shows the rectangle next to the target found on this picture and marks pictures without one", async () => {
  followFetch();
  setup(followDetail());
  await screen.findByAltText("Frame to draw on");
  // target centre (100, 50) + offset (10, -5) = (110, 45); 40 x 20 px => x 90..130, y 35..55 of a 200 x 100 picture
  await waitFor(() => expect(screen.getByTestId("roi-box")).toHaveStyle({ left: "45%", top: "35%", width: "20%", height: "20%" }));
  expect(await screen.findByRole("button", { name: "Show b.png" })).toHaveClass("review"); // marked: no target found there
  expect(screen.getByAltText("a.png cropped")).toHaveAttribute("src", expect.stringContaining("stage=output"));
});

test("a step that straightens draws on the picture turned back by the found angle", async () => {
  const detail = followDetail();
  followFetch({ ...detail, follow: { ...detail.follow!, mode: "straighten" } });
  setup({ ...detail, follow: { ...detail.follow!, mode: "straighten" } });
  const img = await screen.findByAltText("Frame to draw on");
  expect(img).toHaveAttribute("src", expect.stringContaining("straighten=true"));
  expect(screen.getByText(/turned back by the found angle/)).toBeInTheDocument();
});

test("a following step saves the rectangle in pixels of the picture, with the picture it was drawn on, when the pointer is released", async () => {
  followFetch(followDetail({ follow: { detector: "det:1", target: "hole", mode: "keep", frame: null, size: null, offset: null, missing: [] } }));
  setup(followDetail({ follow: { detector: "det:1", target: "hole", mode: "keep", frame: null, size: null, offset: null, missing: [] } }));
  await screen.findByAltText("Frame to draw on");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/boxes"))).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  const area = screen.getByTestId("roi-canvas");
  pointer(area, "pointerDown", 10 + 20, 20 + 10);
  pointer(area, "pointerMove", 10 + 120, 20 + 60);
  expect(puts()).toHaveLength(0);
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  await waitFor(() => expect(puts()).toHaveLength(1));
  const body = puts()[0].body;
  expect(body.follow.frame).toBe("a.png");
  expect(body.follow.rect[0]).toBeCloseTo(20);
  expect(body.follow.rect[2]).toBeCloseTo(100);
});

test("Clear rectangle forgets the rectangle of a following step", async () => {
  followFetch();
  setup(followDetail());
  await screen.findByAltText("Frame to draw on");
  fireEvent.click(screen.getByRole("button", { name: "Clear rectangle" }));
  await waitFor(() => expect(puts().at(-1)!.body).toEqual({ follow: null }));
});

test("behind a step that follows a target, a picture without the target says so instead of loading", async () => {
  const detail = followDetail({ steps: [crop(null, "s1"), { id: "s2", op: "filter", name: "gaussian", params: { sigma: 1.5 } }] });
  followFetch(detail);
  setup(detail);
  await screen.findByAltText("a.png"); // the last step (a filter) is open, so the big picture shows its result
  fireEvent.click(screen.getByRole("button", { name: "pick s1" }));
  await screen.findByAltText("Frame to draw on"); // the following step itself: its canvas is where another picture is picked
  fireEvent.click(screen.getByRole("button", { name: "pick s2" }));
  await screen.findByAltText("a.png");
  fireEvent.click(screen.getAllByRole("button", { name: "Show b.png" })[0]);
  expect(await screen.findByRole("status")).toHaveTextContent("det:1 found no hole on this picture");
  expect(screen.queryByAltText("b.png")).toBeNull();
});

// --- the mask step -------------------------------------------------------------------------------------------
const RECT_SHAPE = { shape: "rect" as const, x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
const maskStep = (over: Partial<Extract<FlowEdit, { op: "mask" }>> = {}, id = "s1"): FlowEdit => ({ id, op: "mask", shape: RECT_SHAPE, ...over });

test("the picture that enters a mask does not reload while its shape is dragged", () => {
  const blank = entering([maskStep({ turn: true, rel: {}, anchor: { frame: "a.png" } })], 0);
  expect(blank).toEqual([{ id: "s1", op: "mask", shape: null }]);
});

test("a mask step opens on Before with the shape over the picture that enters it; After shows the masked picture", async () => {
  setup(base([maskStep()]));
  expect(await screen.findByTestId("mask-canvas")).toBeInTheDocument();
  expect(screen.getByTestId("mask-outline")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Before" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "After" }));
  const img = await screen.findByAltText("a.png");
  expect(img.getAttribute("src")).toContain("stage=output");
  expect(decodeURIComponent(img.getAttribute("src")!)).toContain('"op":"mask"');
  expect(screen.queryByTestId("mask-canvas")).toBeNull();
});

test("a mask of a followed target is edited on the picture it was drawn on; on another picture only its result shows", async () => {
  const follow = { detector: "det:1", target: "A", mode: "keep", modes: [], offered: [], frame: null, size: null, offset: null, missing: [] };
  setup(base([crop(null, "s0"), maskStep({ rel: {}, frame: "b.png" }, "s1")], { follow, follow_step: "s0" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Show b.png" })).toHaveAttribute("aria-current", "true")); // selecting the step goes to its picture
  expect(await screen.findByTestId("mask-canvas")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show a.png" }));
  expect(await screen.findByText(/This mask was drawn on b.png/)).toBeInTheDocument();
  expect(screen.queryByTestId("mask-canvas")).toBeNull();
});

// --- the view fits the found box ---
function followFetchBigBox() {
  vi.stubGlobal("Image", class { naturalWidth = 200; naturalHeight = 100; onload: (() => void) | null = null; set src(_: string) { queueMicrotask(() => this.onload?.()); } });
  stubFetch((url) => {
    if (url.includes("/boxes")) return { boxes: { "a.png": { hole: { x: 99.5, y: 49.5, angle: 0, score: 1, w: 100, h: 60, source: "auto" } } }, review: [] };
    if (!url.includes("/frames") && !url.includes("/vision/filters")) return followDetail();
    return undefined;
  });
}

test("the page zooms to the found box when a picture with the target comes on, and Fit to found box brings it back", async () => {
  followFetchBigBox();
  setup(followDetail());
  await screen.findByAltText("Frame to draw on");
  const level = () => Number((screen.getByTestId("zoom-level").textContent ?? "").replace("%", ""));
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  const whole = level();
  fireEvent.click(screen.getByRole("button", { name: "Fit to found box" })); // the same view the page takes by itself when the picture comes on
  const onTarget = level();
  expect(onTarget).toBeGreaterThan(whole * 1.5); // the 100 x 60 box (plus 20 %) of a 200 x 100 picture fills the viewport
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" })); // zoom in may be at its limit on the found box
  expect(level()).not.toBe(onTarget);
  fireEvent.click(screen.getByRole("button", { name: "Fit to found box" }));
  expect(level()).toBeCloseTo(onTarget, 0);
});

test("the view zooms to the found box by itself when the picture with the target comes on", async () => {
  followFetchBigBox();
  setup(followDetail());
  await screen.findByAltText("Frame to draw on");
  await waitFor(() => expect(screen.getByRole("button", { name: "Fit to found box" })).toBeEnabled());
  await new Promise((r) => setTimeout(r, 50)); // the page takes the view in an effect after the box is known
  const level = () => Number((screen.getByTestId("zoom-level").textContent ?? "").replace("%", ""));
  const automatic = level();
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  expect(automatic).toBeGreaterThan(level() * 1.5);
});

// --- navigation: the Detector page's (counter, thumbnail strip, picture grid) -----------------------------------
test("the pictures are walked through with the counter, the strip and the grid, and a picture past the edge is flagged", async () => {
  const base = followDetail();
  const detail = followDetail({ follow: { ...base.follow!, missing: [], edge_frames: ["b.png"], outside: "skip", outside_modes: [{ id: "skip", label: "No crop" }] } });
  followFetch(detail);
  setup(detail);
  await screen.findByAltText("Frame to draw on");
  expect(screen.getByText(/1 \/ 2 · a\.png/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show b.png" })).toHaveClass("review");
  expect(screen.getByRole("button", { name: "Show a.png" })).toHaveClass("ok");
  fireEvent.click(screen.getAllByRole("button", { name: "Next ›" })[0]); // the first is the picture navigation, the others belong to the grid pager
  expect(await screen.findByText(/2 \/ 2 · b\.png/)).toBeInTheDocument();
  expect(screen.getByText("The rectangle reaches past the edge of this picture.")).toBeInTheDocument();
  expect(screen.getByTestId("pictures-grid")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load a.png in the canvas" }));
  expect(await screen.findByText(/1 \/ 2 · a\.png/)).toBeInTheDocument();
});
