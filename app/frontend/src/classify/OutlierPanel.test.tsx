import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { outlierShades } from "../views/DedupView";
import OutlierPanel from "./OutlierPanel";

const result = {
  method: "resnet50",
  k: 5,
  scores: [
    { frame: "far.png", score: 0.42 },
    { frame: "mid.png", score: 0.1 },
    { frame: "near.png", score: 0.01 },
  ],
  summary: { min: 0.01, median: 0.1, p95: 0.4, max: 0.42 },
  marks: { "mid.png": { label: "OK", golden: null } },
  classes: ["OK", "NG"],
};
const grid = { per_page: 12, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };

let calls: { url: string; method: string; body?: any }[];
const onGrid = vi.fn();
const onDeleted = vi.fn();
const onResult = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  [onGrid, onDeleted, onResult, onError].forEach((f) => f.mockClear());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/dedup/outliers")) return ok({ id: "o1", status: "queued", progress: {}, result: null, error: null });
      if (url === "/api/jobs/o1") return ok({ id: "o1", status: "done", progress: {}, result, error: null });
      if (url.endsWith("/classify/label")) return ok({ card: { frame: body.frame, label: body.cls, golden: null, deleted: false }, counts: {} });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: true }, counts: {} });
      if (url.endsWith("/classify/restore")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: false }, counts: {} });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = () =>
  render(<OutlierPanel camera="camA" feature="seal" method="resnet50" grid={grid} onGrid={onGrid} onDeleted={onDeleted} onResult={onResult} onError={onError} />);

async function score() {
  const user = userEvent.setup();
  renderIt();
  await user.click(screen.getByText("Outliers (most isolated frames)"));
  await user.click(screen.getByRole("button", { name: "Score outliers" }));
  await screen.findByText(/outlier 0\.420/);
  return user;
}

test("scoring posts feature, method and k, then lists the most isolated frame first", async () => {
  await score();
  const post = calls.find((c) => c.url.endsWith("/dedup/outliers"));
  expect(post?.body).toEqual({ feature: "seal", method: "resnet50", k: 5 });
  const caps = screen.getAllByText(/^outlier \d/).map((e) => e.textContent);
  expect(caps).toEqual(["outlier 0.420", "outlier 0.100", "outlier 0.010"]);
  expect(onResult).toHaveBeenLastCalledWith(result);
  expect(screen.getByRole("status").textContent).toContain("3 frame(s)");
});

test("the k slider is sent with the request", async () => {
  const user = userEvent.setup();
  renderIt();
  await user.click(screen.getByText("Outliers (most isolated frames)"));
  const slider = screen.getByLabelText("k neighbours") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "7" } });
  await user.click(screen.getByRole("button", { name: "Score outliers" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/dedup/outliers"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/dedup/outliers"))?.body.k).toBe(7);
});

test("deleting a card fades it in place, reports it, and turning the grid drops it", async () => {
  const user = await score();
  const cards = screen.getAllByRole("listitem");
  await user.click(within(cards[0]).getByRole("button", { name: /delete/i }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("far.png"));
  expect(calls.find((c) => c.url.endsWith("/classify/delete"))?.body).toMatchObject({ frame: "far.png", via: "Outliers" }); // stamped with the tool
  // nothing moves: the deleted card stays in its place, dimmed, with Restore, and the count above has dropped
  expect(screen.getByText("outlier 0.420")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))).toEqual(["card-far.png", "card-mid.png", "card-near.png"]);
  expect(within(screen.getByTestId("card-far.png")).getByRole("button", { name: "Restore frame" })).toBeEnabled();
  expect(screen.getByRole("status").textContent).toContain("2 frame(s)");
  // turning the grid (here: the page size) drops it
  await user.selectOptions(screen.getAllByLabelText("Per page outliers top")[0], "24");
  await waitFor(() => expect(screen.queryByText("outlier 0.420")).toBeNull());
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

test("a card deleted here can be restored in place, and the list takes it back", async () => {
  const user = await score();
  await user.click(within(screen.getByTestId("card-far.png")).getByRole("button", { name: /delete/i }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("far.png"));
  await user.click(within(screen.getByTestId("card-far.png")).getByRole("button", { name: "Restore frame" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("3 frame(s)"));
  expect(calls.some((c) => c.url.endsWith("/classify/restore"))).toBe(true);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  await user.selectOptions(screen.getAllByLabelText("Per page outliers top")[0], "24"); // it was restored, so it stays
  expect(screen.getByTestId("card-far.png")).toBeInTheDocument();
  expect(within(screen.getByTestId("card-far.png")).getByRole("button", { name: "Delete frame" })).toBeEnabled();
});

test("outlier shades scale against the 95th percentile and cap at 1", () => {
  const s = outlierShades(result);
  expect(s["far.png"]).toBe(1);
  expect(s["mid.png"]).toBeCloseTo(0.25);
  expect(s["near.png"]).toBeCloseTo(0.025);
});

test("clicking a picture opens the viewer on it, in the order of the grid, and a label set there shows on the card", async () => {
  const user = await score();
  await user.click(within(screen.getByTestId("card-mid.png")).getByRole("link"));
  const viewer = screen.getByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("2 / 3"); // far, mid, near
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(within(viewer).getByRole("img", { name: "near.png" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "2" });
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/classify/label"))?.body).toMatchObject({ frame: "near.png", cls: "NG", via: "Outliers" }));
  await waitFor(() => expect(within(screen.getByTestId("card-near.png")).getByRole("button", { name: /NG/ })).toHaveAttribute("aria-pressed", "true"));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
