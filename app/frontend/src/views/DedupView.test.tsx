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
              { frame: "a.png", x: 0, y: 0, cluster: 0, representative: true, golden: null },
              { frame: "f.png", x: 1, y: 1, cluster: -1, representative: false, golden: "OK" },
            ],
          },
        });
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

test("moving a slider persists the setting", async () => {
  render(<DedupView camera="camA" />);
  await screen.findByLabelText("Min points");
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  await waitFor(() => expect(calls.some((c) => c.url.includes("/dedup/settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/dedup/settings"))!.body).toMatchObject({ feature: "seal", method: "resnet50", min_points: 3 });
});

test("cluster job shows summary and clusters; apply sends representative overrides", async () => {
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: /Cluster/ }));
  expect(calls.find((c) => c.url.endsWith("/dedup/cluster"))!.body).toEqual({ feature: "seal", ...params });
  expect(await screen.findByText("Cluster 0 — 3 frame(s) · rep: a.png")).toBeInTheDocument();
  expect(screen.getByText("Would mute").nextSibling).toHaveTextContent("3");
  const nav = screen.getByRole("navigation", { name: "Clusters" });
  expect(within(nav).getByRole("button", { name: /Cluster 0/ })).toHaveTextContent("3");
  expect(within(nav).getByRole("button", { name: /Unique/ })).toHaveTextContent("1");

  // pick another representative for cluster 0 from its card
  await userEvent.click(within(screen.getByTestId("card-c.png")).getByRole("button", { name: "Make representative" }));
  expect(await screen.findByText("Cluster 0 — 3 frame(s) · rep: c.png")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Apply — mute 3 frame/ }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/dedup/apply"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/dedup/apply"))!.body).toEqual({ feature: "seal", picks: { 0: "c.png" } });
  expect(await screen.findByText(/Muted 3 frame\(s\) · skipped: 1 labeled\./)).toBeInTheDocument();
  expect(screen.queryByText(/Cluster 0 —/)).toBeNull(); // result consumed
});

test("the unique frames get their own entry in the list and are never offered as representatives", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Unique/ }));
  expect(await screen.findByText("Unique — 1 frame(s) · never muted")).toBeInTheDocument();
  const card = screen.getByTestId("card-f.png");
  expect(within(card).queryByRole("button", { name: /representative/i })).toBeNull();
  expect(within(card).getByText(/reference/)).toBeInTheDocument(); // golden mark from the result's marks
});

test("changed sliders warn that the shown clusters are stale and can be reverted", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  await screen.findByText("Cluster 0 — 3 frame(s) · rep: a.png");
  expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Min points"), { target: { value: "3" } });
  expect(await screen.findByRole("status")).toHaveTextContent("minPts 2 → 3");
  await userEvent.click(screen.getByRole("button", { name: /Revert sliders/ }));
  await waitFor(() => expect(screen.queryByText(/Sliders changed since the last cluster/)).toBeNull());
});

test("scatter is computed on demand and draws one marker per frame", async () => {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByText(/2D scatter/));
  await userEvent.click(screen.getByRole("radio", { name: "tsne" }));
  await userEvent.click(screen.getByRole("button", { name: "Compute projection" }));
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  expect(calls.find((c) => c.url.endsWith("/dedup/scatter"))!.body).toEqual({ feature: "seal", projection: "tsne" });
  expect(within(svg).getByTestId("pt-a.png")).toBeInTheDocument();
  expect(within(svg).getByTestId("pt-f.png").querySelector("title")!.textContent).toContain("golden OK");
});

async function openScatter() {
  state = baseState({ result });
  render(<DedupView camera="camA" />);
  await userEvent.click(await screen.findByText(/2D scatter/));
  await userEvent.click(screen.getByRole("button", { name: "Compute projection" }));
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
  expect(within(panel).getByText("cluster 0: 1")).toBeInTheDocument();
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
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/dedup/scatter")).length).toBe(2)); // projection refreshed
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
