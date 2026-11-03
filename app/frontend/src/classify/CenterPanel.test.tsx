import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GridQuery } from "../api";
import CenterPanel from "./CenterPanel";

const query = { feature: "pick", view: "Labeled OK", rank: "cpu", order: "Name", show_muted: false } as unknown as GridQuery;

let calls: { url: string; method: string; body?: any }[];
let center: any;
beforeEach(() => {
  calls = [];
  center = { available: true, backbone: "resnet18", view: "Labeled OK", count: 40, n_max: 20, picks: [{ frame: "a.png", label: "OK" }, { frame: "b.png", label: null }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/classify/center")) return new Response(JSON.stringify(center));
    if (url.includes("/classify/promote")) return new Response(JSON.stringify({ card: { frame: "a.png", label: "OK", golden: "OK", deleted: false }, counts: { OK: 1, NG: 0 } }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const open = async (onPromoted = vi.fn(), q: GridQuery = query) => {
  render(<CenterPanel camera="camA" query={q} classes={["OK", "NG"]} revision={0} onPromoted={onPromoted} onError={vi.fn()} />);
  const details = screen.getByText(/Suggested center/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByTestId("center-a.png");
  return onPromoted;
};

test("asks for the centers of the view that is chosen and says how many pictures it looked at", async () => {
  await open();
  const url = calls.find((c) => c.url.includes("/classify/center"))!.url;
  expect(url).toContain("view=Labeled+OK");
  expect(url).toContain("n=3");
  expect(screen.getByText(/Among/).textContent).toContain("40");
});

test("a labeled center can only become a golden of its label; an unlabeled one offers each class", async () => {
  await open();
  expect(screen.getByTestId("center-a.png").querySelectorAll("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "⭐ Make golden (OK)" })).toBeInTheDocument();
  expect(screen.getByTestId("center-b.png").querySelectorAll("button")).toHaveLength(2);
});

test("making a center golden promotes it with its own label", async () => {
  const onPromoted = await open();
  fireEvent.click(screen.getByRole("button", { name: "⭐ Make golden (OK)" }));
  await waitFor(() => expect(onPromoted).toHaveBeenCalledWith("a.png", "OK", { OK: 1, NG: 0 }));
  expect(calls.find((c) => c.url.includes("/classify/promote"))!.body).toEqual({ feature: "pick", frame: "a.png", cls: "OK" });
});

test("changing the view asks again for the centers of the new view", async () => {
  const { rerender } = render(<CenterPanel camera="camA" query={query} classes={["OK", "NG"]} revision={0} onPromoted={vi.fn()} onError={vi.fn()} />);
  const details = screen.getByText(/Suggested center/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByTestId("center-a.png");
  rerender(<CenterPanel camera="camA" query={{ ...query, view: "Labeled NG" }} classes={["OK", "NG"]} revision={0} onPromoted={vi.fn()} onError={vi.fn()} />);
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/classify/center")).some((c) => c.url.includes("view=Labeled+NG"))).toBe(true));
});

test("without a ResNet or with too few pictures it says so", async () => {
  center = { available: false, backbone: null, view: "Labeled OK", count: 40, n_max: 20, picks: [] };
  render(<CenterPanel camera="camA" query={query} classes={["OK", "NG"]} revision={0} onPromoted={vi.fn()} onError={vi.fn()} />);
  const details = screen.getByText(/Suggested center/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByText(/No ResNet is available/)).toBeInTheDocument();
});
