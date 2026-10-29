import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ChainView, { toFlowEdge } from "./ChainView";

const node = (over: Record<string, unknown>) => ({
  kind: "roi", ref: "x", label: "x", x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [],
  classes: ["OK", "NG"], frames: 4, labeled: 1, product_counts: {}, unlabeled: 0, ...over,
});

const canvas = (over: Record<string, unknown> = {}) => ({
  camera: "camA",
  products: ["A", "B"],
  classify: "type",
  viewport: null,
  nodes: [
    node({ id: "ingest", kind: "ingest", ref: null, label: "Ingest", role: null, scope: null }),
    node({ id: "roi:type", ref: "type", label: "type", x: 280, role: "classify", mode: "product", scope: "classify", classes: ["A", "B"], labeled: 3, unlabeled: 1, deleted: 2, product_counts: { A: 2, B: 1 } }),
    node({ id: "roi:seal", ref: "seal", label: "seal", x: 840, mode: "feature", scope: "products", products: ["A"], classes: ["OK", "NG"], labeled: 3, unlabeled: 1, product_counts: { OK: 2, NG: 1 }, evaluation: null }),
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
      if (url.endsWith("/detached")) return new Response(JSON.stringify(current));
      if (url.includes("/rois") && method === "DELETE") return new Response(JSON.stringify({ removed: { labels: 7 } }));
      if (url.includes("/rois")) return new Response(JSON.stringify({}));
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// d3-drag (inside React Flow) cannot take user-event's mousedown in jsdom, so boxes are clicked with fireEvent.
const renderView = (onOpenRoi?: (feature: string, view: "roi" | "classify") => void) =>
  render(<MemoryRouter><ChainView camera="camA" onOpenRoi={onOpenRoi} /></MemoryRouter>);

test("draws a box for Ingest and one Classifier per ROI with its class counts, the all dot and the counters", async () => {
  renderView();
  expect(await screen.findByTestId("chain-node-ingest")).toBeInTheDocument();
  const product = screen.getByTestId("chain-node-roi:type");
  expect(product).toHaveTextContent("A2");
  expect(product).toHaveTextContent("B1");
  expect(product).toHaveTextContent("all3");
  expect(product.querySelector(".chain-node-counters")).toHaveTextContent("● 3○ 1🗑 2");
  expect(product.querySelector(".chain-node-scope")).toHaveAttribute("title", "Product · 3/4 labeled"); // the sentence is the tooltip; the body shows icons and numbers
  expect(product.querySelector(".chain-node-scope")).toHaveTextContent("Product▦ 4");
  const seal = screen.getByTestId("chain-node-roi:seal");
  expect(seal.querySelector(".chain-node-scope")).toHaveAttribute("title", "Feature · A · 3/4 labeled");
  expect(seal.querySelector(".chain-node-chip")).toHaveTextContent("A");
  expect(within(product).getByTestId("kind-icon-classifier")).toBeInTheDocument(); // the corner icon is the palette's
  expect(within(screen.getByTestId("chain-node-ingest")).getByTestId("kind-icon-ingest")).toBeInTheDocument();
  expect(screen.queryByTestId("chain-node-classify:type")).not.toBeInTheDocument();
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
  await user.click(screen.getByRole("button", { name: /Delete everything/ }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rois/seal"))).toBe(true));
});

test("Keep it closes the confirmation without deleting", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-roi:seal"));
  await user.click(screen.getByRole("button", { name: /Delete…/ }));
  await user.click(await screen.findByRole("button", { name: /Keep it/ }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("every Classifier has one dot per class and the all dot, and no other output dot", async () => {
  renderView();
  const product = await screen.findByTestId("chain-node-roi:type");
  expect([...product.querySelectorAll(".source")].map((h) => h.getAttribute("data-handleid"))).toEqual(["p:A", "p:B", "all"]);
  const feature = screen.getByTestId("chain-node-roi:seal");
  expect([...feature.querySelectorAll(".source")].map((h) => h.getAttribute("data-handleid"))).toEqual(["p:OK", "p:NG", "all"]);
  expect(product.querySelectorAll(".chain-node-class")[0]).toHaveTextContent("A");
});

test("a Classifier opens the ROI editor and the Classify page, and a feature Classifier can be deleted", async () => {
  const onOpenRoi = vi.fn();
  renderView(onOpenRoi);
  fireEvent.click(await screen.findByTestId("chain-node-roi:type"));
  fireEvent.click(screen.getByRole("button", { name: "Classify" }));
  expect(onOpenRoi).toHaveBeenLastCalledWith("type", "classify");
  fireEvent.click(screen.getByTestId("chain-node-roi:seal"));
  fireEvent.click(screen.getByRole("button", { name: "ROI editor" }));
  expect(onOpenRoi).toHaveBeenLastCalledWith("seal", "roi");
  expect(screen.getByRole("button", { name: /Delete…/ })).toBeInTheDocument();
});

test("every Classifier offers ROI editor and Classify; Ingest only Ingest", async () => {
  renderView(vi.fn());
  for (const [id, wanted, absent] of [
    ["roi:type", ["ROI editor", "Classify"], ["Ingest"]],
    ["roi:seal", ["ROI editor", "Classify"], ["Ingest"]],
    ["ingest", ["Ingest"], ["ROI editor", "Classify"]],
  ] as [string, string[], string[]][]) {
    fireEvent.click(await screen.findByTestId(`chain-node-${id}`));
    for (const name of wanted) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    for (const name of absent) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  }
});

test("the Evaluation of a Classifier is picked in its panel and cleared with None", async () => {
  const user = userEvent.setup();
  current = canvas();
  current.nodes.push(node({ id: "eval:1", kind: "evaluation", ref: null, label: "Evaluation 1", x: 600, y: 300, role: null, scope: null, classes: [], flow: { nominal: 1, tolerance: 1 } }));
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-roi:seal"));
  const pick = screen.getByRole("combobox", { name: "Evaluation" });
  expect(pick).toHaveValue("");
  await user.selectOptions(pick, "eval:1");
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/chain/seal/evaluation") && c.body.box === "eval:1")).toBe(true));
  await user.selectOptions(screen.getByRole("combobox", { name: "Evaluation" }), "");
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/chain/seal/evaluation") && c.body.box === null)).toBe(true));
});

test("Ingest has no Delete button", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-ingest"));
  expect(screen.queryByRole("button", { name: /Delete…/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ingest" })).toBeInTheDocument();
});

test("the Classifier tile creates a real ROI with a free name", async () => {
  const user = userEvent.setup();
  renderView();
  await screen.findByTestId("chain-node-ingest");
  await user.click(screen.getByRole("button", { name: "Add Classifier" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/rois"))).toBe(true));
  const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/rois"))!;
  expect(put.body.name).toBe("classifier");
  // a new Classifier has no rectangle: it uses the picture as it comes in
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/region") && c.body.mode === "as_is")).toBe(true));
});

test("renaming a box saves the layout, not the ROI", async () => {
  renderView();
  const seal = await screen.findByTestId("chain-node-roi:seal");
  fireEvent.click(seal);
  const input = await screen.findByLabelText("Box name");
  fireEvent.change(input, { target: { value: "My seal" } });
  fireEvent.blur(input);
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/chain/layout"))).toBe(true));
  const save = calls.find((c) => c.url.endsWith("/chain/layout"))!;
  expect(save.method).toBe("PUT");
  expect(save.body.nodes["roi:seal"].label).toBe("My seal");
  expect(calls.some((c) => c.url.includes("/rois"))).toBe(false);
});

test("the Detector tile creates a detector box through the flow API", async () => {
  const user = userEvent.setup();
  renderView();
  await screen.findByTestId("chain-node-ingest");
  await user.click(screen.getByRole("button", { name: "Add Detector" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/flow/nodes") && c.body.kind === "detector")).toBe(true));
});

test("a detector box shows its targets and run state, and has a delete that asks first", async () => {
  const user = userEvent.setup();
  current = canvas();
  current.nodes.push(node({
    id: "det:1", kind: "detector", ref: null, label: "Detector 1", x: 300, y: 300, role: null, scope: null, classes: [],
    flow: { targets: ["A", "B"], status: "none" },
  }));
  current.edges.push({ id: "ingest->det:1", source: "ingest", source_handle: null, target: "det:1", locked: true });
  vi.mocked(fetch).mockImplementation(async (url: any, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).includes("/flow/nodes/det%3A1/delete-preview")) return new Response(JSON.stringify({ node: "det:1", kind: "detector", detections: 12, arrows: 2 }));
    if (String(url).includes("/flow/nodes/det%3A1")) return new Response(JSON.stringify({
      kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "none",
      targets: [], summary: { frames: 0, found: {}, complete: 0, review: 0 },
    }));
    if (String(url).endsWith("/chain")) return new Response(JSON.stringify(current));
    return new Response("{}");
  });
  renderView();
  const box = await screen.findByTestId("chain-node-det:1");
  expect(box).toHaveTextContent("◎ 2"); // two targets, as an icon and a number
  expect(within(box).getByTitle("Not run yet")).toBeInTheDocument();
  expect(box).not.toHaveTextContent("2 targets · not run"); // the sentence is only the tooltip
  fireEvent.click(box);
  await user.click(await screen.findByRole("button", { name: /Delete…/ }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("12 pictures with stored boxes");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("arrows are drawn orthogonally (smoothstep) so stacked boxes do not hide them", () => {
  const edge = toFlowEdge({ id: "e", source: "a", source_handle: null, target: "b", locked: true });
  expect(edge.type).toBe("smoothstep");
  expect(edge.deletable).toBe(false);
});

test("a detector box shows a dot per target; dots are the ones to drag onto an ROI", async () => {
  current = canvas({
    nodes: [
      ...canvas().nodes,
      node({ id: "det:1", kind: "detector", ref: null, label: "Detector 1", role: null, scope: null, flow: { targets: ["left hole", "right hole"], status: "fresh", frames: 4, complete: 4 } }),
    ],
  });
  renderView();
  const box = await screen.findByTestId("chain-node-det:1");
  expect(box).toHaveTextContent("left hole");
  expect(box).toHaveTextContent("right hole");
  expect(box.querySelectorAll('[data-handleid^="t:"]')).toHaveLength(2);
  expect(box.querySelector('[data-handleid="t:left hole"]')).not.toBeNull();
});

test("a Picture edits box has one fixed size and shows icons with a badge, not its step list (v1.89.0)", async () => {
  current = canvas();
  current.nodes.push(node({
    id: "crop:1", kind: "crop", ref: null, label: "Picture edits 1", x: 300, y: 300, role: null, scope: null, classes: [],
    flow: { steps: [{ op: "crop", rect: null, enabled: true }, { op: "filter", label: "Gaussian blur", enabled: true }, { op: "filter", label: "Median blur", enabled: false }] },
  }));
  renderView();
  const box = await screen.findByTestId("chain-node-crop:1");
  expect(box).toHaveClass("chain-node-fixed");
  expect(screen.getByTestId("step-icon-crop")).not.toHaveTextContent(/\d/);
  expect(screen.getByTestId("step-icon-filter")).toHaveTextContent("2");
  expect(box).not.toHaveTextContent("Gaussian blur");
  expect(screen.getByTestId("chain-node-roi:seal")).toHaveClass("chain-node-roi"); // every box carries its type: its size and colour come from it
});

test("a Dedup box shows icon counters (pictures, muted, bin) instead of a text line", async () => {
  current = canvas({
    nodes: [...canvas().nodes, node({ id: "dedup:1", kind: "dedup", ref: null, label: "Dedup 1", x: 300, y: 300, role: null, scope: null, classes: [], flow: { source: null, frames: 12, muted: 5, deleted: 2, feeds: [] } })],
  });
  renderView();
  const box = await screen.findByTestId("chain-node-dedup:1");
  expect(box).toHaveTextContent("▦ 12");
  expect(box).toHaveTextContent("🔇 5");
  expect(box).toHaveTextContent("🗑 2");
  expect(box).not.toHaveTextContent("whole camera");
});

test("double-clicking a box opens its page: a feature Classifier on Classify, the product Classifier on its editor, Ingest on Ingest", async () => {
  const onOpenRoi = vi.fn();
  renderView(onOpenRoi);
  fireEvent.doubleClick(await screen.findByTestId("chain-node-roi:seal"));
  expect(onOpenRoi).toHaveBeenCalledWith("seal", "classify");
  fireEvent.doubleClick(screen.getByTestId("chain-node-roi:type"));
  expect(onOpenRoi).toHaveBeenCalledWith("type", "roi");
});

test("a Merge is a small square whose arrow is grey while it collects nothing and green for OK, red for NG; its panel switches any / all", async () => {
  current = canvas();
  current.nodes.push(
    node({ id: "merge:1", kind: "merge", ref: null, label: "Merge 1", x: 900, y: 0, role: null, scope: null, classes: [], flow: { inputs: 0, meaning: null, merge_mode: "any", frames: 0 } }),
    node({ id: "merge:2", kind: "merge", ref: null, label: "Merge 2", x: 900, y: 100, role: null, scope: null, classes: [], flow: { inputs: 2, meaning: "OK", merge_mode: "any", frames: 6 } }),
    node({ id: "merge:3", kind: "merge", ref: null, label: "Merge 3", x: 900, y: 200, role: null, scope: null, classes: [], flow: { inputs: 1, meaning: "NG", merge_mode: "all", frames: 2 } }),
  );
  vi.mocked(fetch).mockImplementation(async (url: any, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).endsWith("/chain")) return new Response(JSON.stringify(current));
    return new Response("{}");
  });
  renderView();
  const neutral = await screen.findByTestId("chain-node-merge:1");
  expect(neutral).toHaveClass("merge-neutral");
  expect(screen.getByTestId("chain-node-merge:2")).toHaveClass("merge-ok");
  expect(screen.getByTestId("chain-node-merge:3")).toHaveClass("merge-ng");
  expect(screen.getByTestId("chain-node-merge:2")).toHaveTextContent("∪ 2");
  expect(screen.getByTestId("chain-node-merge:3")).toHaveTextContent("∩ 1");
  expect(within(neutral).getByTestId("kind-icon-merge")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("chain-node-merge:2"));
  expect(await screen.findByTestId("merge-meaning")).toHaveTextContent("Collects OK");
  await userEvent.selectOptions(screen.getByLabelText("Merge mode"), "all");
  await waitFor(() => expect(calls.find((c) => c.url.includes("/flow/nodes/merge%3A2") && c.method === "PUT")?.body).toEqual({ mode: "all" }));
});

test("the delete confirmation is an overlay, Enter confirms it and Esc cancels, and the right pane holds no confirmation", async () => {
  const user = userEvent.setup();
  renderView();
  fireEvent.click(await screen.findByTestId("chain-node-roi:seal"));
  await user.click(screen.getByRole("button", { name: /Delete…/ }));
  const dialog = await screen.findByRole("alertdialog", { name: "Confirm delete" });
  expect(dialog.closest(".right-panel")).toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: /Delete…/ }));
  await screen.findByRole("alertdialog", { name: "Confirm delete" });
  await user.keyboard("{Enter}");
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rois/seal"))).toBe(true));
});

test("the palette sits on the canvas, not in the right pane, and the help text is under the canvas", async () => {
  renderView();
  const canvas = await screen.findByTestId("chain-canvas");
  const tile = screen.getByRole("button", { name: "Add Detector" });
  expect(canvas.contains(tile)).toBe(true);
  expect(tile.closest(".right-panel")).toBeNull();
  const help = screen.getByText(/double-click it to open its page/);
  expect(canvas.contains(help)).toBe(false);
  expect(help.closest(".right-panel")).toBeNull();
});
