import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ClusterBrowser from "./ClusterBrowser";

const many = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, "0")}.png`);
const result = {
  params: { method: "resnet50", epsilon: 0.02, min_points: 2 },
  summary: { clusters: 2, covered: 33, unique: 0, total: 33 },
  would_mute: 31,
  clusters: [
    { id: 0, members: many, representative: "m00.png" },
    { id: 1, members: ["x1.png", "x2.png", "x3.png"], representative: "x1.png" },
  ],
  noise_frames: [],
  classes: ["OK", "NG"],
  marks: {},
};
const grid = { per_page: 12, cols: 4, per_page_options: [12, 24, 48, 96], cols_options: [3, 4, 5, 6, 8] };

let calls: { url: string; method: string; body?: any }[];
const onPick = vi.fn();
const onMarks = vi.fn();
const onGrid = vi.fn();
const onDeleted = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  [onPick, onMarks, onGrid, onDeleted, onError].forEach((f) => f.mockClear());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/classify/label")) return ok({ card: { frame: body.frame, label: body.cls, golden: null, deleted: false }, counts: {} });
      if (url.endsWith("/classify/delete")) return ok({ card: { frame: body.frame, label: null, golden: null, deleted: true }, counts: {} });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = (over: Record<string, unknown> = {}) =>
  render(
    <ClusterBrowser
      camera="camA"
      feature="seal"
      result={result}
      picks={{}}
      marks={{}}
      grid={grid}
      onPick={onPick}
      onMarks={onMarks}
      onGrid={onGrid}
      onDeleted={onDeleted}
      onError={onError}
      {...over}
    />,
  );

test("with a mute handler, M on a hovered cluster card calls it and the card gets the muted frame; without one M does nothing", async () => {
  const muted = new Set<string>();
  const toggle = vi.fn(async (f: string) => void (muted.has(f) ? muted.delete(f) : muted.add(f)));
  renderIt({ mute: { is: (f: string) => muted.has(f), toggle } });
  await userEvent.hover(screen.getByTestId("card-m01.png"));
  fireEvent.keyDown(window, { key: "m" });
  await waitFor(() => expect(toggle).toHaveBeenCalledWith("m01.png"));
  // the card has the Mute button (Unmute and dimmed once muted)
  const card = await screen.findByTestId("card-m01.png");
  expect(within(card).getByRole("button", { name: "Unmute frame" })).toBeInTheDocument();
  expect(within(card).getByRole("img")).toHaveStyle({ opacity: "0.5" });
  await userEvent.click(within(screen.getByTestId("card-m02.png")).getByRole("button", { name: "Mute frame" }));
  expect(toggle).toHaveBeenCalledWith("m02.png");
});

test("without a mute handler M does nothing on a cluster card", async () => {
  renderIt();
  await userEvent.hover(screen.getByTestId("card-m01.png"));
  fireEvent.keyDown(window, { key: "m" });
  expect(calls).toHaveLength(0);
});

test("paging is remembered per cluster while the grid size is shared", async () => {
  renderIt();
  expect(screen.getAllByTestId(/^card-/)).toHaveLength(12);
  await userEvent.click(within(screen.getByRole("navigation", { name: "Pagination top" })).getByRole("button", { name: /Next/ }));
  expect(screen.getByTestId("card-m12.png")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Cluster 1/ }));
  expect(screen.getAllByTestId(/^card-/)).toHaveLength(3); // other cluster starts on its own page 1
  await userEvent.click(screen.getByRole("button", { name: /Cluster 0/ }));
  expect(screen.getByTestId("card-m12.png")).toBeInTheDocument(); // cluster 0 is still on page 2
  await userEvent.selectOptions(screen.getByLabelText("Columns top"), "6");
  expect(onGrid).toHaveBeenCalledWith(24, 6); // the page size follows the columns in whole rows
});

test("hover shortcuts on a cluster card: a number does not label (Dedup does not label), Delete deletes", async () => {
  renderIt();
  const card = screen.getByTestId("card-m01.png");
  expect(within(card).queryByRole("button", { name: "OK" })).toBeNull();
  expect(within(card).queryByRole("button", { name: /golden/i })).toBeNull();
  await userEvent.hover(card);
  await userEvent.keyboard("2");
  expect(calls.some((c) => c.url.endsWith("/classify/label"))).toBe(false);
  fireEvent.keyDown(window, { key: "Delete" });
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/classify/delete"))).toBe(true));
  expect(calls.find((c) => c.url.endsWith("/classify/delete"))!.body).toEqual({ feature: "seal", frame: "m01.png", via: "Clusters" });
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("m01.png"));
});

test("holding a class key and sweeping over cards paints nothing and shows no colour cursor (Dedup does not label)", async () => {
  renderIt();
  const a = screen.getByTestId("card-m00.png");
  const b = screen.getByTestId("card-m01.png");
  await userEvent.hover(a);
  await userEvent.keyboard("{1>}");
  fireEvent.mouseMove(a, { movementX: 8, movementY: 0 });
  await userEvent.hover(b);
  fireEvent.mouseMove(b, { movementX: 8, movementY: 0 });
  expect(document.documentElement.classList.contains("painting")).toBe(false); // no colour cursor while the key is held
  await userEvent.keyboard("{/1}");
  expect(calls.some((c) => c.url.endsWith("/classify/label"))).toBe(false);
  expect(document.documentElement.classList.contains("painting")).toBe(false);
});

test("Delete does nothing when no card is hovered", async () => {
  renderIt();
  fireEvent.keyDown(window, { key: "Delete" });
  expect(calls).toHaveLength(0);
});

test("the representative follows the picks and a stale pick falls back to the default", () => {
  renderIt({ picks: { 0: "m05.png", 1: "gone.png" } });
  expect(within(screen.getByTestId("card-m05.png")).getByRole("button", { name: "Representative of this cluster" })).toBeDisabled();
});

test("clicking a picture opens the full image", () => {
  renderIt();
  expect(screen.getByAltText("m00.png").closest("a")!.getAttribute("href")).toBe("/api/cameras/camA/frames/m00.png/image");
});

test("each tab keeps its coloured bottom line however often the selection moves", async () => {
  renderIt();
  const nav = screen.getByRole("navigation", { name: "Clusters" });
  const tabs = within(nav).getAllByRole("button");
  const bottoms = tabs.map((t) => t.style.borderBottomColor);
  expect(bottoms.every(Boolean)).toBe(true);
  expect(new Set(bottoms).size).toBe(tabs.length); // one colour per cluster
  for (const i of [1, 0, 1, 1, 0, 0, 1]) {
    await userEvent.click(tabs[i]);
    expect(tabs.map((t) => t.style.borderBottomColor)).toEqual(bottoms);
    expect(tabs[i]).toHaveAttribute("aria-current", "true");
  }
  // the selected tab takes its own colour on the sides too; the others keep the neutral border
  await userEvent.click(tabs[0]);
  expect(tabs[0].style.borderLeftColor).toBe(bottoms[0]);
  expect(tabs[1].style.borderLeftColor).not.toBe(bottoms[1]);
});
