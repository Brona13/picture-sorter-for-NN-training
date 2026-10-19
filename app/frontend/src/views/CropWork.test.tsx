import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FlowCrop } from "../api";
import CropWork from "./CropWork";

// jsdom has no layout: pretend the canvas is 200x100 at (10, 20).
let calls: { url: string; method: string; body?: any }[];

beforeEach(() => {
  calls = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON() {} } as DOMRect);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/frames")) return new Response(JSON.stringify({ frames: ["a.png", "b.png"], showing_all: true, total: 2, reference_frame: null }));
    if (method === "PUT") return new Response(JSON.stringify({ kind: "crop", rect: calls.at(-1)!.body.rect, input_box: "ingest", crops: [] }));
    return new Response(JSON.stringify({ kind: "crop", rect: calls.filter((c) => c.method === "PUT").at(-1)?.body.rect ?? null, input_box: "ingest", crops: [] }));
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pointer(target: Element, type: string, clientX: number, clientY: number) {
  const ev = createEvent[type as "pointerDown"](target, { clientX, clientY, pointerId: 1, bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  fireEvent(target, ev);
}

const base: FlowCrop = { kind: "crop", rect: null, input_box: "ingest", crops: [] };
const setup = (detail: FlowCrop = base) => {
  const fns = { setDetail: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  render(<CropWork camera="camA" nodeId="crop:1" detail={detail} {...fns} />);
  return fns;
};

test("shows the picture that enters the box and offers every picture of the camera", async () => {
  setup();
  const img = await screen.findByAltText("Frame to draw on");
  expect(img).toHaveAttribute("src", expect.stringContaining("/flow/nodes/crop%3A1/picture?frame=a.png"));
  expect(await screen.findByRole("option", { name: "b.png" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset zoom" })).toBeInTheDocument(); // the shared zoom pane: Reset and 1:1
});

test("drawing a rectangle saves it as fractions when the pointer is released, not before", async () => {
  const { setDetail } = setup();
  await screen.findByAltText("Frame to draw on");
  const area = screen.getByTestId("roi-canvas");
  pointer(area, "pointerDown", 10 + 20, 20 + 10);
  pointer(area, "pointerMove", 10 + 120, 20 + 60);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.url).toContain("/flow/nodes/crop%3A1");
  expect(put.body.rect[0]).toBeCloseTo(0.1);
  expect(put.body.rect[2]).toBeCloseTo(0.5);
  await waitFor(() => expect(setDetail).toHaveBeenCalled());
});

test("moving the rectangle saves once on release; a click without a drag saves nothing; Clear crop empties it", async () => {
  setup({ ...base, rect: [0.2, 0.2, 0.4, 0.4] });
  await screen.findByAltText("Frame to draw on");
  const area = screen.getByTestId("roi-canvas");
  pointer(screen.getByTestId("roi-box"), "pointerDown", 10 + 100, 20 + 50);
  pointer(screen.getByTestId("roi-box"), "pointerUp", 10 + 100, 20 + 50);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  pointer(screen.getByTestId("roi-box"), "pointerDown", 10 + 100, 20 + 50);
  pointer(area, "pointerMove", 10 + 120, 20 + 60);
  pointer(area, "pointerUp", 10 + 120, 20 + 60);
  await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
  expect(calls.find((c) => c.method === "PUT")!.body.rect[0]).toBeCloseTo(0.3);
  fireEvent.click(screen.getByRole("button", { name: "Clear crop" }));
  await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)!.body.rect).toBeNull());
});

test("shows the cut-out as the result once a rectangle exists", async () => {
  setup({ ...base, rect: [0.2, 0.2, 0.4, 0.4] });
  const result = await screen.findByAltText("a.png cropped");
  expect(result).toHaveAttribute("src", expect.stringContaining("stage=output"));
});
