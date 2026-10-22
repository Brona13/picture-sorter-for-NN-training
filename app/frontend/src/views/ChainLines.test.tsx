import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// React Flow draws no edges in jsdom, so its handlers are driven directly through the props ChainView gives it.
let flowProps: any;
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<any>("@xyflow/react");
  return { ...actual, ReactFlow: (props: any) => { flowProps = props; return null; } };
});
import ChainView from "./ChainView";

const node = (over: Record<string, unknown>) => ({
  kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [],
  classes: ["OK", "NG"], frames: 4, labeled: 1, product_counts: {}, unlabeled: 0, ...over,
});
const flowNode = (id: string, kind: string, label: string) => node({ id, kind, ref: null, label, role: null, scope: null, classes: [], flow: { status: "none", targets: ["P"] } });

let calls: { url: string; method: string; body?: any }[];
let current: any;

beforeEach(() => {
  calls = [];
  current = {
    camera: "camA", products: ["A", "B"], classify: "type", viewport: null,
    nodes: [
      node({ id: "ingest", kind: "ingest", ref: null, label: "Ingest", role: null, scope: null }),
      node({ id: "roi:type", ref: "type", label: "type", role: "classify", scope: "classify", classes: ["A", "B"] }),
      node({ id: "classify:type", kind: "classify", ref: "type", label: "Classify", role: "classify", scope: null, classes: ["A", "B"] }),
      node({ id: "roi:seal", ref: "seal", label: "seal", scope: "products", products: ["A"] }),
      flowNode("crop:1", "crop", "Picture edits 1"),
      flowNode("det:1", "detector", "Detector 1"),
      flowNode("det:2", "detector", "Detector 2"),
    ],
    edges: [
      { id: "e2", source: "classify:type", source_handle: "p:A", target: "roi:seal", locked: false },
      { id: "f1", source: "crop:1", source_handle: null, target: "det:1", locked: false },
      { id: "f0", source: "ingest", source_handle: null, target: "roi:type", locked: true },
    ],
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_?: string) {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/chain") || url.endsWith("/chain/layout")) return new Response(JSON.stringify(current));
    return new Response("{}");
  }));
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  render(<MemoryRouter><ChainView camera="camA" /></MemoryRouter>);
  await waitFor(() => expect(flowProps?.nodes?.length).toBeGreaterThan(0));
};
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/chain/layout"));
const dialog = () => screen.queryByRole("alertdialog", { name: "Confirm line change" });

test("Delete on a selected line shows the overlay and removes nothing yet", async () => {
  await open();
  let result: any;
  await act(async () => { result = await flowProps.onBeforeDelete({ nodes: [], edges: [{ id: "e2" }] }); });
  expect(result).toEqual({ nodes: [], edges: [] }); // React Flow itself deletes nothing
  expect(dialog()).toHaveTextContent("Delete the line Classify → seal");
  expect(dialog()).toHaveTextContent("no longer applies to A");
  expect(writes()).toHaveLength(0);
});

test("Esc keeps the line, Enter removes it", async () => {
  await open();
  await act(async () => { await flowProps.onBeforeDelete({ nodes: [], edges: [{ id: "e2" }] }); });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  expect(writes()).toHaveLength(0);

  await act(async () => { await flowProps.onBeforeDelete({ nodes: [], edges: [{ id: "e2" }] }); });
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(writes().some((c) => c.method === "PATCH" && c.url.includes("/rois/seal/products"))).toBe(true));
  expect(dialog()).not.toBeInTheDocument();
});

test("a flow line is removed through the flow API after Enter, and says what the detector loses", async () => {
  await open();
  await act(async () => { await flowProps.onBeforeDelete({ nodes: [], edges: [{ id: "f1" }] }); });
  expect(dialog()).toHaveTextContent("Detector 1 searches the whole picture");
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(writes().some((c) => c.url.endsWith("/flow/edges/remove") && c.body.source === "crop:1" && c.body.target === "det:1")).toBe(true));
});

test("a line that is fixed by the ROI's name is not offered for deletion", async () => {
  await open();
  await act(async () => { await flowProps.onBeforeDelete({ nodes: [], edges: [{ id: "f0" }] }); });
  expect(dialog()).not.toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test("drawing onto a taken input asks; Esc leaves the old line; a free output or input does not ask", async () => {
  await open();
  // Detector 2 has no input: no question, the line is made at once.
  act(() => flowProps.onConnect({ source: "crop:1", sourceHandle: null, target: "det:2" }));
  await waitFor(() => expect(writes().some((c) => c.url.endsWith("/flow/edges") && c.body.target === "det:2")).toBe(true));
  expect(dialog()).not.toBeInTheDocument();
  calls.length = 0;
  // Detector 1 is fed by crop:1: Ingest onto it asks first.
  act(() => flowProps.onConnect({ source: "ingest", sourceHandle: null, target: "det:1" }));
  expect(dialog()).toHaveTextContent("Replace the input of Detector 1?");
  expect(dialog()).toHaveTextContent("fed by Picture edits 1");
  expect(writes()).toHaveLength(0);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  expect(writes()).toHaveLength(0);
  act(() => flowProps.onConnect({ source: "ingest", sourceHandle: null, target: "det:1" }));
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(writes().some((c) => c.url.endsWith("/flow/edges") && c.body.source === "ingest" && c.body.target === "det:1")).toBe(true));
});
