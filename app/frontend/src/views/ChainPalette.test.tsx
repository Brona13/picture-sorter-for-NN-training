import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ChainView from "./ChainView";

const node = (over: Record<string, unknown>) => ({
  kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [],
  classes: ["OK", "NG"], frames: 4, labeled: 1, product_counts: {}, unlabeled: 0, ...over,
});
const ingest = node({ id: "ingest", kind: "ingest", ref: null, label: "Ingest", role: null, scope: null, x: 0, y: 0 });

let calls: { url: string; method: string; body?: any }[];
let current: any;

beforeEach(() => {
  calls = [];
  current = { camera: "camA", products: [], classify: null, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [ingest], edges: [] };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_?: string) {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/flow/nodes") && method === "POST") {
      current.nodes.push(node({ id: `${body.kind === "detector" ? "det" : "crop"}:1`, kind: body.kind, ref: null, label: "Box", role: null, scope: null, classes: [], x: 0, y: 150 }));
      return new Response(JSON.stringify({ id: `${body.kind === "detector" ? "det" : "crop"}:1` }), { status: 201 });
    }
    if (url.endsWith("/rois") && method === "PUT") {
      const name = body.name;
      current.nodes.push(node({ id: `roi:${name}`, ref: name, label: name, x: 0, y: 150 }));
      if (body.make_classifier) current.classify = name;
      return new Response(JSON.stringify({ feature: name }));
    }
    if (url.endsWith("/chain") || url.endsWith("/chain/layout")) return new Response(JSON.stringify(current));
    return new Response("{}");
  }));
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  render(<MemoryRouter><ChainView camera="camA" /></MemoryRouter>);
  return screen.findByTestId("chain-canvas");
};
const layout = () => calls.filter((c) => c.method === "PUT" && c.url.endsWith("/chain/layout")).at(-1)?.body;
// jsdom has no DragEvent: a mouse event carries the pointer position and the data transfer is attached to it.
const drop = (target: Element, kind: string, clientX: number, clientY: number) => {
  const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer(kind) });
  fireEvent(target, event);
};
const dataTransfer = (kind: string) => ({ types: ["application/x-chain-box"], getData: (t: string) => (t === "application/x-chain-box" ? kind : ""), setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" });

test("the tiles are grouped by in / out type and each is draggable", async () => {
  await open();
  for (const g of ["Picture in, picture out", "Picture in, points out", "Points in, number or verdict out", "Sorts pictures into classes"]) {
    expect(screen.getByRole("region", { name: g })).toBeInTheDocument();
  }
  for (const label of ["Picture edits", "Detector", "Calculate", "Evaluation", "Classifier"]) {
    expect(screen.getByRole("button", { name: `Add ${label}` })).toHaveAttribute("draggable", "true");
  }
});

test("dragging a tile shows a ghost the size of the box and carries the kind", async () => {
  await open();
  const dt = dataTransfer("detector");
  fireEvent.dragStart(screen.getByRole("button", { name: "Add Detector" }), { dataTransfer: dt });
  expect(dt.setData).toHaveBeenCalledWith("application/x-chain-box", "detector");
  expect(dt.setDragImage).toHaveBeenCalledTimes(1);
  const ghost = dt.setDragImage.mock.calls[0][0] as HTMLElement;
  expect(ghost.style.width).toBe("200px");
  expect(ghost.textContent).toBe("Detector");
  expect(ghost.style.top).toBe("0px"); // inside the window: Chrome on Windows does not draw an element outside it
  expect(ghost.style.left).toBe("0px");
});

test("dropping a tile makes the box where it is dropped and draws no line", async () => {
  const canvas = await open();
  fireEvent.dragOver(canvas, { dataTransfer: dataTransfer("detector") });
  drop(canvas, "detector", 500, 300);
  await waitFor(() => expect(layout()).toBeDefined());
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/flow/nodes") && c.body.kind === "detector")).toBe(true);
  expect(layout().nodes["det:1"]).toMatchObject({ x: 400, y: 257 }); // centred on the pointer
  expect(calls.some((c) => c.url.endsWith("/flow/edges"))).toBe(false);
  expect(current.edges).toEqual([]);
});

test("a drop that does not come from a tile is ignored", async () => {
  const canvas = await open();
  fireEvent.drop(canvas, { dataTransfer: { types: [], getData: () => "", setData: vi.fn() }, clientX: 10, clientY: 10 });
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("a click adds the box at a free spot, never on top of another box", async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole("button", { name: "Add Picture edits" }));
  await waitFor(() => expect(layout()?.nodes["crop:1"]).toBeDefined());
  const spot = layout().nodes["crop:1"];
  expect(spot.x >= 170 + 24 || spot.y >= 64 + 24 || spot.x + 200 <= 0 - 24 || spot.y + 86 <= 0 - 24).toBe(true); // clear of Ingest (0, 0)
  expect(calls.some((c) => c.url.endsWith("/flow/edges"))).toBe(false);
});

test("the Classifier tile drops one Classifier where it was dropped", async () => {
  const canvas = await open();
  drop(canvas, "classifier", 600, 400);
  await waitFor(() => expect(layout()?.nodes["roi:classifier"]).toBeDefined());
  expect(layout().nodes["roi:classifier"]).toMatchObject({ x: 500, y: 358 });
  expect(layout().nodes["classify:classifier"]).toBeUndefined(); // there is no separate Classify box
  // a new feature Classifier hangs alone: no automatic line from Ingest
  expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/chain/classifier/detached") && c.body.detached === true)).toBe(true);
});

