import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DedupView, { drift, sweepRuns } from "./DedupView";
import { niceAxis, nearestIndex } from "./DedupSweepChart";

const params = { method: "resnet50", epsilon: 0.02, min_points: 2 };
const result = {
  params,
  summary: { clusters: 2, covered: 5, unique: 1, total: 6 },
  would_mute: 3,
  clusters: [
    { id: 0, members: ["a.png", "b.png", "c.png"], representative: "a.png" },
    { id: 1, members: ["d.png", "e.png"], representative: "d.png" },
  ],
  noise_frames: ["f.png"],
  classes: ["OK", "NG"],
  marks: { "f.png": { label: "OK", golden: "OK" } },
};
const baseState = (over: Record<string, unknown> = {}) => ({
  feature: "seal",
  source: "seal",
  reason: null,
  backbones: ["resnet18", "resnet50"],
  params,
  ranges: { epsilon: [0.001, 0.2], min_points: [2, 10] },
  frames: 6,
  device: "cpu",
  device_label: "cpu",
  muted_count: 0,
  projections: ["umap", "tsne"],
  grid: { per_page: 24, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] },
  result: null,
  ...over,
});

const sweepResult = {
  epsilons: [0.01, 0.02, 0.03, 0.04],
  min_points: [2, 3],
  lines: [
    { min_points: 2, clusters: [1, 5, 3, 1], would_mute: [1, 9, 20, 30] },
    { min_points: 3, clusters: [null, 2, 1, 1], would_mute: [null, 4, 12, 30] },
  ],
  window: { from: 0.01, to: 0.04 },
  peak: { epsilon: 0.02, min_points: 2, clusters: 5 },
  frames: 6,
  method: "resnet50",
};
let heldSweep: any = null;

let calls: { url: string; method: string; body?: any }[];
let state: any;

beforeEach(() => {
  calls = [];
  heldSweep = null;
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  state = baseState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/dedup/boxes")) return ok([{ feature: "seal", label: "seal" }]);
      if (url.includes("/dedup/frames"))
        return ok({ frames: ["a.png", "b.png", "c.png"], muted: ["b.png"], source: "seal", classes: ["OK", "NG"], marks: {} });
      if (url.includes("/dedup/state")) return ok(state);
      if (url.includes("/dedup/settings")) return ok({ params });
      if (url.includes("/classify/deleted?")) return ok({ items: [{ frame: "x.png", deleted_at: 1760000000, note: "" }] });
      if (url.endsWith("/classify/restore-bulk")) return ok({ restored: 1 });
      if (url.endsWith("/dedup/mute-frames")) return ok({ muted: 2, skipped_golden: 0, already: 0 });
      if (url.endsWith("/dedup/sweep") && method === "POST") return ok({ id: "w1", status: "queued", progress: {} }, 202);
      if (url.includes("/dedup/sweep")) return ok({ sweep: heldSweep });
      if (url === "/api/jobs/w1") return ok({ id: "w1", status: "done", progress: {}, result: sweepResult, error: null });
      if (url.endsWith("/dedup/cluster")) return ok({ id: "c1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/c1") return ok({ id: "c1", status: "done", progress: {}, result, error: null });
      if (url.endsWith("/dedup/outliers")) return ok({ id: "o1", status: "queued", progress: {}, result: null, error: null }, 202);
      if (url === "/api/jobs/o1")
        return ok({
          id: "o1",
          status: "done",
          progress: {},
          error: null,
          result: {
            method: "resnet50",
            k: 5,
            scores: [{ frame: "far.png", score: 0.42 }],
            summary: { min: 0.42, median: 0.42, p95: 0.42, max: 0.42 },
            marks: {},
            classes: ["OK", "NG"],
          },
        });
      if (url.endsWith("/dedup/apply")) return ok({ muted: 3, unmuted: 0, skipped_labeled: 1, skipped_golden: 0 });
      if (url.endsWith("/dedup/scatter")) return ok({ id: "s1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/s1")
        return ok({
          id: "s1",
          status: "done",
          progress: {},
          error: null,
          result: {
            projection: "umap",
            from_cache: true,
            classes: ["OK", "NG"],
            points: [
              { frame: "a.png", x: 0, y: 0, cluster: state.result ? 0 : null, representative: true, golden: null, label: null },
              { frame: "f.png", x: 1, y: 1, cluster: state.result ? -1 : null, representative: false, golden: "OK", label: "OK" },
            ],
          },
        });
      if (url.endsWith("/classify/label-bulk")) return ok({ labeled: 1 });
      if (url.endsWith("/classify/label")) return ok({ card: { frame: JSON.parse(init!.body as string).frame, label: JSON.parse(init!.body as string).cls, golden: null, deleted: false }, counts: {} });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: JSON.parse(init!.body as string).frame, label: null, golden: null, deleted: true }, counts: {} });
      if (url.endsWith("/classify/delete-preview")) return ok({ total: 1, labeled: 1, golden: 0 });
      if (url.endsWith("/classify/delete-bulk")) return ok({ deleted: 1, cleared_labels: 1, cleared_goldens: 0 });
      if (url.includes("/dedup/mutes") && method === "DELETE") return ok({ unmuted: 3 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("drift lists only the changed parameters", () => {
  expect(drift(params, params)).toEqual([]);
  expect(drift(params, { method: "resnet18", epsilon: 0.05, min_points: 3 })).toEqual([
    "embedding 'resnet50' → 'resnet18'",
    "ε 0.020 → 0.050",
    "minPts 2 → 3",
  ]);
});

test("explains missing optional dependencies", async () => {
  state = baseState({ reason: "no_embeddings" });
  render(<DedupView camera="camA" />);
  expect(await screen.findByText(/requires ResNet embeddings/)).toBeInTheDocument();
});

test("points to Configuration when no ResNet method is switched on", async () => {
  state = baseState({ reason: "methods_off" });
  render(<DedupView camera="camA" />);
  expect(await screen.findByText(/No ResNet method is switched on/)).toBeInTheDocument();
});

test("moving a slider persists the setting", async () => {
  render(<DedupView camera="camA" tool="clusters" />);
  await screen.findByLabelText("Min points");
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  await waitFor(() => expect(calls.some((c) => c.url.includes("/dedup/settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/dedup/settings"))!.body).toMatchObject({ feature: "seal", method: "resnet50", min_points: 3 });
});

test("cluster job shows summary and clusters; apply sends representative overrides", async () => {
  render(<DedupView camera="camA" tool="clusters" />);
  await userEvent.click(await screen.findByRole("button", { name: /Cluster$/ }));
  expect(calls.find((c) => c.url.endsWith("/dedup/cluster"))!.body).toEqual({ feature: "seal", ...params });
  expect(await within(await screen.findByTestId("card-a.png")).findByRole("button", { name: "Representative of this cluster" })).toBeInTheDocument();
  expect(screen.getByText("Would mute").nextSibling).toHaveTextContent("3");
  const nav = screen.getByRole("navigation", { name: "Clusters" });
  expect(within(nav).getByRole("button", { name: /Cluster 0/ })).toHaveTextContent("3");
  expect(within(nav).getByRole("button", { name: /Unique/ })).toHaveTextContent("1");
  // a compact row of tabs: "0 (3)", "1 (2)", "Unique (1)", in that order
  expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["0 (3)", "1 (2)", "Unique (1)"]);

  // pick another representative for cluster 0 from its card
  await userEvent.click(within(screen.getByTestId("card-c.png")).getByRole("button", { name: "Make representative" }));
  expect(await within(screen.getByTestId("card-c.png")).findByRole("button", { name: "Representative of this cluster" })).toBeInTheDocument();
  const group = screen.getByTestId("clusters-controls");
  expect(within(group).getByTestId("mute-status")).toHaveTextContent("3 frame(s) will be muted");
  expect(screen.getAllByRole("button", { name: /Apply mute/ })).toHaveLength(1); // only in the Clusters group, not under the table
  await userEvent.click(within(group).getByRole("button", { name: "Apply mute" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/dedup/apply"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/dedup/apply"))!.body).toEqual({ feature: "seal", picks: { 0: "c.png" } });
  expect(await screen.findByText(/Muted 3 frame\(s\) · skipped: 1 labeled\./)).toBeInTheDocument();
  expect(screen.queryByTestId("cluster-browser")).toBeNull(); // result consumed
});

test("the unique frames get their own entry in the list and are never offered as representatives", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" tool="clusters" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Unique/ }));
  expect(await screen.findByRole("button", { name: /^Unique/ })).toHaveAttribute("aria-current", "true");
  const card = screen.getByTestId("card-f.png");
  expect(within(card).queryByRole("button", { name: /representative/i })).toBeNull();
  expect(within(card).getByText(/reference/)).toBeInTheDocument(); // golden mark from the result's marks
});

test("changed sliders warn that the shown clusters are stale and can be reverted", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" tool="clusters" />);
  await screen.findByTestId("cluster-browser");
  expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  expect(await screen.findByRole("status")).toHaveTextContent("minPts 2 → 3");
  await userEvent.click(screen.getByRole("button", { name: /Revert/ }));
  await waitFor(() => expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull());
});

test("scatter is computed on demand, without any clustering, and draws one marker per frame", async () => {
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("scatter-controls");
  await userEvent.click(within(group).getByRole("radio", { name: "tsne" }));
  await userEvent.click(within(group).getByRole("button", { name: "Compute projection" }));
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  expect(calls.find((c) => c.url.endsWith("/dedup/scatter"))!.body).toEqual({ feature: "seal", projection: "tsne", method: "resnet50" });
  expect(calls.some((c) => c.url.endsWith("/dedup/cluster"))).toBe(false);
  expect(within(svg).getByTestId("pt-a.png")).toBeInTheDocument();
  expect(within(svg).getByTestId("pt-f.png").querySelector("title")!.textContent).toContain("golden OK");
});

async function openScatter() {
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("scatter-controls");
  await userEvent.click(within(group).getByRole("button", { name: "Compute projection" }));
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 420, right: 720, bottom: 420, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return svg;
}

test("dragging a rectangle on the scatter zooms in and lists the frames inside it", async () => {
  const svg = await openScatter();
  expect(screen.queryByTestId("scatter-selection")).toBeNull();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  expect(screen.getByTestId("scatter-drag-box")).toBeInTheDocument();
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  expect(within(panel).getByText("1 frame(s) in the selected region")).toBeInTheDocument();
  expect(within(panel).getByAltText("a.png")).toBeInTheDocument();
  expect(within(panel).queryByAltText("f.png")).toBeNull();
  expect(within(panel).getByText("unlabeled: 1")).toBeInTheDocument(); // no clustering: the selection is summed up by label
  expect(svg.getAttribute("viewBox")).not.toBe("0 0 720 420");
  expect(screen.getByTestId("pt-f.png").getAttribute("opacity")).toBe("0.2");
});

test("right-click on the scatter restores the full view and clears the selection", async () => {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  await screen.findByTestId("scatter-selection");
  const notPrevented = fireEvent.contextMenu(svg);
  expect(notPrevented).toBe(false); // default context menu suppressed
  await waitFor(() => expect(screen.queryByTestId("scatter-selection")).toBeNull());
  expect(svg.getAttribute("viewBox")).toBe("0 0 720 420");
  expect(screen.getByTestId("pt-f.png").getAttribute("opacity")).toBe("1");
});

test("a plain click (tiny drag) on the scatter does not change the view", async () => {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 50, clientY: 50 });
  fireEvent.mouseUp(window, { clientX: 52, clientY: 51 });
  expect(screen.queryByTestId("scatter-selection")).toBeNull();
  expect(svg.getAttribute("viewBox")).toBe("0 0 720 420");
});

test("deleting the frames of a scatter selection asks first, with counts, and sends the note", async () => {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  await userEvent.click(await screen.findByRole("button", { name: /Delete these 1 frame/ }));
  const dlg = await screen.findByRole("alertdialog", { name: "Confirm delete" });
  expect(dlg).toHaveTextContent("1 labeled and 0 golden lose their marks");
  expect(calls.some((c) => c.url.endsWith("/classify/delete-bulk"))).toBe(false); // nothing deleted yet
  await userEvent.type(within(dlg).getByRole("textbox"), "foreign object");
  await userEvent.click(within(dlg).getByRole("button", { name: "Yes — delete 1" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/delete-bulk"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/classify/delete-preview"))!.body).toEqual({ feature: "seal", frames: ["a.png"] });
  expect(calls.find((c) => c.url.endsWith("/classify/delete-bulk"))!.body).toEqual({ feature: "seal", frames: ["a.png"], note: "foreign object", via: "Scatter" });
  expect(await screen.findByText(/Deleted 1 frame\(s\) · cleared 1 label\(s\) and 0 golden mark\(s\)/)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByTestId("pt-a.png")).toBeNull()); // gone from the map without projecting again
  expect(calls.filter((c) => c.url.endsWith("/dedup/scatter")).length).toBe(1);
});

test("a new selection drops an open delete confirmation", async () => {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  await userEvent.click(await screen.findByRole("button", { name: /Delete these 1 frame/ }));
  await screen.findByRole("alertdialog", { name: "Confirm delete" });
  fireEvent.contextMenu(svg); // reset
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  await screen.findByRole("button", { name: /Delete these 1 frame/ });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("unmute needs a second confirming click", async () => {
  state = baseState({ muted_count: 3 });
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: /Unmute all of this box/ }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Yes — unmute all" }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  expect(await screen.findByText("Unmuted 3 frame(s).")).toBeInTheDocument();
});

test("the Embedding and Feature controls and the selected tool's controls are in the options panel", async () => {
  render(<DedupView camera="camA" tool="outliers" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  await within(panel).findByLabelText("Embedding");
  expect(within(panel).getByLabelText("Dedup box")).toBeInTheDocument();
  const labels = within(panel).getAllByRole("combobox").map((s) => s.closest("label")?.textContent ?? "");
  expect(labels[0]).toMatch(/Embedding/);
  expect(labels[1]).toMatch(/Dedup box/);
  const controls = within(panel).getByTestId("outliers-controls");
  expect(within(controls).getByRole("button", { name: "Score outliers" })).toBeInTheDocument();
  expect(within(controls).getByLabelText("k neighbours")).toBeInTheDocument();
});

test("clustering lives in the panel's Clusters controls, and the sliders answer the mouse wheel", async () => {
  render(<DedupView camera="camA" tool="clusters" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  const group = await within(panel).findByTestId("clusters-controls");
  expect(within(group).getByRole("button", { name: /Cluster$/ })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: /Revert/ })).toBeDisabled();
  // Cluster keeps its words; Revert and Apply mute are icon-only and all share one line
  fireEvent.wheel(within(group).getByLabelText("Min points"), { deltaY: -100 });
  await waitFor(() => expect(calls.find((c) => c.url.includes("/dedup/settings"))?.body).toMatchObject({ min_points: 3 }));
});

test("switching tools keeps each tool's results; only the selected tool's controls and results show", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<DedupView camera="camA" tool="clusters" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  await user.click(await within(panel).findByRole("button", { name: /Cluster$/ }));
  expect(await screen.findByTestId("cluster-browser")).toBeInTheDocument();
  expect(within(panel).queryByTestId("outliers-controls")).toBeNull();

  rerender(<DedupView camera="camA" tool="outliers" />);
  expect(screen.queryByTestId("cluster-browser")).toBeNull();
  expect(within(panel).queryByTestId("clusters-controls")).toBeNull();
  await user.click(await within(panel).findByRole("button", { name: "Score outliers" }));
  await screen.findByText(/outlier 0\.420/);

  // back on Clusters the kept result is there at once; the outlier cards are not
  rerender(<DedupView camera="camA" tool="clusters" />);
  expect(await screen.findByTestId("cluster-browser")).toBeInTheDocument();
  expect(screen.queryByText(/outlier 0\.420/)).toBeNull();
  rerender(<DedupView camera="camA" tool="outliers" />);
  expect(await screen.findByText(/outlier 0\.420/)).toBeInTheDocument();
});

test("the number of frames in scope is a card at the top of the right column, and the explanatory text is gone", async () => {
  render(<DedupView camera="camA" tool="clusters" />);
  const card = (await screen.findByTestId("frames-in-scope")).closest(".stat-card") as HTMLElement;
  expect(card).toHaveTextContent("6 frames in scope");
  const column = card.parentElement as HTMLElement;
  expect(within(column).getByRole("complementary", { name: "Options" })).toBeInTheDocument();
  expect(card.compareDocumentPosition(within(column).getByRole("complementary"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.queryByText(/Neural device/)).toBeNull();
  // the explanation lives in the hover tip of the Clusters group, not on the page
  expect(screen.getByText(/DBSCAN/).closest('[role="tooltip"]')).not.toBeNull();
});

test("Scatter is its own tool: Compute projection puts the map in the centre", async () => {
  const user = userEvent.setup();
  render(<DedupView camera="camA" tool="scatter" />);
  const controls = await screen.findByTestId("scatter-controls");
  expect(screen.queryByTestId("cluster-browser")).toBeNull();
  await user.click(within(controls).getByRole("button", { name: "Compute projection" }));
  const view = await screen.findByTestId("scatter-view");
  expect(await within(view).findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  expect(screen.queryByText(/2D scatter \(sanity check\)/)).toBeNull();
});

test("colour by: labels by default with a legend, cluster falls back with a note when there is no clustering", async () => {
  const user = userEvent.setup();
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("scatter-controls");
  await user.click(within(group).getByRole("button", { name: "Compute projection" }));
  const view = await screen.findByTestId("scatter-view");
  await within(view).findByRole("img", { name: /2D scatter/ });
  expect(within(view).getByTestId("scatter-legend")).toHaveTextContent("unlabeled");
  expect(within(view).queryByRole("note")).toBeNull();
  await user.selectOptions(within(group).getByLabelText("Colour by"), "cluster");
  expect(await within(view).findByRole("note")).toHaveTextContent(/no clustering for this embedding yet/);
  await user.selectOptions(within(group).getByLabelText("Colour by"), "outlier");
  expect(await within(view).findByRole("note")).toHaveTextContent(/Outliers have not been scored/);
  await user.selectOptions(within(group).getByLabelText("Colour by"), "none");
  expect(within(view).queryByRole("note")).toBeNull();
});

test("with a clustering held, the scatter selection is summed up by cluster", async () => {
  state = baseState({ result });
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  expect(within(panel).getByText("cluster 0: 1")).toBeInTheDocument();
});

async function selectA() {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  return await screen.findByTestId("scatter-selection");
}

test("the selection uses the shared pager and cards, and clicking a picture opens the viewer", async () => {
  const panel = await selectA();
  expect(within(panel).getAllByRole("navigation", { name: /Pagination selection/ })).toHaveLength(2);
  const card = within(panel).getByTestId("card-a.png");
  expect(within(card).queryByRole("button", { name: /OK/ })).toBeNull(); // Dedup does not label: no class buttons, no golden star
  expect(within(card).queryByRole("button", { name: /golden/i })).toBeNull();
  expect(within(card).getByRole("button", { name: "Delete frame" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("link"));
  expect(screen.getByRole("dialog", { name: "Full-size picture" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the selection has no labelling buttons; deleting stays, and the map keeps the Classifier's colours", async () => {
  const panel = await selectA();
  expect(within(panel).queryByRole("group", { name: "Label the selection" })).toBeNull();
  expect(within(panel).getByRole("button", { name: /Delete these 1 frame/ })).toBeInTheDocument();
  expect(calls.some((c) => c.url.endsWith("/classify/label-bulk"))).toBe(false);
  expect(screen.getByTestId("pt-f.png").querySelector("title")!.textContent).toContain("golden OK"); // the marks come from the Classifier the box reads
});

test("picture actions of the map go through the feature the state names, not the box id", async () => {
  state = baseState({ source: "type" }); // the box reads the Classifier "type"; the Classify API knows no box
  const panel = await selectA();
  await userEvent.click(within(panel).getByRole("button", { name: "Delete frame" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/delete"))?.body).toMatchObject({ feature: "type" }));
});

test("Scatter is the default tool, and no tool shows another tool's controls", async () => {
  render(<DedupView camera="camA" />);
  await screen.findByTestId("scatter-controls");
  expect(document.querySelectorAll("[data-testid$='-controls']")).toHaveLength(1);
});

test("Cluster, Revert and Apply mute sit on one line; the last two are icon-only", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" tool="clusters" />);
  const group = await screen.findByTestId("clusters-controls");
  const cluster = await within(group).findByRole("button", { name: /Cluster$/ });
  const revert = within(group).getByRole("button", { name: "Revert" });
  const mute = await within(group).findByRole("button", { name: "Apply mute" });
  expect(cluster).toHaveTextContent("Cluster");
  expect(revert.textContent).toBe("↺");
  expect(mute.textContent).toBe("🔇");
  expect(revert.parentElement).toBe(cluster.parentElement);
  expect(mute.parentElement).toBe(cluster.parentElement);
  expect(cluster.parentElement).toHaveStyle({ flexWrap: "nowrap" });
  expect(within(group).getByTestId("mute-status")).toHaveTextContent("3 frame(s) will be muted"); // the status stays under the row
});

test("each tool explains itself in a hover tip next to its title, and the page carries no explanatory text", async () => {
  state = baseState({ result });
  const { rerender } = render(<DedupView camera="camA" tool="clusters" />);
  const clusters = await screen.findByTestId("clusters-controls");
  expect(within(clusters).getByRole("button", { name: "Info: Clusters" })).toHaveAccessibleDescription(/chosen representative of each cluster stays visible in Classify/);
  rerender(<DedupView camera="camA" tool="scatter" />);
  expect(within(await screen.findByTestId("scatter-controls")).getByRole("button", { name: "Info: Scatter" })).toHaveAccessibleDescription(/distorts distances/);
  rerender(<DedupView camera="camA" tool="outliers" />);
  expect(within(await screen.findByTestId("outliers-controls")).getByRole("button", { name: "Info: Outliers" })).toHaveAccessibleDescription(/not a verdict/);
  rerender(<DedupView camera="camA" tool="clusters" />);
  await screen.findByTestId("cluster-browser");
  expect(screen.queryByText(/will be muted on Apply mute/)).toBeNull();
});

test("the options panel picks a Dedup box and has no product picker", async () => {
  render(<DedupView camera="camA" box="seal" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  expect(within(panel).getByLabelText("Dedup box")).toBeInTheDocument();
  expect(within(panel).queryByLabelText("Product")).toBeNull();
});

test("the box page has a way back and a Grid / Scatter / Clusters / Outliers switch", async () => {
  const onBack = vi.fn();
  const onTool = vi.fn();
  render(<DedupView camera="camA" box="seal" tool="grid" onBack={onBack} onTool={onTool} />);
  await userEvent.click(await screen.findByRole("button", { name: /Back to chain/ }));
  expect(onBack).toHaveBeenCalled();
  const group = screen.getByRole("group", { name: "View" });
  expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Grid", "Scatter", "Clusters", "Outliers"]);
  await userEvent.click(within(group).getByRole("button", { name: "Clusters" }));
  expect(onTool).toHaveBeenCalledWith("clusters", "seal");
});

test("the Grid lists the box's pictures, hides muted ones until Show muted is ticked", async () => {
  render(<DedupView camera="camA" box="seal" tool="grid" />);
  const view = await screen.findByTestId("grid-view");
  await waitFor(() => expect(view).toHaveTextContent("2 pictures · 1 muted"));
  await userEvent.click(screen.getByLabelText("Show muted"));
  await waitFor(() => expect(view).toHaveTextContent("3 pictures · 1 muted"));
  expect(view).toHaveTextContent("muted");
});

test("the sweep helpers: round axes, nearest Epsilon, number of runs", () => {
  expect(niceAxis(0)).toEqual({ top: 1, ticks: [0, 1] });
  expect(niceAxis(47).ticks).toEqual([0, 20, 40, 60]);
  expect(niceAxis(9).top).toBeGreaterThanOrEqual(9);
  expect(nearestIndex([10, 20, 30], 26)).toBe(2);
  expect(sweepRuns({ eps_from: 0.005, eps_to: 0.03, eps_step: 0.001, mp_from: 2, mp_to: 4 })).toEqual({ values: 26, runs: 78 });
  expect(sweepRuns({ eps_from: 0.005, eps_to: 0.03, eps_step: 0, mp_from: 2, mp_to: 4 }).runs).toBe(0);
});

test("Calculate chart sends the range, draws the chart above the grid and clusters at the peak", async () => {
  render(<DedupView camera="camA" tool="clusters" />);
  const group = await screen.findByTestId("clusters-controls");
  expect(screen.queryByTestId("sweep-chart")).toBeNull();
  expect(within(group).getByText("up to 78 runs")).toBeInTheDocument();
  fireEvent.change(within(group).getByLabelText("Sweep Epsilon step"), { target: { value: "0.005" } });
  await userEvent.click(within(group).getByRole("button", { name: /Calculate chart/ }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/dedup/sweep") && c.method === "POST")?.body).toEqual({
    feature: "seal", method: "resnet50", eps_from: 0.005, eps_to: 0.03, eps_step: 0.005, mp_from: 2, mp_to: 4,
  }));
  await screen.findByTestId("sweep-chart");
  expect(screen.getByTestId("sweep-peak")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Clusters and frames/ })).toBeInTheDocument();
  // the peak (ε 0.02, min points 2) goes to the sliders and the grid is clustered with it
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/dedup/cluster")).at(-1)?.body).toMatchObject({ epsilon: 0.02, min_points: 2 }));
  expect(await screen.findByText(/Would mute/)).toBeInTheDocument();
  // the range is remembered for the camera
  expect(JSON.parse(localStorage.getItem("picturesorter.dedup.sweepRange.camA")!)).toMatchObject({ eps_step: 0.005 });
});

test("a held chart is shown on arrival, and a click takes the nearest Epsilon and line to the sliders and clusters there", async () => {
  heldSweep = sweepResult;
  render(<DedupView camera="camA" tool="clusters" />);
  const chart = await screen.findByTestId("sweep-chart");
  const svg = within(chart).getByRole("img");
  // jsdom has no layout: x is the chart coordinate. Epsilons sit at 46 + i * (760-92)/3; y: left axis 0..top, bottom 246, top 14
  const xs = [0.01, 0.02, 0.03, 0.04].map((_, i) => 46 + (i * (760 - 92)) / 3);
  // third Epsilon (0.03): clusters 3 (min 2), 1 (min 3); would-mute lines are on the right axis. Click at the height of "clusters, min points 3" = 1.
  const clusterAxisTop = niceAxis(5).top;
  const y = 246 - (1 / clusterAxisTop) * (246 - 14);
  fireEvent.click(svg, { clientX: xs[2] + 3, clientY: y + 1 });
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/dedup/cluster")).at(-1)?.body).toMatchObject({ epsilon: 0.03 }));
  await waitFor(() => expect(calls.find((c) => c.url.includes("/dedup/settings"))?.body).toMatchObject({ epsilon: 0.03 }));
});

test("the sweep chart can be collapsed and stays collapsed", async () => {
  heldSweep = sweepResult;
  const { unmount } = render(<DedupView camera="camA" tool="clusters" />);
  const chart = await screen.findByTestId("sweep-chart");
  expect(chart).toHaveAttribute("open");
  chart.removeAttribute("open");
  fireEvent(chart, new Event("toggle"));
  expect(localStorage.getItem("picturesorter.dedup.sweepOpen")).toBe("0");
  unmount();
  render(<DedupView camera="camA" tool="clusters" />);
  expect(await screen.findByTestId("sweep-chart")).not.toHaveAttribute("open");
});

test("the chart is not on the other tools", async () => {
  heldSweep = sweepResult;
  render(<DedupView camera="camA" tool="grid" />);
  await screen.findByTestId("grid-view");
  expect(screen.queryByTestId("sweep-chart")).toBeNull();
});

test("Show deleted lists the deleted pictures in the Grid tool and restores them", async () => {
  render(<DedupView camera="camA" tool="grid" />);
  await screen.findByTestId("grid-view");
  await userEvent.click(screen.getByLabelText("Show deleted"));
  expect(screen.queryByTestId("grid-view")).toBeNull();
  const view = await screen.findByTestId("deleted-view");
  await userEvent.click(await within(view).findByRole("button", { name: "Restore x.png" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/restore-bulk"))?.body).toMatchObject({ frames: ["x.png"] }));
  await userEvent.click(screen.getByLabelText("Show deleted"));
  expect(await screen.findByTestId("grid-view")).toBeInTheDocument();
});

test("the scatter selection has a Mute button that mutes its frames in the box", async () => {
  const svg = await openScatter();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  await userEvent.click(within(panel).getByRole("button", { name: /Mute these 1 frame/ }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/dedup/mute-frames"))?.body).toEqual({ feature: "seal", frames: ["a.png"] }));
  expect(await screen.findByText(/Muted 2 frame\(s\)/)).toBeInTheDocument();
});
