import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ChainView from "./ChainView";

const node = (over: Record<string, unknown>) => ({
  kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [],
  classes: ["OK", "NG"], frames: 4, labeled: 1, product_counts: {}, unlabeled: 0, ...over,
});
const ingest = node({ id: "ingest", kind: "ingest", ref: null, label: "Ingest", role: null, scope: null });
const freeze = (flow: Record<string, unknown> = {}) =>
  node({ id: "export:1", kind: "export", step: 1, ref: null, label: "Freeze 1", role: null, scope: null, classes: [], x: 400, flow: { lines: { ok: 1, ng: 1 }, total: 5, ok: 3, ng: 2, both: 0, frozen: 1, changed: false, ...flow } });
const stepTwoBox = node({ id: "export:2", kind: "export", step: 2, ref: null, label: "Export 2", role: null, scope: null, classes: [], x: 400, y: 200, flow: { lines: { ok: 0, ng: 0 }, total: 0 } });

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
      const pile = body.kind === "ingest_ok" || body.kind === "ingest_ng";
      const id = body.kind === "box" ? "box:1" : pile ? "inok:1" : "crop:1";
      current.nodes.push(node({
        id, kind: body.kind, step: pile || body.kind === "box" ? 2 : body.step, ref: null, label: body.kind === "box" ? "Box 1" : pile ? "Ingest OK 1" : "Picture edits 1", role: null, scope: null, classes: [], x: 0, y: 150,
        ...(pile ? { flow: { frames: 3, freeze: 1, warning: null, cls: "OK" } } : {}),
        ...(body.kind === "box" ? { flow: { box_mode: "two", holes: [], ready: false, found: 0, total: 0, targets: ["box"] } } : {}),
      }));
      return new Response(JSON.stringify({ id }), { status: 201 });
    }
    if (url.endsWith("/rois") && method === "PUT") {
      current.nodes.push(node({ id: `roi:${body.name}`, ref: body.name, label: body.name, x: 0, y: 300 }));
      return new Response(JSON.stringify({ feature: body.name }), { status: 200 });
    }
    if (url.endsWith("/step") && method === "PUT") {
      const found = current.nodes.find((n: any) => n.id === `roi:${decodeURIComponent(url.split("/chain/")[1].split("/step")[0])}`);
      if (found) found.step = body.step;
      return new Response(JSON.stringify(current));
    }
    if (url.endsWith("/chain") || url.endsWith("/chain/layout") || url.endsWith("/detached") || url.endsWith("/region")) return new Response(JSON.stringify(current));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderView = () => render(<MemoryRouter><ChainView camera="camA" /></MemoryRouter>);

test("with no Freeze module and no step-2 box there are no tabs and the palette offers Freeze", async () => {
  renderView();
  await screen.findByTestId("chain-node-ingest");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByRole("button", { name: "Add Freeze" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add Export" })).toBeNull();
});

test("a Freeze module opens the step-2 tab: an empty canvas with its own palette (the two Ingest piles), step 1 is one click back", async () => {
  current.nodes = [ingest, freeze()];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Step 1 · decide OK / NG", "Step 2 · choose pictures"]);
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  expect(screen.queryByTestId("chain-node-ingest")).toBeNull(); // step 2 starts empty: nothing of step 1 is drawn
  expect(screen.queryByTestId("chain-node-export:1")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add Picture edits" })).toBeNull(); // the step-1 modules are not offered
  expect(screen.getByRole("button", { name: "Add Ingest OK" })).toBeInTheDocument(); // step 2 has its own palette
  expect(screen.getByRole("button", { name: "Add Ingest NG" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /Step 1/ }));
  expect(await screen.findByTestId("chain-node-export:1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add Picture edits" })).toBeInTheDocument();
});

test("a box made in step 1 is created for step 1", async () => {
  renderView();
  await screen.findByTestId("chain-node-ingest");
  fireEvent.click(screen.getByRole("button", { name: "Add Picture edits" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/flow/nodes") && c.body?.step === 1 && c.body?.kind === "crop")).toBe(true));
});

test("step 2 warns when step 1 changed since the Freeze, or was never frozen; the tab carries the sign", async () => {
  current.nodes = [ingest, freeze({ changed: true })];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  expect(screen.getByRole("tab", { name: /Step 2/ })).toHaveTextContent("⚠");
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Step 1 has changed since its last freeze");
});

test("a Freeze that was never frozen warns too, and a clean Freeze does not", async () => {
  current.nodes = [ingest, freeze({ frozen: null })];
  const { unmount } = renderView();
  await screen.findByTestId("chain-node-export:1");
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  expect(screen.getByRole("status")).toHaveTextContent("not frozen yet");
  unmount();
  current.nodes = [ingest, freeze()];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  expect(screen.getByRole("tab", { name: /Step 2/ })).not.toHaveTextContent("⚠");
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  expect(screen.queryByRole("status")).toBeNull();
});

test("step-2 boxes stay when the Freeze module is gone: the tab stays, with a warning, and the boxes are drawn", async () => {
  current.nodes = [ingest, stepTwoBox];
  renderView();
  await screen.findByTestId("chain-node-ingest");
  expect(screen.queryByTestId("chain-node-export:2")).toBeNull(); // drawn only in step 2
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  expect(await screen.findByTestId("chain-node-export:2")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Step 1 has no Freeze module");
});

test("Ingest OK is made in step 2, shows its pictures and the freeze it reads, and a pile with nothing to read shows the warning", async () => {
  current.nodes = [ingest, freeze()];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add Ingest OK" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/flow/nodes") && c.body?.kind === "ingest_ok" && c.body?.step === 2)).toBe(true));
  const pile = await screen.findByTestId("chain-node-inok:1");
  expect(pile).toHaveTextContent("Ingest OK 1");
  expect(pile).toHaveTextContent("3");
  expect(pile).toHaveTextContent("❄ v1");
  expect(pile.querySelector(".react-flow__handle.target, [data-handlepos='left']")).toBeNull(); // nothing feeds a pile
  fireEvent.click(screen.getByRole("tab", { name: /Step 1/ }));
  expect(screen.queryByTestId("chain-node-inok:1")).toBeNull(); // drawn only in step 2
});

test("an empty pile says why with a sign on the box", async () => {
  current.nodes = [ingest, node({ id: "inng:1", kind: "ingest_ng", step: 2, ref: null, label: "Ingest NG 1", role: null, scope: null, classes: [], flow: { frames: 0, freeze: null, warning: "Step 1 has no Freeze module.", cls: "NG" } })];
  renderView();
  await screen.findByTestId("chain-node-ingest");
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  const pile = await screen.findByTestId("chain-node-inng:1");
  expect(pile).toHaveTextContent("⚠");
  expect(pile.querySelector("[title='Step 1 has no Freeze module.']")).not.toBeNull();
});

test("a Classifier made in the Step 2 tab is made a step-2 Classifier, one made in step 1 is not", async () => {
  current.nodes = [ingest, freeze()];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  fireEvent.click(screen.getByRole("button", { name: "Add Classifier" })); // step 1
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/rois"))).toBe(true));
  expect(calls.some((c) => c.url.endsWith("/step"))).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add Classifier" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/step") && c.body?.step === 2)).toBe(true));
});

test("the Step 2 tab offers a Box; it is made for step 2, shows what it still needs and has its one dot", async () => {
  current.nodes = [ingest, freeze()];
  renderView();
  await screen.findByTestId("chain-node-export:1");
  expect(screen.queryByRole("button", { name: "Add Box" })).toBeNull(); // not in step 1
  fireEvent.click(screen.getByRole("tab", { name: /Step 2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add Box" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/flow/nodes") && c.body?.kind === "box" && c.body?.step === 2)).toBe(true));
  const box = await screen.findByTestId("chain-node-box:1");
  expect(box).toHaveTextContent("Box 1");
  expect(box).toHaveTextContent("⚠ choose");
  expect(box.querySelectorAll("[data-handleid='t:box']")).toHaveLength(1); // the one output dot
  expect(box.querySelector("[data-handlepos='left']")).toBeNull(); // nothing feeds a Box: the detector boxes are chosen in its panel
});
