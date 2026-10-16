import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DedupView, { drift } from "./DedupView";

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

let calls: { url: string; method: string; body?: any }[];
let state: any;

beforeEach(() => {
  calls = [];
  state = baseState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/versions/features")) return ok([{ feature: "seal", label: "seal" }]);
      if (url.includes("/dedup/state")) return ok(state);
      if (url.includes("/dedup/settings")) return ok({ params });
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
  render(<DedupView camera="camA" />);
  await screen.findByLabelText("Min points");
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  await waitFor(() => expect(calls.some((c) => c.url.includes("/dedup/settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/dedup/settings"))!.body).toMatchObject({ feature: "seal", method: "resnet50", min_points: 3 });
});

test("cluster job shows summary and clusters; apply sends representative overrides", async () => {
  render(<DedupView camera="camA" />);
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
  const group = screen.getByTestId("cluster-group");
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
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Unique/ }));
  expect(await screen.findByRole("button", { name: /^Unique/ })).toHaveAttribute("aria-current", "true");
  const card = screen.getByTestId("card-f.png");
  expect(within(card).queryByRole("button", { name: /representative/i })).toBeNull();
  expect(within(card).getByText(/reference/)).toBeInTheDocument(); // golden mark from the result's marks
});

test("changed sliders warn that the shown clusters are stale and can be reverted", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  await screen.findByTestId("cluster-browser");
  expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  expect(await screen.findByRole("status")).toHaveTextContent("minPts 2 → 3");
  await userEvent.click(screen.getByRole("button", { name: /Revert/ }));
  await waitFor(() => expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull());
});

test("scatter is computed on demand, without any clustering, and draws one marker per frame", async () => {
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("scatter-group");
  await userEvent.click(within(group).getByText("Scatter"));
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
  const group = await screen.findByTestId("scatter-group");
  await userEvent.click(within(group).getByText("Scatter"));
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
  expect(calls.find((c) => c.url.endsWith("/classify/delete-bulk"))!.body).toEqual({ feature: "seal", frames: ["a.png"], note: "foreign object" });
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
  await userEvent.click(await screen.findByRole("button", { name: /Unmute all for this feature/ }));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Yes — unmute all" }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  expect(await screen.findByText("Unmuted 3 frame(s).")).toBeInTheDocument();
});

test("the Embedding, Feature and Outliers controls live in the options panel, Outliers in a collapsible group", async () => {
  render(<DedupView camera="camA" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  await within(panel).findByLabelText("Embedding");
  expect(within(panel).getByLabelText("Feature (ROI)")).toBeInTheDocument();
  const labels = within(panel).getAllByRole("combobox").map((s) => s.closest("label")?.textContent ?? "");
  expect(labels[0]).toMatch(/Embedding/);
  expect(labels[1]).toMatch(/Feature/);
  const group = within(panel).getByTestId("outlier-group");
  expect(group).toHaveProperty("open", false); // Clusters is the active function at first; Outliers waits collapsed
  expect(within(group).getByRole("button", { name: "Score outliers" })).toBeInTheDocument();
  expect(within(group).getByLabelText("k neighbours")).toBeInTheDocument();
});

test("clustering lives in the panel's Clusters group, and the sliders answer the mouse wheel", async () => {
  render(<DedupView camera="camA" />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  const group = await within(panel).findByTestId("cluster-group");
  expect(within(group).getByRole("button", { name: /Cluster$/ })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: /Revert/ })).toBeDisabled();
  // Cluster keeps its words; Revert and Apply mute are icon-only and all share one line
  fireEvent.wheel(within(group).getByLabelText("Min points"), { deltaY: -100 });
  await waitFor(() => expect(calls.find((c) => c.url.includes("/dedup/settings"))?.body).toMatchObject({ min_points: 3 }));
});

test("only one function owns the centre: opening a group changes nothing, its own button switches", async () => {
  const user = userEvent.setup();
  render(<DedupView camera="camA" />);
  const clusters = await screen.findByTestId("cluster-group");
  const outliers = screen.getByTestId("outlier-group");
  expect(clusters).toHaveAttribute("data-active", "true");
  expect(clusters).toHaveProperty("open", true);
  expect(outliers).toHaveAttribute("data-active", "false");

  await user.click(within(clusters).getByRole("button", { name: /Cluster$/ }));
  expect(await screen.findByTestId("cluster-browser")).toBeInTheDocument();

  // Score outliers: Outliers becomes active and open, Clusters inactive and collapsed, the centre switches.
  await user.click(within(outliers).getByText("Outliers")); // open it to look at the settings
  expect(outliers).toHaveProperty("open", true);
  expect(clusters).toHaveAttribute("data-active", "true"); // opening does not switch
  expect(screen.getByTestId("cluster-browser")).toBeInTheDocument();
  await user.click(within(outliers).getByRole("button", { name: "Score outliers" }));
  await screen.findByText(/outlier 0\.420/);
  expect(outliers).toHaveAttribute("data-active", "true");
  expect(clusters).toHaveAttribute("data-active", "false");
  expect(clusters).toHaveProperty("open", false);
  expect(screen.queryByTestId("cluster-browser")).toBeNull();

  // Back to Clusters: pressing its button shows the kept result at once while the new run computes.
  await user.click(within(clusters).getByText("Clusters")); // open
  await user.click(within(clusters).getByRole("button", { name: /Cluster$/ }));
  expect(await screen.findByTestId("cluster-browser")).toBeInTheDocument();
  expect(outliers).toHaveAttribute("data-active", "false");
  expect(outliers).toHaveProperty("open", false);
  expect(screen.queryByText(/outlier 0\.420/)).toBeNull();
});

test("the number of frames in scope is a card at the top of the right column, and the explanatory text is gone", async () => {
  render(<DedupView camera="camA" />);
  const card = (await screen.findByTestId("frames-in-scope")).closest(".stat-card") as HTMLElement;
  expect(card).toHaveTextContent("6 frames in scope");
  const column = card.parentElement as HTMLElement;
  expect(within(column).getByRole("complementary", { name: "Options" })).toBeInTheDocument();
  expect(card.compareDocumentPosition(within(column).getByRole("complementary"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.queryByText(/Neural device/)).toBeNull();
  // the explanation lives in the hover tip of the Clusters group, not on the page
  expect(screen.getByText(/DBSCAN/).closest('[role="tooltip"]')).not.toBeNull();
});

test("Scatter is its own function: pressing Compute projection makes it active and puts the map in the centre", async () => {
  const user = userEvent.setup();
  render(<DedupView camera="camA" />);
  const clusters = await screen.findByTestId("cluster-group");
  const group = screen.getByTestId("scatter-group");
  await user.click(within(clusters).getByRole("button", { name: /Cluster$/ }));
  expect(await screen.findByTestId("cluster-browser")).toBeInTheDocument();
  await user.click(within(group).getByText("Scatter"));
  expect(screen.getByTestId("cluster-browser")).toBeInTheDocument(); // opening changes nothing
  await user.click(within(group).getByRole("button", { name: "Compute projection" }));
  const view = await screen.findByTestId("scatter-view");
  expect(await within(view).findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  expect(group).toHaveAttribute("data-active", "true");
  expect(clusters).toHaveAttribute("data-active", "false");
  expect(screen.queryByTestId("cluster-browser")).toBeNull();
  // the old section under the cluster results is gone
  expect(screen.queryByText(/2D scatter \(sanity check\)/)).toBeNull();
});

test("colour by: labels by default with a legend, cluster falls back with a note when there is no clustering", async () => {
  const user = userEvent.setup();
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("scatter-group");
  await user.click(within(group).getByText("Scatter"));
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
  expect(within(card).getByRole("button", { name: /OK/ })).toBeInTheDocument(); // the usual card buttons
  expect(within(card).getByRole("button", { name: "Delete frame" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("link"));
  expect(screen.getByRole("dialog", { name: "Full-size picture" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the batch buttons sit between the map and the grid, grouped, and labelling shows on the map without projecting again", async () => {
  const panel = await selectA();
  const group = within(panel).getByRole("group", { name: "Label the selection" });
  const ok = within(group).getByRole("button", { name: "Label 1 as OK" });
  expect(ok).toHaveStyle({ background: "#1a7f37" }); // the class colour, as on the cards
  const buttons: HTMLElement[] = Array.from(panel.querySelectorAll("button"));
  expect(buttons.indexOf(ok)).toBeLessThan(buttons.indexOf(within(panel).getByRole("button", { name: "Delete frame" }))); // before the grid
  await userEvent.click(ok);
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/label-bulk"))?.body).toMatchObject({ frames: ["a.png"], cls: "OK" }));
  expect(await within(panel).findByText("OK: 1")).toBeInTheDocument();
  expect(within(screen.getByTestId("card-a.png")).getByRole("button", { name: /OK/ })).toHaveAttribute("aria-pressed", "true");
  expect(calls.filter((c) => c.url.endsWith("/dedup/scatter")).length).toBe(1);
});

test("labelling one card of the selection is reflected in the map's colours", async () => {
  const panel = await selectA();
  await userEvent.click(within(within(panel).getByTestId("card-a.png")).getByRole("button", { name: /NG/ }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/label"))?.body).toMatchObject({ frame: "a.png", cls: "NG" }));
  const circle = screen.getByTestId("pt-a.png").querySelector("circle")!;
  await waitFor(() => expect(circle.getAttribute("fill")).toBe("#c62828")); // NG red, coloured by label
});

test("the groups are ordered Clusters, Scatter, Outliers", async () => {
  render(<DedupView camera="camA" />);
  await screen.findByTestId("scatter-group");
  const ids = Array.from(document.querySelectorAll("[data-testid$='-group']")).map((e) => e.getAttribute("data-testid"));
  expect(ids).toEqual(["cluster-group", "scatter-group", "outlier-group"]);
});

test("Cluster, Revert and Apply mute sit on one line; the last two are icon-only", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  const group = await screen.findByTestId("cluster-group");
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

test("each function explains itself in a hover tip next to its title, and the page carries no explanatory text", async () => {
  const user = userEvent.setup();
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  const clusters = await screen.findByTestId("cluster-group");
  const tip = within(clusters).getByRole("button", { name: "Info: Clusters" });
  expect(tip).toHaveAccessibleDescription(/chosen representative of each cluster stays visible in Classify/);
  // clicking the icon does not fold the group
  await user.click(tip);
  expect(clusters).toHaveProperty("open", true);
  expect(within(screen.getByTestId("scatter-group")).getByRole("button", { name: "Info: Scatter" })).toHaveAccessibleDescription(/distorts distances/);
  expect(within(screen.getByTestId("outlier-group")).getByRole("button", { name: "Info: Outliers" })).toHaveAccessibleDescription(/not a verdict/);
  // none of it is left in the page body
  await screen.findByTestId("cluster-browser");
  expect(screen.queryByRole("heading", { name: "Clusters" })).toBeNull();
  expect(screen.queryByText(/will be muted on Apply mute/)).toBeNull();
});

test("the product picker sits in the options panel directly above Feature (ROI) and reports the choice", async () => {
  const onProduct = vi.fn();
  render(<DedupView camera="camA" product="P1" products={["P1", "P2"]} onProduct={onProduct} />);
  const panel = await screen.findByRole("complementary", { name: "Options" });
  const product = within(panel).getByLabelText("Product");
  expect(product).toHaveValue("P1");
  const labels = within(panel).getAllByRole("combobox").map((s) => s.closest("label")?.textContent ?? "");
  const at = labels.findIndex((t) => /^Product/.test(t));
  expect(labels[at + 1]).toMatch(/^Feature/);
  await userEvent.selectOptions(product, "P2");
  expect(onProduct).toHaveBeenCalledWith("P2");
});

test("without products there is no product picker, and a page that can only show a message still has it", async () => {
  const { unmount } = render(<DedupView camera="camA" />);
  await screen.findByRole("complementary", { name: "Options" });
  expect(screen.queryByLabelText("Product")).toBeNull();
  unmount();
  state = baseState({ reason: "methods_off" });
  render(<DedupView camera="camA" products={["P1"]} onProduct={() => undefined} />);
  expect(await screen.findByText(/No ResNet method is switched on/)).toBeInTheDocument();
  expect(within(screen.getByRole("complementary", { name: "Options" })).getByLabelText("Product")).toBeInTheDocument();
});
