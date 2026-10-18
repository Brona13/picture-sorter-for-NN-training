import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { lastSession } from "../lastSession";
import { RankContext } from "../RankContext";
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
      if (url.endsWith("/classify/restore")) {
        const b = JSON.parse(init!.body as string);
        return ok({ card: { frame: b.frame, label: null, golden: null, deleted: false }, counts: { OK: 1, golden_OK: 1, NG: 0, golden_NG: 0, unlabeled: 2, total: 3 } });
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
      if (url.endsWith("/classify/unmute")) return ok({ frame: "x", muted: false, muted_count: 0 });
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

test("a deleted card fades and stays where it is: the grid is not reloaded, nothing moves, Restore is on the card", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  const before = calls.filter((c) => c.url.includes("/classify/grid?")).length;
  await userEvent.click(within(a).getByRole("button", { name: "Delete frame" }));
  await waitFor(() => expect(within(screen.getByTestId("card-a.png")).getByRole("button", { name: "Restore frame" })).toBeInTheDocument());
  expect(screen.getAllByTestId(/^card-/).map((e) => e.getAttribute("data-testid"))).toEqual(["card-a.png", "card-b.png"]);
  expect(calls.filter((c) => c.url.includes("/classify/grid?")).length).toBe(before); // no reload
});

test("the deleted card leaves when the grid is turned: another page, another View", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.click(within(a).getByRole("button", { name: "Delete frame" }));
  await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" });
  grid = () => gridBody([card("b.png", { label: "OK", golden: "OK", bars: null })]); // what the server answers now
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /Show/ }), "Unlabeled");
  await waitFor(() => expect(screen.queryByTestId("card-a.png")).toBeNull());
});

test("a deleted card can be restored in place", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  await userEvent.click(within(a).getByRole("button", { name: "Delete frame" }));
  await userEvent.click(await within(screen.getByTestId("card-a.png")).findByRole("button", { name: "Restore frame" }));
  await waitFor(() => expect(within(screen.getByTestId("card-a.png")).getByRole("button", { name: "Delete frame" })).toBeInTheDocument());
  expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(true);
});

test("the numbers are read again once the deletes have settled", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  const states = () => calls.filter((c) => c.url.includes("/classify/state")).length;
  const before = states();
  await userEvent.click(within(a).getByRole("button", { name: "Delete frame" }));
  await waitFor(() => expect(states()).toBeGreaterThan(before));
});

test("holding Delete and sweeping deletes the unlabeled cards, skips labeled and golden ones, once each; they fade in place", async () => {
  grid = () => gridBody([card("a.png"), card("b.png", { label: "OK" }), card("c.png"), card("d.png", { label: "OK", golden: "OK", bars: null })]);
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const sweep = (f: string) => fireEvent.mouseMove(screen.getByTestId(`card-${f}`), { movementX: 6, movementY: 2 });
  fireEvent.keyDown(window, { key: "Delete" });
  for (const f of ["a.png", "b.png", "c.png", "d.png"]) sweep(f);
  sweep("a.png"); // again in the same stroke: nothing more
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/classify/delete")).map((c) => c.body.frame)).toEqual(["a.png", "c.png"]));
  fireEvent.keyUp(window, { key: "Delete" });
  expect(screen.getAllByTestId(/^card-/)).toHaveLength(4); // nothing moved
});

test("X clears a labeled card by pressing and by sweeping; golden cards are skipped by the sweep", async () => {
  grid = () => gridBody([card("a.png", { label: "OK" }), card("b.png", { label: "NG" }), card("c.png", { label: "OK", golden: "OK", bars: null }), card("d.png")]);
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const sweep = (f: string) => fireEvent.mouseMove(screen.getByTestId(`card-${f}`), { movementX: 6, movementY: 2 });
  const clears = () => calls.filter((c) => c.method === "PUT" && c.url.endsWith("/classify/label") && c.body.cls === null).map((c) => c.body.frame);
  fireEvent.keyDown(window, { key: "x" });
  for (const f of ["a.png", "b.png", "c.png", "d.png"]) sweep(f);
  await waitFor(() => expect(clears()).toEqual(["a.png", "b.png"])); // c is golden, d has no label
  fireEvent.keyUp(window, { key: "x" });
  // a single press on the hovered card
  fireEvent.mouseEnter(screen.getByTestId("card-c.png"));
  fireEvent.keyDown(window, { key: "X" });
  await waitFor(() => expect(clears()).toEqual(["a.png", "b.png", "c.png"]));
});

test("a sweep with a class key still only fills unlabeled cards", async () => {
  grid = () => gridBody([card("a.png", { label: "OK" }), card("b.png")]);
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  fireEvent.keyDown(window, { key: "2" });
  fireEvent.mouseMove(screen.getByTestId("card-a.png"), { movementX: 6, movementY: 2 });
  fireEvent.mouseMove(screen.getByTestId("card-b.png"), { movementX: 6, movementY: 2 });
  await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/classify/label")).map((c) => c.body.frame)).toEqual(["b.png"]));
});

test("no-results hint (and no cold-start text)", async () => {
  state = baseState({ cold_start: true, has_results: false, scored: false });
  render(<ClassifyView camera="camA" />);
  expect(await screen.findByText(/Click Refresh scores to evaluate the inbox/)).toBeInTheDocument();
  expect(screen.queryByText(/Start here:/)).toBeNull();
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

test("class buttons carry only their label; the shortcut number is in the hint, and no shortcut text sits above the grid", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  const ng = within(a).getByRole("button", { name: "NG" });
  expect(ng).toHaveTextContent(/^NG$/); // no number on the button
  expect(a.querySelector("kbd")).toBeNull();
  expect(ng).toHaveAttribute("title", expect.stringContaining("press 2"));
  expect(ng).toHaveAttribute("title", expect.stringContaining("paint"));
  expect(ng).toHaveAttribute("title", expect.stringContaining("X or 0 clears"));
  expect(screen.queryByText(/Hover a card and press/)).toBeNull();
});

test("the viewer's label buttons carry only their label too, with the number in the hint", async () => {
  render(<ClassifyView camera="camA" />);
  fireEvent.click(within(await cardEl("a.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  const ng = within(within(viewer).getByRole("group", { name: "Label" })).getByRole("button", { name: "NG" });
  expect(ng).toHaveTextContent(/^NG$/);
  expect(viewer.querySelector("kbd")).toBeNull();
  expect(ng).toHaveAttribute("title", "Shortcut: press 2.");
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

test("a muted picture's viewer has a Show again button on the label line, which unmutes it for the open ROI; the note says why it was hidden", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_1.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByRole("group", { name: "Product" })).toBeInTheDocument(); // which product it is in
  expect(within(viewer).getByTestId("search-note")).toHaveTextContent("Hidden by duplicate removal.");
  const show = within(within(viewer).getByRole("group", { name: "Label" })).getByRole("button", { name: "Show again" });
  await userEvent.click(show);
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/unmute"))?.body).toEqual({ feature: "seal", frame: "red_1.png" }));
});

test("there is no button to mute a picture by hand: Delete is how a picture is got rid of", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).queryByRole("button", { name: /^Mute$/ })).toBeNull();
  expect(within(viewer).queryByRole("button", { name: "Show again" })).toBeNull(); // it is not muted
  expect(within(viewer).getByRole("button", { name: "Delete frame" })).toBeInTheDocument();
});

test("the feature's buttons are captioned Feature next to the Product row", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(within(viewer).getByRole("group", { name: "Label" })).getByText("Feature")).toBeInTheDocument();
});

test("the outside warning is on the zoom line, so nothing in the viewer changes height when it appears", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  const note = within(viewer).getByTestId("search-note");
  expect(note).toHaveTextContent("Outside this ROI: in product B");
  expect(within(viewer).getByTestId("zoom-level").parentElement).toBe(note.parentElement!.parentElement); // on the zoom controls line
  // an inside picture has no note and the same rows
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(within(viewer).queryByText(/Outside this ROI/)).toBeNull();
});

test("a picture found by search that is inside the ROI and not muted looks like any other card and its viewer shows its product", async () => {
  grid = (url: string) => (url.includes("search=") ? searchBody([card("red_9.png", { leanings: {}, bars: null, outside: false, product: "A", muted: false })]) : gridBody([card("a.png")]));
  await typeSearch("red");
  const c = await screen.findByTestId("card-red_9.png");
  expect(c).toHaveStyle({ border: "1px solid #ccc" });
  fireEvent.click(within(c).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  // no alarm: no red note; just which product it is in, with the ROI's own buttons enabled
  expect(within(viewer).queryByText(/Outside this ROI/)).toBeNull();
  expect(within(viewer).getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "true");
  expect(within(viewer).queryByRole("button", { name: "Mute" })).toBeNull();
  expect(within(viewer).getByRole("button", { name: /OK/ })).toBeEnabled();
});

test("the normal grid has no flags and no extras", async () => {
  render(<ClassifyView camera="camA" />);
  const c = await cardEl("a.png");
  expect(c).toHaveStyle({ border: "1px solid #ccc" });
  expect(c).not.toHaveAttribute("title");
});

test("locked to a ROI, the way back and the three views share one line; the plain page keeps its switch under the counts", async () => {
  const { unmount } = render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  const back = screen.getByRole("button", { name: /Back to chain/ });
  const views = screen.getByRole("group", { name: "View" });
  expect(views.parentElement).toBe(back.parentElement); // one row
  expect(within(back.parentElement as HTMLElement).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "← Back to chain", "▦ Grid", "✦ Scatter", "◎ Outliers", "🔄 Refresh scores",
  ]);
  await userEvent.click(within(views).getByRole("button", { name: /Scatter/ }));
  expect(await screen.findByRole("img", { name: /2D scatter/ })).toBeInTheDocument();
  unmount();

  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.queryByRole("button", { name: /Back to chain/ })).toBeNull();
  expect(screen.getAllByRole("group", { name: "View" })).toHaveLength(1);
});

// --- the page says less, and Refresh sits on the navigation line ---------------------------------------------------
test("the explanatory texts are gone: shared ROI, start here, methods and device, the greyed-out hint", async () => {
  state = baseState({ shared_products: ["type A"], frames_seen: 2, inbox_total: 5, cold_start: true, scored: false });
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.queryByText(/Shared ROI/)).toBeNull();
  expect(screen.queryByText(/one golden set and one label set/)).toBeNull();
  expect(screen.queryByText(/Start here/)).toBeNull();
  expect(screen.queryByText(/Methods:/)).toBeNull();
  expect(screen.queryByText(/neural device/)).toBeNull();
  expect(screen.queryByText(/greyed out/)).toBeNull();
  expect(screen.queryByText(/nothing is scored yet/)).toBeNull();
});

test("the bars hint stays when pictures are scored", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.getByText(/Bars under each picture show how close/)).toBeInTheDocument();
});

test("Refresh scores shares the line with Back to chain and the views, and the stale text sits to its right", async () => {
  state = baseState({ stale: { goldens: false, frames: true } });
  render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  const back = screen.getByRole("button", { name: /Back to chain/ });
  const refresh = screen.getByRole("button", { name: /Refresh scores/ });
  expect(refresh.parentElement).toBe(back.parentElement);
  const status = screen.getByText(/The frame set changed since the last refresh/);
  expect(status.parentElement).toBe(back.parentElement);
  const row = Array.from((back.parentElement as HTMLElement).children);
  expect(row.indexOf(status)).toBeGreaterThan(row.indexOf(refresh));
});

test("on the plain page Refresh sits next to the views under the counts", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const views = screen.getByRole("group", { name: "View" });
  expect(screen.getByRole("button", { name: /Refresh scores/ }).parentElement).toBe(views.parentElement);
});

test("Refresh is a grid thing: Scatter and Outliers do not show it", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const views = screen.getByRole("group", { name: "View" });
  await userEvent.click(within(views).getByRole("button", { name: /Scatter/ }));
  expect(screen.queryByRole("button", { name: /Refresh scores/ })).toBeNull();
  await userEvent.click(within(views).getByRole("button", { name: /Outliers/ }));
  expect(screen.queryByRole("button", { name: /Refresh scores/ })).toBeNull();
  await userEvent.click(within(views).getByRole("button", { name: /Grid/ }));
  expect(screen.getByRole("button", { name: /Refresh scores/ })).toBeInTheDocument();
});

test("Refresh scores on the navigation line starts the job and reports it", async () => {
  render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  const button = screen.getByRole("button", { name: /Refresh scores/ });
  await userEvent.click(button);
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/refresh"))).toBe(true));
  expect(await screen.findByText(/Scores refreshed/)).toBeInTheDocument();
});

test("the result of a refresh shows on the Refresh line, to the right of the button, not as a line under it", async () => {
  render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  const button = screen.getByRole("button", { name: /Refresh scores/ });
  await userEvent.click(button);
  const note = await screen.findByText(/Scores refreshed — 3 frames/);
  expect(note.parentElement).toBe(button.parentElement);
  const row = Array.from((button.parentElement as HTMLElement).children);
  expect(row.indexOf(note)).toBeGreaterThan(row.indexOf(button));
});

test("the refresh result goes away when another ROI or camera is opened", async () => {
  const { rerender } = render(<ClassifyView camera="camA" focus={{ feature: "seal", onBack: () => {} }} />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Refresh scores/ }));
  await screen.findByText(/Scores refreshed/);
  rerender(<ClassifyView camera="camB" focus={{ feature: "seal", onBack: () => {} }} />);
  await waitFor(() => expect(screen.queryByText(/Scores refreshed/)).toBeNull());
});

// --- the clickable numbers -------------------------------------------------------------------------------------
test("the numbers are boxes; clicking Unlabeled turns the grid to that View", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getByTestId("kpi-unlabeled"));
  await waitFor(() => expect(gridCalls().at(-1)!.url).toContain("view=Unlabeled"));
  expect(screen.getByRole("combobox", { name: /Show/ })).toHaveValue("Unlabeled");
  expect(screen.getByTestId("kpi-unlabeled")).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByTestId("kpi-class-NG"));
  await waitFor(() => expect(gridCalls().at(-1)!.url).toContain("view=Labeled+NG"));
  expect(screen.getByTestId("kpi-class-NG")).toHaveAttribute("aria-pressed", "true");
});

test("clicking a box from Scatter or Outliers goes back to the grid on that View", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const views = screen.getByRole("group", { name: "View" });
  await userEvent.click(within(views).getByRole("button", { name: /Scatter/ }));
  await screen.findByRole("img", { name: /2D scatter/ });
  await userEvent.click(screen.getByTestId("kpi-class-OK"));
  await cardEl("a.png");
  expect(screen.queryByRole("img", { name: /2D scatter/ })).toBeNull();
  expect(within(views).getByRole("button", { name: /Grid/ })).toHaveAttribute("aria-pressed", "true");
  expect(gridCalls().at(-1)!.url).toContain("view=Labeled+OK");
});

test("clicking a box ends a search, since a search ignores the View", async () => {
  searchable();
  await typeSearch("red");
  await screen.findByTestId("card-red_0.png");
  expect(screen.getByTestId("kpi-class-OK")).toHaveAttribute("aria-pressed", "false"); // a search is not a View
  await userEvent.click(screen.getByTestId("kpi-class-OK"));
  await cardEl("a.png");
  expect(gridCalls().at(-1)!.url).not.toContain("search=");
  expect(gridCalls().at(-1)!.url).toContain("view=Labeled+OK");
});

test("the numbers have the shape the server sends: frames, a box per class, unlabeled", async () => {
  state = baseState({ counts: { OK: 7, golden_OK: 2, NG: 3, golden_NG: 0, unlabeled: 9, total: 19 }, scope: { restricted: true, camera_frames: 40 } });
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  expect(screen.getByTestId("kpi-frames")).toHaveTextContent("Frames19 of 40");
  expect(screen.getByTestId("kpi-class-OK")).toHaveTextContent("7 ⭐ 2");
  expect(screen.getByTestId("kpi-unlabeled")).toHaveTextContent("9");
});

test("in the product-sorting ROI the viewer of a found picture has no Product row: its own buttons are the products", async () => {
  grid = (url: string) =>
    url.includes("search=")
      ? gridBody([card("red_9.png", { leanings: {}, bars: null, outside: false, product: "A", muted: false })], { search: { query: "red", classify_feature: "seal", product_classes: ["A", "B"] } })
      : gridBody([card("a.png")]);
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_9.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).queryByRole("group", { name: "Product" })).toBeNull(); // classify_feature is the open ROI ("seal")
});

test("an in-scope found picture's product can be corrected from its viewer; it is set in the product-sorting ROI and the grid reloads", async () => {
  grid = (url: string) => (url.includes("search=") ? searchBody([card("red_9.png", { leanings: {}, bars: null, outside: false, product: "A", muted: false })]) : gridBody([card("a.png")]));
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_9.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  const before = gridCalls().length;
  await userEvent.click(within(within(viewer).getByRole("group", { name: "Product" })).getByRole("button", { name: "B" }));
  await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/classify/label"))?.body).toEqual({ feature: "type", frame: "red_9.png", cls: "B" }));
  await waitFor(() => expect(gridCalls().length).toBeGreaterThan(before));
});

test("in the viewer of a found picture the Product buttons and the feature's OK / NG buttons share one line, product first", async () => {
  searchable();
  await typeSearch("red");
  fireEvent.click(within(await screen.findByTestId("card-red_0.png")).getByRole("link"));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  const product = within(viewer).getByRole("group", { name: "Product" });
  const labels = within(viewer).getByRole("group", { name: "Label" });
  expect(product.parentElement).toBe(labels.parentElement);
  const row = Array.from((labels.parentElement as HTMLElement).children);
  expect(row.indexOf(product)).toBeLessThan(row.indexOf(labels));
  // nothing is stacked under that line
  expect(labels.parentElement!.parentElement!.children).toHaveLength(1);
});

// --- the options panel on the right ---------------------------------------------------------------------------------
const panel = () => screen.getByRole("complementary", { name: "Options" });

test("the Grid view's properties are in the options panel on the right: Show, Order by, and the bulk tools", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const grid = within(panel()).getByTestId("grid-controls");
  expect(within(grid).getByRole("combobox", { name: /Show/ })).toBeInTheDocument();
  expect(within(grid).queryByRole("combobox", { name: /Rank using/ })).toBeNull(); // it is in the top bar now
  expect(within(grid).getByRole("combobox", { name: /Order by/ })).toBeInTheDocument();
  expect(within(grid).getByText(/Bulk-label a selection/)).toBeInTheDocument();
  expect(within(grid).getByText(/Auto-assign by leaning/)).toBeInTheDocument();
  expect(within(grid).getByText(/Clear labels in this view/)).toBeInTheDocument();
});

test("those controls are no longer in the page itself", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const main = document.querySelector(".with-panel-main") as HTMLElement;
  expect(within(main).queryByRole("combobox", { name: /Show/ })).toBeNull();
  expect(within(main).queryByText(/Bulk-label a selection/)).toBeNull();
});

test("changing Show in the panel still changes the grid", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.selectOptions(within(panel()).getByRole("combobox", { name: /Show/ }), "Unlabeled");
  await waitFor(() => expect(gridCalls().at(-1)!.url).toContain("view=Unlabeled"));
});

test("choosing a view changes what the panel shows: Scatter then Outliers then Grid", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  const views = screen.getByRole("group", { name: "View" });
  await userEvent.click(within(views).getByRole("button", { name: /Scatter/ }));
  const scatter = await within(panel()).findByTestId("scatter-controls");
  expect(within(scatter).getByLabelText("Embedding")).toBeInTheDocument();
  expect(within(scatter).getByRole("button", { name: /map/ })).toBeInTheDocument();
  expect(within(panel()).queryByTestId("grid-controls")).toBeNull();

  await userEvent.click(within(views).getByRole("button", { name: /Outliers/ }));
  const outliers = await within(panel()).findByTestId("outliers-controls");
  expect(within(outliers).getByLabelText("Embedding")).toBeInTheDocument();
  expect(within(outliers).getByLabelText("k neighbours")).toBeInTheDocument(); // the slider
  expect(within(outliers).getByRole("button", { name: "Score outliers" })).toBeInTheDocument();
  expect(within(panel()).queryByTestId("scatter-controls")).toBeNull();

  await userEvent.click(within(views).getByRole("button", { name: /Grid/ }));
  expect(await within(panel()).findByTestId("grid-controls")).toBeInTheDocument();
  expect(within(panel()).queryByTestId("outliers-controls")).toBeNull();
});

test("the Score outliers button and its slider are in the panel, not in the page, and still score", async () => {
  render(<ClassifyView camera="camA" />);
  await cardEl("a.png");
  await userEvent.click(screen.getByRole("button", { name: /Outliers/ }));
  const main = document.querySelector(".with-panel-main") as HTMLElement;
  await within(panel()).findByRole("button", { name: "Score outliers" });
  expect(within(main).queryByRole("button", { name: "Score outliers" })).toBeNull();
  await userEvent.click(within(panel()).getByRole("button", { name: "Score outliers" }));
  expect(await screen.findByTestId("card-a.png")).toBeInTheDocument();
  expect(calls.find((c) => c.url.endsWith("/dedup/outliers"))!.body).toMatchObject({ feature: "seal", k: 5 });
});

test("the panel collapses: its controls go, the page keeps working, and it comes back", async () => {
  try {
    render(<ClassifyView camera="camA" />);
    await cardEl("a.png");
    await userEvent.click(screen.getByRole("button", { name: "Hide options panel" }));
    expect(screen.queryByTestId("grid-controls")).toBeNull();
    expect(screen.getByTestId("card-a.png")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("kpi-unlabeled")); // the numbers still switch the View
    await waitFor(() => expect(gridCalls().at(-1)!.url).toContain("view=Unlabeled"));
    await userEvent.click(screen.getByRole("button", { name: "Show options panel" }));
    const show = within(await screen.findByTestId("grid-controls")).getByRole("combobox", { name: /Show/ });
    expect(show).toHaveValue("Unlabeled");
  } finally {
    lastSession.setPanelCollapsed(false);
  }
});

test("collapsed, the Scatter and Outliers views show no controls (the hints point to the panel)", async () => {
  try {
    lastSession.setPanelCollapsed(true);
    render(<ClassifyView camera="camA" />);
    await cardEl("a.png");
    await userEvent.click(screen.getByRole("button", { name: /Outliers/ }));
    expect(await screen.findByText(/in the options panel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Score outliers" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show options panel" }));
    expect(await screen.findByRole("button", { name: "Score outliers" })).toBeInTheDocument();
  } finally {
    lastSession.setPanelCollapsed(false);
  }
});

// --- the method to rank by comes from the top bar ----------------------------------------------------------------------
const renderRanked = (rank: string) => render(<RankContext.Provider value={{ rank }}><ClassifyView camera="camA" /></RankContext.Provider>);

test("the grid ranks by the method chosen in the top bar", async () => {
  renderRanked("cpu");
  await cardEl("a.png");
  expect(calls.find((c) => c.url.includes("/classify/grid?"))!.url).toContain("rank=cpu");
});

test("with no choice, or a method that is no longer in use, it ranks by the server's default", async () => {
  renderRanked("resnet18"); // the state lists cpu and resnet50 only
  await cardEl("a.png");
  expect(calls.find((c) => c.url.includes("/classify/grid?"))!.url).toContain("rank=resnet50");
});

test("changing the choice in the top bar reloads the grid under the new method", async () => {
  const { rerender } = render(<RankContext.Provider value={{ rank: "" }}><ClassifyView camera="camA" /></RankContext.Provider>);
  await cardEl("a.png");
  rerender(<RankContext.Provider value={{ rank: "cpu" }}><ClassifyView camera="camA" /></RankContext.Provider>);
  await waitFor(() => expect(gridCalls().at(-1)!.url).toContain("rank=cpu"));
});
