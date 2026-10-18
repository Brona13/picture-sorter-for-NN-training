import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ClassifyView from "./ClassifyView";

const baseState = (over: Record<string, unknown> = {}) => ({
  feature: "seal",
  classes: ["OK", "NG"],
  counts: { OK: 1, golden_OK: 1, NG: 0, golden_NG: 0, unlabeled: 2, total: 3 },
  methods: ["cpu", "resnet50"],
  default_rank: "resnet50",
  device: "cpu",
  device_label: "cpu",
  views: ["All", "Unlabeled", "Labeled OK", "Labeled NG", "Golden", "Methods disagree", "Deleted"],
  orders: ["Most novel first", "Most uncertain first", "Name"],
  has_results: true,
  scored: true,
  cold_start: false,
  stale: { goldens: false, frames: false },
  muted_count: 0,
  shared_products: null,
  frames_seen: 3,
  inbox_total: 3,
  settings: { per_page: 24, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] },
  ...over,
});

const bars = {
  rows: [
    { cls: "OK", dist: 0.1, rel: 1, leader: true },
    { cls: "NG", dist: 0.2, rel: 0.5, leader: false },
  ],
  novelty: 0.1,
  margin: 0.1,
  close_call: true,
};

const card = (frame: string, over: Record<string, unknown> = {}) => ({
  frame,
  label: null,
  golden: null,
  deleted: false,
  leanings: { cpu: "OK", resnet50: "NG" },
  bars,
  cluster: null,
  ...over,
});

const gridBody = (items: unknown[], over: Record<string, unknown> = {}) => ({
  has_results: true,
  scored: true,
  rank: "resnet50",
  page: 1,
  per_page: 24,
  n_pages: 1,
  total: items.length,
  items,
  ...over,
});

type Call = { url: string; method: string; body?: any };
let calls: Call[];
let state: any;
let grid: any;

function install() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/versions/features")) return ok([{ feature: "seal", label: "seal" }]);
      if (url.includes("/classify/state")) return ok(state);
      if (url.includes("/classify/grid-settings")) return ok({ per_page: 48, cols: 4 });
      if (url.includes("/classify/grid")) return ok(grid(url));
      if (url.endsWith("/classify/refresh")) return ok({ id: "job1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/job1")
        return ok({ id: "job1", status: "done", progress: {}, result: { frames: 3, scored: true }, error: null });
      if (url.endsWith("/classify/similar")) return ok({ id: "sim1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/sim1")
        return ok({
          id: "sim1",
          status: "done",
          progress: {},
          result: { seed: { frame: "b.png", label: "OK" }, method: "resnet50", neighbors: [{ frame: "a.png", distance: 0.02 }], classes: ["OK", "NG"] },
          error: null,
        });
      if (url.endsWith("/classify/label-frames"))
        return ok({ labeled: 1, skipped: [], counts: { OK: 2, golden_OK: 1, NG: 0, golden_NG: 0, unlabeled: 1, total: 3 } });
      if (url.includes("/classify/label") || url.includes("/classify/golden")) {
        const b = JSON.parse(init!.body as string);
        const lab = url.includes("/label") ? b.cls : "OK";
        return ok({
          card: { frame: b.frame, label: lab, golden: url.includes("/golden") && b.golden ? "OK" : null, deleted: false },
          counts: { OK: 2, golden_OK: 1, NG: 0, golden_NG: 0, unlabeled: 1, total: 3 },
        });
      }
      if (url.includes("/classify/deleted"))
        return ok({ items: [{ frame: "x.png", deleted_at: new Date(2026, 9, 14, 10, 0).getTime() / 1000, note: "foreign object" }] });
      if (url.includes("/classify/delete"))
        return ok({ card: { frame: "a.png", label: null, golden: null, deleted: true }, counts: { OK: 0, golden_OK: 0, NG: 0, golden_NG: 0, unlabeled: 2, total: 3 } });
      if (url.includes("/classify/clear") && method === "GET") return ok({ matching: 6, labeled: 3, goldens: 2 });
      if (url.includes("/classify/clear")) return ok({ cleared: 3, goldens_spared: 2, counts: { OK: 1, unlabeled: 5 } });
      if (url.includes("/classify/bulk") && method === "GET") return ok({ selectable: 5, selected: 3, lo: 0.1, hi: 0.9, threshold: 0.1 });
      if (url.includes("/classify/bulk")) return ok({ labeled: 3, counts: { OK: 4 } });
      if (url.includes("/classify/auto") && method === "GET")
        return ok({ candidates: 4, total: 4, per_class: [{ cls: "OK", count: 3, avg_margin: 0.2 }, { cls: "NG", count: 1, avg_margin: 0.3 }], lo: 0.1, hi: 0.5, min_margin: 0.1 });
      if (url.includes("/classify/auto")) return ok({ labeled: 4, counts: { OK: 4 } });
      if (url.includes("/dedup/state"))
        return ok({
          feature: "seal", reason: null, backbones: ["resnet50"], params: { method: "resnet50", epsilon: 0.02, min_points: 2 },
          ranges: { epsilon: [0.001, 0.2], min_points: [2, 10] }, frames: 3, device: "cpu", device_label: "cpu", muted_count: 0,
          projections: ["umap"], result: null,
          grid: { per_page: 24, cols: 4, per_page_options: [12, 24], cols_options: [3, 4] },
        });
      if (url.includes("/dedup/scatter/cached")) return ok({ cached: true });
      if (url.endsWith("/dedup/scatter")) return ok({ id: "s1", status: "queued", progress: {} }, 202);
      if (url === "/api/jobs/s1")
        return ok({
          id: "s1", status: "done", progress: {}, error: null,
          result: {
            projection: "umap", method: "resnet50", from_cache: true, classes: ["OK", "NG"],
            points: [
              { frame: "a.png", x: 0, y: 0, cluster: null, representative: false, golden: null, label: null },
              { frame: "b.png", x: 1, y: 1, cluster: null, representative: false, golden: null, label: "OK" },
            ],
          },
        });
      if (url.endsWith("/classify/label-bulk")) return ok({ labeled: 1 });
      if (url.endsWith("/classify/mute")) return ok({ frame: "x", muted: true, muted_count: 1 });
      if (url.endsWith("/dedup/outliers")) return ok({ id: "o1", status: "queued", progress: {}, result: null, error: null });
      if (url === "/api/jobs/o1")
        return ok({
          id: "o1", status: "done", progress: {}, error: null,
          result: { method: "resnet50", k: 5, scores: [{ frame: "a.png", score: 0.3 }], summary: { min: 0.3, median: 0.3, p95: 0.3, max: 0.3 }, marks: {}, classes: ["OK", "NG"] },
        });
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  calls = [];
  state = baseState();
  grid = () => gridBody([card("a.png"), card("b.png", { label: "OK", golden: "OK", bars: null })]);
  install();
});
afterEach(() => vi.unstubAllGlobals());

const cardEl = (frame: string) => screen.findByTestId(`card-${frame}`);

test("clicking a card's picture opens the shared viewer on this page's frames: keys label, arrows browse, the file name sits under the picture", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.click(within(a).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("a.png");
  expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("1 / 2");
  fireEvent.keyDown(window, { key: "1" });
  await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url.includes("/classify/label"))?.body).toEqual({ feature: "seal", frame: "a.png", cls: "OK" }));
  expect(calls.filter((c) => c.url.includes("/classify/label")).length).toBe(1); // the card under the overlay did not act as well
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await waitFor(() => expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("b.png"));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Full-size picture" })).toBeNull();
});

test("a deleted frame in the viewer cannot be labeled and can be restored", async () => {
  grid = () => gridBody([card("a.png", { deleted: true })]);
  state = baseState({ views: ["All", "Deleted"] });
  render(<ClassifyView camera="camA" />);
  await userEvent.click(within(await cardEl("a.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByRole("button", { name: /OK/ })).toBeDisabled();
  expect(within(viewer).queryByRole("button", { name: "Delete frame" })).toBeNull();
  await userEvent.click(within(viewer).getByRole("button", { name: "Restore frame" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/classify/restore"))).toBe(true));
});

test("renders metrics, cards with leaning badges, bars and the golden reference tag", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  // the method tag sits inside the flag; the class is told by the colour and the tooltip, not by text
  expect(within(a).getByTestId("flag-cpu")).toHaveTextContent("CPU");
  expect(within(a).getByTestId("flag-cpu")).toHaveAttribute("title", "CPU leans OK");
  expect(within(a).getByTestId("flag-resnet50")).toHaveTextContent("R50");
  expect(within(a).getByTestId("flag-resnet50")).toHaveAttribute("title", "R50 leans NG");
  expect(within(a).getByText(/close call/)).toBeInTheDocument();
  expect(within(a).getByTestId("bar-NG")).toHaveStyle({ width: "50%" });
  const b = await cardEl("b.png");
  expect(within(b).getByText(/reference — not scored/)).toBeInTheDocument();
  expect(within(b).queryByTestId("bar-OK")).toBeNull();
  expect(screen.getByText("Frames").nextSibling).toHaveTextContent("3");
  // first grid request uses the saved rank default and feature
  const req = calls.find((c) => c.url.includes("/classify/grid?"))!;
  expect(req.url).toContain("feature=seal");
  expect(req.url).toContain("rank=resnet50");
});

test("class buttons toggle: set, then clear when clicking the active class; star needs a label", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByRole("button", { name: "Make golden" })).toBeDisabled();
  await userEvent.click(within(a).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.includes("/label"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/label"))!.body).toEqual({ feature: "seal", frame: "a.png", cls: "OK" });
  await waitFor(() => expect(within(a).getByRole("button", { name: "OK" })).toHaveAttribute("aria-pressed", "true"));
  expect(within(a).getByRole("button", { name: "Make golden" })).toBeEnabled();

  await userEvent.click(within(a).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/label")).length).toBe(2));
  expect(calls.filter((c) => c.url.includes("/label"))[1].body.cls).toBeNull();
});

test("star sends golden=true and counts update from the response", async () => {
  grid = () => gridBody([card("a.png", { label: "OK" })]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.click(within(a).getByRole("button", { name: "Make golden" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/golden"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/golden"))!.body).toEqual({ feature: "seal", frame: "a.png", golden: true });
  await waitFor(() => expect(within(a).getByRole("button", { name: "Remove golden" })).toBeInTheDocument());
  expect(screen.getByText("Frames").nextSibling).toHaveTextContent("3");
});

test("delete reloads the grid so the frame leaves the view", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  const before = calls.filter((c) => c.url.includes("/classify/grid?")).length;
  grid = () => gridBody([card("b.png", { label: "OK", golden: "OK", bars: null })]);
  await userEvent.click(within(a).getByRole("button", { name: "Delete frame" }));
  await waitFor(() => expect(screen.queryByTestId("card-a.png")).toBeNull());
  expect(calls.filter((c) => c.url.includes("/classify/grid?")).length).toBeGreaterThan(before);
});

test("cold start hint, no-results hint, and stale warnings", async () => {
  state = baseState({ cold_start: true, has_results: false, scored: false });
  render(<ClassifyView camera="camA" />);
  expect(await screen.findByText(/Start here:/)).toBeInTheDocument();
  expect(screen.getByText(/Click Refresh scores to evaluate the inbox/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /Show/ })).toBeNull();
});

test("stale goldens warning wins over stale frames", async () => {
  state = baseState({ stale: { goldens: true, frames: true } });
  render(<ClassifyView camera="camA" />);
  expect(await screen.findByText(/Goldens changed since the last refresh/)).toBeInTheDocument();
  expect(screen.queryByText(/frame set changed/)).toBeNull();
});

test("refresh starts a job, then reloads state and grid", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const stateCalls = calls.filter((c) => c.url.includes("/classify/state")).length;
  await userEvent.click(screen.getByRole("button", { name: /Refresh scores/ }));
  expect(await screen.findByText(/Scores refreshed — 3 frames/)).toBeInTheDocument();
  expect(calls.find((c) => c.url.endsWith("/classify/refresh"))!.body).toEqual({ feature: "seal" });
  expect(calls.filter((c) => c.url.includes("/classify/state")).length).toBeGreaterThan(stateCalls);
});

test("changing Show filters the request and returns to page 1; pager buttons request other pages", async () => {
  grid = (url: string) => {
    const page = Number(new URL(url, "http://x").searchParams.get("page"));
    return gridBody([card("a.png")], { page, n_pages: 3, total: 60, per_page: 24 });
  };
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(within(screen.getByRole("navigation", { name: "Pagination top" })).getByRole("button", { name: "Next ›" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("page=2"))).toBe(true));
  await userEvent.selectOptions(screen.getByLabelText("Show"), "Unlabeled");
  await waitFor(() => expect(calls.some((c) => c.url.includes("view=Unlabeled") && c.url.includes("page=1"))).toBe(true));
});

test("per-page change is persisted through grid-settings", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.selectOptions(screen.getByLabelText("Per page top"), "48");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/grid-settings"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/grid-settings"))!.body).toEqual({ feature: "seal", per_page: 48, cols: 4 });
});

test("bulk panel previews the selection and labels it on click", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const summary = await screen.findByText(/Bulk-label a selection \(5 matching\)/);
  await userEvent.click(summary);
  expect(await screen.findByText(/of 5 matching frames selected/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Label selection NG" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/bulk") && c.method === "POST")).toBe(true));
  const post = calls.find((c) => c.url.endsWith("/classify/bulk") && c.method === "POST")!;
  expect(post.body.label_as).toBe("NG");
  expect(post.body.mode).toBe("leaning");
  expect(await screen.findByText("Labeled 3 frames as NG.")).toBeInTheDocument();
});

test("clear panel needs a confirmation and spares goldens by default", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(await screen.findByText(/Clear labels in this view \(5 labeled\)/));
  expect(screen.getByText(/The 2 goldens in this view will be kept/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Clear 3 labels/ }));
  // nothing is sent until the confirmation is accepted
  expect(calls.some((c) => c.url.endsWith("/classify/clear") && c.method === "POST")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Yes, clear" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/clear") && c.method === "POST")).toBe(true));
  const post = calls.find((c) => c.url.endsWith("/classify/clear") && c.method === "POST")!;
  expect(post.body.include_goldens).toBe(false);
  expect(post.body.query.feature).toBe("seal");
  expect(await screen.findByText("Cleared 3 labels. 2 goldens kept.")).toBeInTheDocument();
});

test("clear panel can include goldens, and cancel sends nothing", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(await screen.findByText(/Clear labels in this view/));
  await userEvent.click(screen.getByLabelText(/Also clear the 2 goldens in this view/));
  await userEvent.click(screen.getByRole("button", { name: /Clear 5 labels/ }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(calls.some((c) => c.url.endsWith("/classify/clear") && c.method === "POST")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: /Clear 5 labels/ }));
  await userEvent.click(screen.getByRole("button", { name: "Yes, clear" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/clear") && c.method === "POST")).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/classify/clear") && c.method === "POST")!.body.include_goldens).toBe(true);
});

test("auto-assign shows per-class preview, can filter the grid, and confirms", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(await screen.findByText(/Auto-assign by leaning \(4 unlabelled candidates\)/));
  expect(await screen.findByText(/Preview — 4 frame\(s\) will be labelled/)).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText(/Show these 4 in the grid below/));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/classify/grid?") && c.url.includes("auto_preview=true"))).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: /Confirm auto-assignment of 4 frame/ }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/auto") && c.method === "POST")).toBe(true));
  expect(await screen.findByText(/Auto-labelled 4 frame\(s\) using resnet50/)).toBeInTheDocument();
});

test("suggested goldens: lazy-loaded when opened; promote sends label+golden request", async () => {
  const origFetch = globalThis.fetch as any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/classify/suggest")) {
        calls.push({ url, method: "GET" });
        return new Response(
          JSON.stringify({
            available: true,
            backbone: null,
            n_min: 3,
            n_max: 20,
            default_n: 10,
            picks: [{ frame: "s1.png", bars: { rows: [{ cls: "OK", dist: 1, rel: 1, leader: true }, { cls: "NG", dist: 1.1, rel: 0.9, leader: false }], novelty: 1, margin: 0.1, close_call: true } }],
          }),
        );
      }
      if (url.includes("/classify/promote")) {
        calls.push({ url, method: "POST", body: JSON.parse(init!.body as string) });
        return new Response(JSON.stringify({ card: { frame: "s1.png", label: "NG", golden: "NG", deleted: false }, counts: { OK: 1, NG: 1, total: 3 } }));
      }
      return origFetch(url, init);
    }),
  );
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(calls.some((c) => c.url.includes("/classify/suggest"))).toBe(false); // nothing fetched until opened
  await userEvent.click(screen.getByText(/Suggested goldens/));
  const item = await screen.findByTestId("suggest-s1.png");
  expect(within(item).getByText(/close call/)).toBeInTheDocument();
  await userEvent.click(within(item).getByRole("button", { name: "⭐ NG" }));
  await waitFor(() => expect(calls.some((c) => c.url.includes("/classify/promote"))).toBe(true));
  expect(calls.find((c) => c.url.includes("/classify/promote"))!.body).toEqual({ feature: "seal", frame: "s1.png", cls: "NG" });
  expect(await screen.findByText(/Promoted s1.png → ⭐ NG/)).toBeInTheDocument();
});


const labelCalls = () => calls.filter((c) => c.url.includes("/classify/label"));

test("number keys label the hovered card: 1 = first class, 2 = second, 0 clears", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.hover(a);
  await userEvent.keyboard("2");
  await waitFor(() => expect(labelCalls().length).toBe(1));
  expect(labelCalls()[0].body).toEqual({ feature: "seal", frame: "a.png", cls: "NG" });
  await waitFor(() => expect(within(a).getByRole("button", { name: "NG" })).toBeEnabled());
  await userEvent.keyboard("0");
  await waitFor(() => expect(labelCalls().length).toBe(2));
  expect(labelCalls()[1].body.cls).toBeNull();
});

test("number keys do nothing without hover, for unknown classes, with modifiers, or while typing", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.keyboard("1"); // nothing hovered
  await userEvent.hover(a);
  await userEvent.keyboard("7"); // only two classes
  await userEvent.keyboard("{Control>}1{/Control}");
  const select = screen.getAllByRole("combobox")[0];
  select.focus();
  fireEvent.keyDown(select, { key: "1" }); // typing in a control
  await userEvent.unhover(a);
  await userEvent.keyboard("1");
  expect(labelCalls()).toHaveLength(0);
});

test("pressing the active class's number again removes the label", async () => {
  grid = () => gridBody([card("a.png", { label: "OK" })]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.hover(a);
  await userEvent.keyboard("1");
  await waitFor(() => expect(labelCalls()).toHaveLength(1));
  expect(labelCalls()[0].body.cls).toBeNull();
});

const goldenCalls = () => calls.filter((c) => c.url.includes("/classify/golden"));

test("the key left of 1 toggles golden on a labeled card and is ignored without a label", async () => {
  grid = () => gridBody([card("a.png"), card("b.png", { label: "OK" })]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  const b = await cardEl("b.png");
  await userEvent.hover(a);
  await userEvent.keyboard("{`}"); // unlabeled: no golden
  expect(goldenCalls()).toHaveLength(0);
  await userEvent.unhover(a);
  await userEvent.hover(b);
  fireEvent.keyDown(window, { key: ";", code: "Backquote" }); // Czech layout prints ';' for this key
  await waitFor(() => expect(goldenCalls()).toHaveLength(1));
  expect(goldenCalls()[0].body).toEqual({ feature: "seal", frame: "b.png", golden: true });
});

test("class buttons show their shortcut number in their hint, and no shortcut text sits above the grid", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByRole("button", { name: "NG" })).toHaveAttribute("title", expect.stringContaining("press 2"));
  expect(within(a).getByRole("button", { name: "NG" })).toHaveAttribute("title", expect.stringContaining("paint"));
  expect(screen.queryByText(/Hover a card and press/)).toBeNull();
});

test("the Deleted view lists deleted frames per day instead of the card grid", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.selectOptions(screen.getByLabelText("Show"), "Deleted");
  const day = await screen.findByRole("region", { name: "Deleted on 2026-10-14" });
  expect(within(day).getByAltText("x.png")).toBeInTheDocument();
  expect(within(day).getByDisplayValue("foreign object")).toBeInTheDocument();
  expect(screen.queryByTestId("card-a.png")).toBeNull();
});

test("the Delete key deletes the hovered card and does nothing otherwise", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.keyboard("{Delete}"); // nothing hovered
  expect(calls.some((c) => c.url.includes("/classify/delete"))).toBe(false);
  await userEvent.hover(a);
  await userEvent.keyboard("{Delete}");
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/delete"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/classify/delete"))!.body).toEqual({ feature: "seal", frame: "a.png" });
});

test("Find similar needs a labeled frame; ticked matches get the seed's label and the grid reloads", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByRole("button", { name: "Find similar" })).toBeDisabled();
  const b = await cardEl("b.png");
  await userEvent.click(within(b).getByRole("button", { name: "Find similar" }));
  const panel = await screen.findByTestId("similar-panel");
  await userEvent.click(within(panel).getByRole("button", { name: "Find similar" }));
  expect(calls.find((c) => c.url.endsWith("/classify/similar"))!.body).toEqual({ feature: "seal", frame: "b.png", method: "resnet50", limit: 60 });
  await userEvent.click(await within(panel).findByLabelText("Tick a.png"));
  const before = calls.filter((c) => c.url.includes("/classify/grid?")).length;
  await userEvent.click(within(panel).getByRole("button", { name: /Label 1 ticked as OK/ }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/label-frames"))!.body).toEqual({ feature: "seal", frames: ["a.png"], cls: "OK" }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/classify/grid?")).length).toBeGreaterThan(before));
  expect(await screen.findByText("Labeled 1 frame as OK.")).toBeInTheDocument();
});

test("cards show the edge-angle badge with the verdict when the rule has results", async () => {
  state = baseState({ views: [...baseState().views.slice(0, -1), "Edge angle: pass", "Edge angle: fail", "Edge angle: undetermined", "Deleted"] });
  grid = () =>
    gridBody([
      card("a.png", { edge: { verdict: "pass", status: "ok", angle: 90.3, polarity: "+" } }),
      card("b.png", { edge: { verdict: "undetermined", status: "none", angle: null, polarity: null } }),
      card("c.png"),
    ]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByTestId("edge-badge")).toHaveTextContent("∠ 90.3° + · pass");
  expect(within(await cardEl("b.png")).getByTestId("edge-badge")).toHaveTextContent("no edge · undetermined");
  expect(within(await cardEl("c.png")).queryByTestId("edge-badge")).toBeNull();
  expect(screen.getByRole("option", { name: "Edge angle: fail" })).toBeInTheDocument();
});

test("a method without a leaning shows a grey tag chip", async () => {
  grid = () => gridBody([card("a.png", { leanings: { resnet50: "NG" } })]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByTestId("flag-cpu")).toHaveAttribute("title", "CPU: no leaning yet");
  expect(within(a).getByTestId("flag-cpu")).toHaveTextContent("CPU");
});

test("only the active methods get a flag", async () => {
  state = baseState({ methods: ["resnet50"] });
  grid = () => gridBody([card("a.png", { leanings: { resnet50: "NG" } })]);
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByTestId("flag-resnet50")).toBeInTheDocument();
  expect(within(a).queryByTestId("flag-cpu")).toBeNull();
  expect(within(a).getByTestId("bar-NG")).toBeInTheDocument();
});

test("'Methods disagree' is offered only with two or more active methods", async () => {
  state = baseState({ methods: ["resnet50"] });
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.queryByRole("option", { name: "Methods disagree" })).toBeNull();
});

test("a method switched on since the last refresh asks for a refresh", async () => {
  state = baseState({ missing_methods: ["resnet50"] });
  render(<ClassifyView camera="camA" />);
  expect(await screen.findByText(/R50 switched on since the last refresh/)).toBeInTheDocument();
});

test("the grid is the default view, and a switch shows the 2D map instead and back", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const group = screen.getByRole("group", { name: "View" });
  expect(within(group).getByRole("button", { name: /Grid/ })).toHaveAttribute("aria-pressed", "true");
  expect(calls.some((c) => c.url.includes("/dedup/"))).toBe(false); // the map is only asked for when you switch to it

  await userEvent.click(within(group).getByRole("button", { name: /Scatter/ }));
  expect(await screen.findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  expect(screen.queryByTestId("card-a.png")).toBeNull();
  expect(within(group).getByRole("button", { name: /Scatter/ })).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(within(group).getByRole("button", { name: /Grid/ }));
  await cardEl("a.png");
  expect(screen.queryByRole("img", { name: /2D scatter/ })).toBeNull();
});

test("labeling a selection on the map reloads the page's counts", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Scatter/ }));
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 420, right: 720, bottom: 420, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const before = calls.filter((c) => c.url.includes("/classify/state")).length;
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const labelGroup = await screen.findByRole("group", { name: "Label the selection" });
  await userEvent.click(within(labelGroup).getByRole("button", { name: /Label 1 as NG/ }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/classify/state")).length).toBeGreaterThan(before));
  expect(calls.find((c) => c.url.endsWith("/classify/label-bulk"))!.body).toMatchObject({ feature: "seal", cls: "NG" });
});

test("the map's selection uses the same grid size and columns as the grid, and a change is saved as Classify's setting", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Scatter/ }));
  const svg = await screen.findByRole("img", { name: /2D scatter/ });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 420, right: 720, bottom: 420, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  fireEvent.mouseDown(svg, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
  const panel = await screen.findByTestId("scatter-selection");
  expect((await within(panel).findAllByLabelText("Per page selection top"))[0]).toHaveValue(String(state.settings.per_page));
  expect((await within(panel).findAllByLabelText("Columns selection top"))[0]).toHaveValue(String(state.settings.cols));
  await userEvent.selectOptions((await within(panel).findAllByLabelText("Columns selection top"))[0], "6");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/classify/grid-settings"))).toBe(true));
  expect(calls.some((c) => c.url.includes("/dedup/grid-settings"))).toBe(false);
  expect(calls.find((c) => c.url.includes("/classify/grid-settings"))!.body).toMatchObject({ feature: "seal", cols: 6 });
});

test("Outliers sits next to Grid and Scatter, lists the most unusual pictures, and a label from there reloads the counts", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const group = screen.getByRole("group", { name: "View" });
  expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["▦ Grid", "✦ Scatter", "◎ Outliers"]);
  expect(calls.some((c) => c.url.endsWith("/dedup/outliers"))).toBe(false);

  await userEvent.click(within(group).getByRole("button", { name: /Outliers/ }));
  expect(within(group).getByRole("button", { name: /Outliers/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByTestId("card-b.png")).toBeNull(); // the grid is replaced
  await userEvent.click(await screen.findByRole("button", { name: "Score outliers" }));
  const card = await screen.findByTestId("card-a.png");
  expect(within(card).getByText("outlier 0.300")).toBeInTheDocument();

  const before = calls.filter((c) => c.url.includes("/classify/state")).length;
  await userEvent.click(within(card).getByRole("button", { name: /NG/ }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/classify/state")).length).toBeGreaterThan(before));

  await userEvent.click(within(group).getByRole("button", { name: /Grid/ }));
  expect(await screen.findByTestId("card-b.png")).toBeInTheDocument();
});

test("the outliers list uses Classify's grid settings too", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Outliers/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Score outliers" }));
  await screen.findByTestId("card-a.png");
  const perPage = (await screen.findAllByLabelText("Per page outliers top"))[0];
  expect(perPage).toHaveValue(String(state.settings.per_page));
  await userEvent.selectOptions((await screen.findAllByLabelText("Columns outliers top"))[0], "6");
  await waitFor(() => expect(calls.some((c) => c.url.includes("/classify/grid-settings"))).toBe(true));
  expect(calls.some((c) => c.url.includes("/dedup/grid-settings"))).toBe(false);
});

// --- focused page (opened from the Chain canvas) -----------------------------------------------------------------
test("opened on one ROI from the chain, the page is locked to it: no ROI dropdown, the way back, and that ROI's data", async () => {
  const onBack = vi.fn();
  render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack }} />);
  await cardEl("a.png");
  expect(screen.queryByLabelText(/Feature \(ROI\)/)).toBeNull();
  expect(screen.getByRole("heading", { name: /Classify — camA › seal/ })).toBeInTheDocument();
  expect(calls.some((c) => c.url.includes("/versions/features"))).toBe(false); // the ROI list is not even asked for
  expect(calls.find((c) => c.url.includes("/classify/state"))!.url).toContain("feature=seal");
  await userEvent.click(screen.getByRole("button", { name: /Back to chain/ }));
  expect(onBack).toHaveBeenCalled();
});

test("a product-scoped ROI shows its short name in the heading", async () => {
  render(<ClassifyView camera="camA" focus={{ feature: "B::rod", onBack: () => {} }} />);
  expect(await screen.findByRole("heading", { name: /Classify — camA › rod/ })).toBeInTheDocument();
  expect(calls.find((c) => c.url.includes("/classify/state"))!.url).toContain(encodeURIComponent("B::rod"));
});

test("the Grid | Scatter | Outliers switch still works on the locked page", async () => {
  render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Scatter/ }));
  expect(await screen.findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
});

test("without a focus the ROI dropdown is still there", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.getByLabelText(/Feature \(ROI\)/)).toBeInTheDocument();
});

// --- search by file name ---------------------------------------------------------------------------------------
const searchInfo = { query: "red", classify_feature: "type", product_classes: ["A", "B"] };
const searchBody = (items: unknown[], over: Record<string, unknown> = {}) =>
  gridBody(items, { search: searchInfo, ...over });
const found = [
  card("red_0.png", { leanings: {}, bars: null, outside: true, product: "B", muted: false }),
  card("red_1.png", { leanings: {}, bars: null, outside: false, product: "A", muted: true }),
];

function searchable() {
  grid = (url: string) => (url.includes("search=") ? searchBody(found) : gridBody([card("a.png"), card("b.png")]));
}
const gridCalls = () => calls.filter((c) => /\/classify\/grid\?/.test(c.url));

async function typeSearch(text: string) {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await userEvent.type(screen.getAllByLabelText(/Search file name/)[0], text);
}

test("typing in the pager's search lists the matching pictures of the whole camera, as cards, flagged when outside the ROI or muted", async () => {
  searchable();
  await typeSearch("red");
  const outside = await screen.findByTestId("card-red_0.png");
  expect(screen.queryByTestId("card-a.png")).toBeNull(); // the normal list is replaced
  expect(outside).toHaveStyle({ border: "2px solid #c62828" });
  expect(outside).toHaveAttribute("title", expect.stringContaining("In product B"));
  expect(screen.getByTestId("card-red_1.png")).toHaveStyle({ border: "2px dashed #555" });
  const call = gridCalls().find((c) => c.url.includes("search=red"))!;
  expect(call.url).toContain("feature=seal");
});

test("the search waits for a pause in typing: one request, not one per key", async () => {
  searchable();
  await typeSearch("red");
  await screen.findByTestId("card-red_0.png");
  expect(gridCalls().filter((c) => c.url.includes("search=")).length).toBe(1);
  expect(gridCalls().some((c) => c.url.includes("search=r&") || c.url.endsWith("search=r"))).toBe(false);
});

test("a search with no result says Not found and keeps the field; closing it brings the normal list back", async () => {
  grid = (url: string) => (url.includes("search=") ? searchBody([], { total: 0, n_pages: 1 }) : gridBody([card("a.png"), card("b.png")]));
  await typeSearch("zzz");
  expect(await screen.findByText("Not found")).toBeInTheDocument();
  expect(screen.getAllByLabelText(/Search file name/).length).toBeGreaterThan(0);
  await userEvent.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await cardEl("a.png");
  expect(screen.queryByText("Not found")).toBeNull();
  expect(gridCalls().at(-1)!.url).not.toContain("search=");
});

test("while a search is active the bulk, clear and auto-label tools are switched off", async () => {
  searchable();
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.queryByText(/are off while a search is active/)).toBeNull();
  await userEvent.click(screen.getAllByRole("button", { name: "Search by file name" })[0]);
  await userEvent.type(screen.getAllByLabelText(/Search file name/)[0], "red");
  expect(await screen.findByText(/are off while a search is active/)).toBeInTheDocument();
  const off = document.querySelector("fieldset[disabled]");
  expect(off).not.toBeNull();
  expect(within(off as HTMLElement).queryAllByRole("button").length).toBeGreaterThan(0); // the tools are there, just disabled
});

test("opening a picture outside the ROI shows the product buttons; choosing one sets the label in the product ROI and reloads", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  const labels = within(viewer).getByRole("group", { name: "Label" });
  expect(within(labels).getByRole("button", { name: /OK/ })).toBeDisabled(); // locked until the product fits
  const product = within(viewer).getByRole("group", { name: "Product" });
  expect(within(product).getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "true");
  const before = gridCalls().length;
  await userEvent.click(within(product).getByRole("button", { name: "A" }));
  await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/classify/label"))?.body).toEqual({ feature: "type", frame: "red_0.png", cls: "A" }));
  await waitFor(() => expect(gridCalls().length).toBeGreaterThan(before));
  expect(calls.some((c) => c.url.includes("/classify/state"))).toBe(true);
});

test("the OK / NG keys do nothing on an outside picture in the viewer", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  await screen.findByRole("dialog", { name: "Full-size picture" });
  fireEvent.keyDown(window, { key: "1" });
  expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/classify/label"))).toBe(false);
});

test("a muted picture inside the ROI offers only Unmute in the viewer, and it unmutes for the open ROI", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_1.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).queryByRole("group", { name: "Product" })).toBeNull();
  await userEvent.click(within(viewer).getByRole("button", { name: "Unmute" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/mute"))?.body).toEqual({ feature: "seal", frame: "red_1.png", muted: false }));
});

test("an outside picture can be muted from the viewer", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  await userEvent.click(within(viewer).getByRole("button", { name: "Mute" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/mute"))?.body).toEqual({ feature: "seal", frame: "red_0.png", muted: true }));
});

test("a picture found by search that is inside the ROI and not muted looks and acts like any other", async () => {
  grid = (url: string) => (url.includes("search=") ? searchBody([card("red_9.png", { leanings: {}, bars: null, outside: false, product: "A", muted: false })]) : gridBody([card("a.png")]));
  await typeSearch("red");
  const c = await screen.findByTestId("card-red_9.png");
  expect(c).toHaveStyle({ border: "1px solid #ccc" });
  fireEvent.click(within(c).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).queryByTestId("search-extras")).toBeNull();
  expect(within(viewer).getByRole("button", { name: /OK/ })).toBeEnabled();
});

test("the normal grid has no flags and no extras", async () => {
  render(<ClassifyView camera="camA" />);
  const c = await cardEl("a.png");
  expect(c).toHaveStyle({ border: "1px solid #ccc" });
  expect(c).not.toHaveAttribute("title");
});
