import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ClassifyScatter from "./ClassifyScatter";

const params = { method: "resnet50", epsilon: 0.02, min_points: 2 };
const dedupState = (over: Record<string, unknown> = {}) => ({
  feature: "type",
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
let cached: boolean;

beforeEach(() => {
  calls = [];
  state = dedupState();
  cached = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/dedup/state")) return ok(state);
      if (url.includes("/dedup/scatter/cached")) return ok({ cached });
      if (url.includes("/dedup/settings")) return ok({ params });
      if (url.endsWith("/dedup/scatter")) return ok({ id: "s1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/s1")
        return ok({
          id: "s1",
          status: "done",
          progress: {},
          error: null,
          result: {
            projection: "umap",
            method: "resnet50",
            from_cache: true,
            classes: ["A", "B", "C"],
            points: [
              { frame: "a.png", x: 0, y: 0, cluster: null, representative: false, golden: null, label: "A" },
              { frame: "f.png", x: 1, y: 1, cluster: null, representative: false, golden: null, label: null },
            ],
          },
        });
      if (url.endsWith("/classify/label-bulk")) return ok({ labeled: 1 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderScatter = (over: Record<string, unknown> = {}) => {
  const grid = { per_page: 48, cols: 6, per_page_options: [12, 24, 48], cols_options: [4, 6, 8] };
  const props = { grid, onGrid: vi.fn(), onChanged: vi.fn(), onNotice: vi.fn(), onError: vi.fn(), ...over };
  render(<ClassifyScatter camera="camA" feature="type" {...(props as any)} />);
  return props;
};
/** jsdom has no layout: give the map the size the chart expects, as the Dedup tests do. */
async function openMap() {
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 420, right: 720, bottom: 420, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return svg;
}
const scatterPosts = () => calls.filter((c) => c.url.endsWith("/dedup/scatter") && c.method === "POST");

test("a map that is already cached appears by itself, coloured by label, one marker per picture", async () => {
  renderScatter();
  expect(await screen.findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  expect(screen.getByTestId("pt-a.png")).toBeInTheDocument();
  expect(screen.getByTestId("pt-f.png")).toBeInTheDocument();
  expect(scatterPosts()).toHaveLength(1);
  expect(scatterPosts()[0].body).toEqual({ feature: "type", projection: "umap", method: "resnet50" });
  expect(calls.find((c) => c.url.includes("/dedup/scatter/cached"))!.url).toContain("projection=umap&method=resnet50");
});

test("a map that is not cached waits for the Compute map button", async () => {
  cached = false;
  const user = userEvent.setup();
  renderScatter();
  expect(await screen.findByText(/not computed yet/)).toBeInTheDocument();
  expect(scatterPosts()).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Compute map" }));
  expect(await screen.findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  expect(scatterPosts()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Recompute map" })).toBeInTheDocument();
});

test("dragging a rectangle selects pictures and shows the batch labels of the ROI's classes", async () => {
  renderScatter();
  const svg = await openMap();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  const group = within(panel).getByRole("group", { name: "Label the selection" });
  expect(within(group).getByRole("button", { name: "Label 1 as A" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "Label 1 as C" })).toBeInTheDocument();
});

test("labeling the selection reports the change so Classify can reload its counts", async () => {
  const user = userEvent.setup();
  const props = renderScatter();
  const svg = await openMap();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const group = await screen.findByRole("group", { name: "Label the selection" });
  await user.click(within(group).getByRole("button", { name: "Label 1 as B" }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  expect(props.onNotice).toHaveBeenCalledWith("Labeled 1 frame(s) as B.");
  const bulk = calls.find((c) => c.url.endsWith("/classify/label-bulk"))!;
  expect(bulk.body).toMatchObject({ feature: "type", frames: ["a.png"], cls: "B" });
});

test("choosing another embedding saves it", async () => {
  const user = userEvent.setup();
  renderScatter();
  await screen.findByRole("img", { name: /2D scatter/ });
  await user.selectOptions(screen.getByLabelText("Embedding"), "resnet18");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/dedup/settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/dedup/settings"))!.body).toMatchObject({ feature: "type", method: "resnet18" });
});

test("explains why there is no map when the embeddings are unavailable", async () => {
  state = dedupState({ reason: "methods_off" });
  renderScatter();
  expect(await screen.findByRole("status")).toHaveTextContent("No ResNet method is switched on");
  expect(calls.some((c) => c.url.includes("/dedup/scatter"))).toBe(false);
});

test("too few pictures for a map", async () => {
  state = dedupState({ frames: 1 });
  renderScatter();
  expect(await screen.findByText(/at least two pictures/)).toBeInTheDocument();
});

test("the selection's grid is the one passed in (Classify's), and changing it goes back to the page", async () => {
  const props = renderScatter();
  const svg = await openMap();
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  expect((await within(panel).findAllByLabelText("Per page selection top"))[0]).toHaveValue("48");
  expect((await within(panel).findAllByLabelText("Columns selection top"))[0]).toHaveValue("6");
  await userEvent.selectOptions((await within(panel).findAllByLabelText("Columns selection top"))[0], "8");
  expect(props.onGrid).toHaveBeenCalledWith(48, 8);
  expect(calls.some((c) => c.url.includes("grid-settings"))).toBe(false); // no second, separate setting
});
