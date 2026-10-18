import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ClassifyOutliers from "./ClassifyOutliers";

const params = { method: "resnet50", epsilon: 0.02, min_points: 2 };
const dedupState = (over: Record<string, unknown> = {}) => ({
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
  grid: { per_page: 24, cols: 4, per_page_options: [12, 24], cols_options: [3, 4] },
  result: null,
  ...over,
});
const result = {
  method: "resnet50",
  k: 5,
  scores: [
    { frame: "far.png", score: 0.42 },
    { frame: "mid.png", score: 0.1 },
  ],
  summary: { min: 0.1, median: 0.26, p95: 0.4, max: 0.42 },
  marks: {},
  classes: ["OK", "NG"],
};
const grid = { per_page: 12, cols: 4, per_page_options: [12, 24], cols_options: [3, 4] };

let calls: { url: string; method: string; body?: any }[];
let state: any;

beforeEach(() => {
  calls = [];
  state = dedupState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/dedup/state")) return ok(state);
      if (url.includes("/dedup/settings")) return ok({ params });
      if (url.endsWith("/dedup/outliers")) return ok({ id: "o1", status: "queued", progress: {}, result: null, error: null });
      if (url === "/api/jobs/o1") return ok({ id: "o1", status: "done", progress: {}, result, error: null });
      if (url.endsWith("/classify/label")) return ok({ card: { frame: body.frame, label: body.cls, golden: null, deleted: false }, counts: {} });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: true }, counts: {} });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = () => {
  const props = { grid, onGrid: vi.fn(), onChanged: vi.fn(), onNotice: vi.fn(), onError: vi.fn() };
  render(<ClassifyOutliers camera="camA" feature="seal" {...props} />);
  return props;
};

test("scoring posts the ROI, embedding and k, then lists the most isolated picture first", async () => {
  const user = userEvent.setup();
  renderIt();
  await user.click(await screen.findByRole("button", { name: "Score outliers" }));
  await screen.findByText("outlier 0.420");
  expect(calls.find((c) => c.url.endsWith("/dedup/outliers"))!.body).toEqual({ feature: "seal", method: "resnet50", k: 5 });
  expect(screen.getAllByText(/^outlier \d/).map((e) => e.textContent)).toEqual(["outlier 0.420", "outlier 0.100"]);
});

test("nothing is scored until you ask, and the page says what the score means", async () => {
  renderIt();
  expect(await screen.findByText(/Press/)).toBeInTheDocument();
  expect(calls.some((c) => c.url.endsWith("/dedup/outliers"))).toBe(false);
});

test("labeling a card reports the change so Classify can reload its counts", async () => {
  const user = userEvent.setup();
  const props = renderIt();
  await user.click(await screen.findByRole("button", { name: "Score outliers" }));
  const card = await screen.findByTestId("card-far.png");
  await user.click(within(card).getByRole("button", { name: /NG/ }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  expect(calls.find((c) => c.url.endsWith("/classify/label"))!.body).toMatchObject({ frame: "far.png", cls: "NG", via: "Outliers" });
});

test("deleting a card reports it and the change", async () => {
  const user = userEvent.setup();
  const props = renderIt();
  await user.click(await screen.findByRole("button", { name: "Score outliers" }));
  const card = await screen.findByTestId("card-far.png");
  await user.click(within(card).getByRole("button", { name: /delete/i }));
  await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("Deleted far.png")));
  expect(props.onChanged).toHaveBeenCalled();
});

test("choosing another embedding saves it", async () => {
  const user = userEvent.setup();
  renderIt();
  await user.selectOptions(await screen.findByLabelText("Embedding"), "resnet18");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/dedup/settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/dedup/settings"))!.body).toMatchObject({ feature: "seal", method: "resnet18" });
});

test("explains why there is nothing to score when the embeddings are unavailable", async () => {
  state = dedupState({ reason: "methods_off" });
  renderIt();
  expect(await screen.findByRole("status")).toHaveTextContent("No ResNet method is switched on");
  expect(screen.queryByRole("button", { name: "Score outliers" })).toBeNull();
});
