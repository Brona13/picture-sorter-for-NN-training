import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ChainView from "./ChainView";

const node = (over: Record<string, unknown>) => ({
  kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [],
  classes: ["OK", "NG"], frames: 4, labeled: 1, ...over,
});

const canvas = (over: Record<string, unknown> = {}) => ({
  camera: "camA",
  products: ["A", "B"],
  classify: "type",
  viewport: null,
  nodes: [
    node({ id: "ingest", kind: "ingest", ref: null, label: "Ingest", role: null, scope: null }),
    node({ id: "roi:type", ref: "type", label: "type", x: 280, role: "classify", scope: "classify", classes: ["A", "B"] }),
    node({ id: "roi:seal", ref: "seal", label: "seal", x: 560, scope: "products", products: ["A"] }),
  ],
  edges: [
    { id: "e1", source: "ingest", source_handle: null, target: "roi:type", locked: false },
    { id: "e2", source: "roi:type", source_handle: "p:A", target: "roi:seal", locked: false },
  ],
  ...over,
});

let calls: { url: string; method: string; body?: any }[];
let current: any;

beforeEach(() => {
  calls = [];
  current = canvas();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_?: string) {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/chain/delete-preview"))
        return new Response(JSON.stringify({ feature: "seal", role: "quality", counts: { labels: 7, goldens: 2, detections: 0, versions: 1 }, dependents: [] }));
      if (url.endsWith("/chain/layout")) return new Response(JSON.stringify(current));
      if (url.endsWith("/chain")) return new Response(JSON.stringify(current));
      if (url.includes("/rois") && method === "DELETE") return new Response(JSON.stringify({ removed: { labels: 7 } }));
      if (url.includes("/rois")) return new Response(JSON.stringify({}));
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// d3-drag (inside React Flow) cannot take user-event's mousedown in jsdom, so boxes are clicked with fireEvent.
const renderView = () => render(<MemoryRouter><ChainView camera="camA" /></MemoryRouter>);

test("draws a box for Ingest and each ROI, with the product handles", async () => {
  renderView();
  expect(await screen.findByTestId("chain-node-ingest")).toBeInTheDocument();
  expect(screen.getByTestId("chain-node-roi:type")).toHaveTextContent("A");
  expect(screen.getByTestId("chain-node-roi:type")).toHaveTextContent("B");
  expect(screen.getByTestId("chain-node-roi:seal")).toHaveTextContent("A · 1/4 labeled");
});

test("deleting a box first shows what would be lost, and only then deletes", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-roi:seal"));
  await user.click(screen.getByRole("button", { name: /Delete…/ }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("7 labels");
  expect(dialog).toHaveTextContent("1 versions");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Delete everything" }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rois/seal"))).toBe(true));
});

test("Keep it closes the confirmation without deleting", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-roi:seal"));
  await user.click(screen.getByRole("button", { name: /Delete…/ }));
  await user.click(await screen.findByRole("button", { name: "Keep it" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("Ingest has no Delete button", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-ingest"));
  expect(screen.queryByRole("button", { name: /Delete…/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Ingest" })).toBeInTheDocument();
});

test("+ ROI feature creates a real ROI with a free name", async () => {
  const user = userEvent.setup();
  renderView();
  await screen.findByTestId("chain-node-ingest");
  await user.click(screen.getByRole("button", { name: "+ ROI feature" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/rois"))).toBe(true));
  const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/rois"))!;
  expect(put.body.name).toBe("feature");
});

test("+ ROI product is disabled once the camera has its product-sorting ROI", async () => {
  renderView();
  await screen.findByTestId("chain-node-ingest");
  expect(screen.getByRole("button", { name: "+ ROI product" })).toBeDisabled();
});

test("renaming a box saves the layout, not the ROI", async () => {
  renderView();
  const seal = await screen.findByTestId("chain-node-roi:seal");
  fireEvent.doubleClick(seal.querySelector(".chain-node-title")!);
  const input = screen.getByLabelText("Box name");
  fireEvent.change(input, { target: { value: "My seal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/chain/layout"))).toBe(true));
  const save = calls.find((c) => c.url.endsWith("/chain/layout"))!;
  expect(save.method).toBe("PUT");
  expect(save.body.nodes["roi:seal"].label).toBe("My seal");
  expect(calls.some((c) => c.url.includes("/rois"))).toBe(false);
});
