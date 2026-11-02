import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowBoxModule } from "../api";
import BoxOptions from "./BoxOptions";
import BoxWork, { axesOf, movedRect } from "./BoxWork";

const detail = (over: Partial<FlowBoxModule> = {}): FlowBoxModule => ({
  kind: "box", mode: "two", measure_from: "edge", margins: { left: 0, right: 0, up: 0, down: 0 },
  holes: [{ detector: "det:1", target: "left hole" }, { detector: "det:1", target: "right hole" }], needed: 2,
  candidates: [
    { detector: "det:1", target: "left hole", detector_label: "Detector 1", label: "Detector 1 · left hole" },
    { detector: "det:1", target: "right hole", detector_label: "Detector 1", label: "Detector 1 · right hole" },
    { detector: "det:2", target: "nut", detector_label: "Nut finder", label: "Nut finder · nut" },
  ],
  frames: ["a.png", "b.png"], total: 3, stale: [], ...over,
});

const geometry = {
  frame: "a.png", size: { w: 400, h: 200 },
  holes: [
    { detector: "det:1", target: "left hole", x: 100, y: 100, w: 20, h: 10, angle: 0, score: 1, source: "auto" },
    { detector: "det:1", target: "right hole", x: 300, y: 100, w: 20, h: 10, angle: 0, score: 1, source: "auto" },
  ],
  missing: [],
  rect: { angle: 0, corners: [[90, 95], [310, 95], [310, 105], [90, 105]], x: 200, y: 100, w: 220, h: 10 },
  upright: { x: 200, y: 100, w: 220, h: 10 },
};

let calls: { url: string; method: string; body?: any }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.includes("/box-geometry")) return new Response(JSON.stringify({ ...geometry, frame: new URL(url, "http://x").searchParams.get("frame") }));
    if (init?.method === "PUT") return new Response(JSON.stringify(detail({ margins: { left: 0, right: 0, up: 0, down: 0, ...body.margins } })));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function pointer(target: EventTarget, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target as Element, { clientX, clientY, pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target as Element, ev);
}

async function mount(d = detail()) {
  const setDetail = vi.fn();
  const onError = vi.fn();
  render(<BoxWork camera="camA" nodeId="box:1" detail={d} setDetail={setDetail} onError={onError} />);
  const overlay = await screen.findByTestId("box-overlay");
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect; // 1 client px = 1 picture px
  return { setDetail, onError };
}

test("the page shows the chosen detector boxes, the dashed rectangle the numbers make and the upright one round it", async () => {
  await mount();
  expect(screen.getAllByTestId("box-hole")).toHaveLength(2);
  expect(screen.getByTestId("box-turned")).toBeInTheDocument();
  expect(screen.getByTestId("box-upright")).toHaveAttribute("width", "220");
  expect(screen.getByTestId("box-numbers")).toHaveTextContent("220 × 10 px");
  expect(screen.getByAltText("a.png")).toHaveAttribute("src", expect.stringContaining("/flow/nodes/box%3A1/picture?frame=a.png"));
  expect(calls.find((c) => c.url.includes("/box-geometry"))!.url).toContain("frame=a.png");
});

test("the arrows walk the pictures that have a rectangle", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Next picture" }));
  await waitFor(() => expect(screen.getByTestId("box-frame")).toHaveTextContent("b.png"));
  expect(screen.getByRole("button", { name: "Next picture" })).toBeDisabled();
  await waitFor(() => expect(calls.some((c) => c.url.includes("frame=b.png"))).toBe(true));
});

test("dragging the right handle outwards widens the upright rectangle at once and saves the right margin", async () => {
  const { setDetail } = await mount();
  const handle = screen.getByTestId("box-handle-right");
  pointer(handle, "pointerDown", 310.5, 100.5);
  pointer(window, "pointerMove", 330.5, 100.5);
  expect(screen.getByTestId("box-upright")).toHaveAttribute("width", "240"); // 20 px further out, before anything is saved
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  pointer(window, "pointerUp", 330.5, 100.5);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ margins: { right: 20 } });
  expect(calls.find((c) => c.method === "PUT")!.url).toContain("/flow/nodes/box%3A1");
  await waitFor(() => expect(setDetail).toHaveBeenCalled());
});

test("dragging the up handle upwards raises the up margin, measured in the part's own direction", async () => {
  await mount();
  pointer(screen.getByTestId("box-handle-up"), "pointerDown", 200.5, 95.5);
  pointer(window, "pointerMove", 200.5, 85.5);
  pointer(window, "pointerUp", 200.5, 85.5);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ margins: { up: 10 } });
});

test("a drag that ends where it began saves nothing", async () => {
  await mount();
  pointer(screen.getByTestId("box-handle-left"), "pointerDown", 90.5, 100.5);
  pointer(window, "pointerUp", 90.5, 100.5);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("until the choice is complete the page says what to do, and a picture with a missing hole says which", async () => {
  const { unmount } = render(<BoxWork camera="camA" nodeId="box:1" detail={detail({ holes: [], frames: [] })} setDetail={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByText(/Choose two detector boxes/)).toBeInTheDocument();
  unmount();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...geometry, holes: geometry.holes.slice(0, 1), missing: ["right hole"], rect: null, upright: null }))));
  render(<BoxWork camera="camA" nodeId="box:1" detail={detail()} setDetail={vi.fn()} onError={vi.fn()} />);
  expect(await screen.findByText(/found no right hole on this picture/)).toBeInTheDocument();
  expect(screen.queryByTestId("box-turned")).toBeNull();
});

test("movedRect moves the side that is dragged along the part's own direction and squares the result off", () => {
  const upright: [number, number][] = [[90, 95], [310, 95], [310, 105], [90, 105]];
  const left = movedRect(upright, 0, "left", 10);
  expect(left.corners[0][0]).toBe(80);
  expect(left.upright.x0).toBe(80);
  // a part turned a quarter counter-clockwise: its left side is the bottom of the picture
  const { u } = axesOf(90);
  expect(Math.round(u[0])).toBe(0);
  expect(Math.round(u[1])).toBe(-1);
  const quarter = movedRect([[100, 100], [100, 0], [120, 0], [120, 100]], 90, "left", 10);
  expect(quarter.upright.y1).toBe(110); // "left" moved outwards = down the picture
});

const options = (d = detail()) => {
  const onUpdate = vi.fn();
  render(<BoxOptions detail={d} onUpdate={onUpdate} />);
  return onUpdate;
};

test("the options list the detector boxes of step 1 and send the left and right hole in order", () => {
  const onUpdate = options(detail({ holes: [], frames: [] }));
  const left = screen.getByLabelText("Left hole") as HTMLSelectElement;
  expect(within(left).getAllByRole("option").map((o) => o.textContent)).toEqual(["— choose a detector box —", "Detector 1 · left hole", "Detector 1 · right hole", "Nut finder · nut"]);
  fireEvent.change(left, { target: { value: "det:1\u0000left hole" } });
  expect(onUpdate).toHaveBeenCalledWith({ holes: [{ detector: "det:1", target: "left hole" }] });
});

test("choosing the right hole keeps the left one; swap exchanges them", () => {
  const onUpdate = options();
  fireEvent.change(screen.getByLabelText("Right hole"), { target: { value: "det:2\u0000nut" } });
  expect(onUpdate).toHaveBeenLastCalledWith({ holes: [{ detector: "det:1", target: "left hole" }, { detector: "det:2", target: "nut" }] });
  fireEvent.click(screen.getByRole("button", { name: /Swap/ }));
  expect(onUpdate).toHaveBeenLastCalledWith({ holes: [{ detector: "det:1", target: "right hole" }, { detector: "det:1", target: "left hole" }] });
});

test("one box: a single choice, and switching the mode is sent", () => {
  const onUpdate = options(detail({ mode: "one", needed: 1, holes: [{ detector: "det:2", target: "nut" }] }));
  expect(screen.queryByLabelText("Left hole")).toBeNull();
  expect((screen.getByLabelText("Box") as HTMLSelectElement).value).toBe("det:2\u0000nut");
  fireEvent.change(screen.getByLabelText("Works with"), { target: { value: "two" } });
  expect(onUpdate).toHaveBeenCalledWith({ mode: "two" });
});

test("measure from edge or centre, and the four margins are typed and saved when you leave the field", () => {
  const onUpdate = options();
  fireEvent.click(screen.getByLabelText(/The box centre/));
  expect(onUpdate).toHaveBeenCalledWith({ measure_from: "centre" });
  const left = screen.getByLabelText("Left (px)") as HTMLInputElement;
  fireEvent.change(left, { target: { value: "12" } });
  expect(onUpdate).not.toHaveBeenCalledWith({ margins: { left: 12 } }); // nothing is saved while typing
  fireEvent.blur(left);
  expect(onUpdate).toHaveBeenCalledWith({ margins: { left: 12 } });
  for (const name of ["Right (px)", "Up (px)", "Down (px)"]) expect(screen.getByLabelText(name)).toBeInTheDocument();
});

test("an unchanged or empty margin sends nothing, and a stale detector is called out", () => {
  const onUpdate = options(detail({ stale: ["det:1"] }));
  const up = screen.getByLabelText("Up (px)") as HTMLInputElement;
  fireEvent.blur(up);
  fireEvent.change(up, { target: { value: "" } });
  fireEvent.blur(up);
  expect(onUpdate).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("det:1 changed since it last ran in step 1");
  expect(screen.getByText(/2 of 3 pictures have a rectangle/)).toBeInTheDocument();
});
