import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GridQuery } from "../api";
import SuggestPanel from "./SuggestPanel";

const query = { feature: "pick", view: "All", rank: "cpu", order: "Name", show_muted: false } as unknown as GridQuery;
const bars = { rows: [{ cls: "OK", dist: 0.1, rel: 0.5, leader: true }, { cls: "NG", dist: 0.1, rel: 0.5, leader: false }], novelty: 0.1, margin: 0.01, close_call: true };

let calls: { url: string; method: string; body?: any }[];
let suggestion: any;
beforeEach(() => {
  calls = [];
  suggestion = { available: true, backbone: null, n_min: 3, n_max: 20, default_n: 10, labeled: true, picks: [{ frame: "a.png", label: "NG", bars }, { frame: "b.png", label: "OK", bars }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/classify/suggest")) return new Response(JSON.stringify(suggestion));
    if (url.includes("/classify/promote")) return new Response(JSON.stringify({ card: { frame: "a.png", label: "NG", golden: "NG", deleted: false }, counts: { OK: 4, NG: 2 } }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const open = async (onPromoted = vi.fn()) => {
  render(<SuggestPanel camera="camA" query={query} classes={["OK", "NG"]} revision={0} onPromoted={onPromoted} onError={vi.fn()} />);
  const details = screen.getByText(/Suggested goldens/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByTestId("suggest-a.png");
  return onPromoted;
};

test("step 2: the picks are labeled pictures with one button, for the label they already have", async () => {
  await open();
  expect(screen.getByText(/labels come from the freeze/)).toBeInTheDocument();
  expect(screen.getByTestId("suggest-a.png").querySelectorAll("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "⭐ Make golden (NG)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "⭐ Make golden (OK)" })).toBeInTheDocument();
});

test("making a pick golden promotes it with its own label", async () => {
  const onPromoted = await open();
  fireEvent.click(screen.getByRole("button", { name: "⭐ Make golden (NG)" }));
  await waitFor(() => expect(onPromoted).toHaveBeenCalledWith("a.png", "NG", { OK: 4, NG: 2 }));
  expect(calls.find((c) => c.url.includes("/classify/promote"))!.body).toEqual({ feature: "pick", frame: "a.png", cls: "NG" });
});

test("step 1 style picks keep one button per class", async () => {
  suggestion = { ...suggestion, labeled: false, picks: [{ frame: "a.png", bars }] };
  await open();
  expect(screen.getByRole("button", { name: "⭐ OK" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "⭐ NG" })).toBeInTheDocument();
});

test("nothing to suggest says which kind of picture it looked for", async () => {
  suggestion = { available: false, backbone: null, n_min: 3, n_max: 20, default_n: 10, picks: [] };
  render(<SuggestPanel camera="camA" query={query} classes={["OK", "NG"]} revision={0} onPromoted={vi.fn()} onError={vi.fn()} />);
  const details = screen.getByText(/Suggested goldens/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByText(/No unlabeled candidates match/)).toBeInTheDocument();
});
