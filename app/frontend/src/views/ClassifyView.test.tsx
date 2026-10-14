import { render, screen, waitFor, within } from "@testing-library/react";
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
      if (url.includes("/classify/label") || url.includes("/classify/golden")) {
        const b = JSON.parse(init!.body as string);
        const lab = url.includes("/label") ? b.cls : "OK";
        return ok({
          card: { frame: b.frame, label: lab, golden: url.includes("/golden") && b.golden ? "OK" : null, deleted: false },
          counts: { OK: 2, golden_OK: 1, NG: 0, golden_NG: 0, unlabeled: 1, total: 3 },
        });
      }
      if (url.includes("/classify/delete"))
        return ok({ card: { frame: "a.png", label: null, golden: null, deleted: true }, counts: { OK: 0, golden_OK: 0, NG: 0, golden_NG: 0, unlabeled: 2, total: 3 } });
      if (url.includes("/classify/clear") && method === "GET") return ok({ matching: 6, labeled: 3, goldens: 2 });
      if (url.includes("/classify/clear")) return ok({ cleared: 3, goldens_spared: 2, counts: { OK: 1, unlabeled: 5 } });
      if (url.includes("/classify/bulk") && method === "GET") return ok({ selectable: 5, selected: 3, lo: 0.1, hi: 0.9, threshold: 0.1 });
      if (url.includes("/classify/bulk")) return ok({ labeled: 3, counts: { OK: 4 } });
      if (url.includes("/classify/auto") && method === "GET")
        return ok({ candidates: 4, total: 4, per_class: [{ cls: "OK", count: 3, avg_margin: 0.2 }, { cls: "NG", count: 1, avg_margin: 0.3 }], lo: 0.1, hi: 0.5, min_margin: 0.1 });
      if (url.includes("/classify/auto")) return ok({ labeled: 4, counts: { OK: 4 } });
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

test("renders metrics, cards with leaning badges, bars and the golden reference tag", async () => {
  render(<ClassifyView camera="camA" />);
  const a = await cardEl("a.png");
  expect(within(a).getByTitle("cpu")).toHaveTextContent("OK");
  expect(within(a).getByTitle("resnet50")).toHaveTextContent("NG");
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
