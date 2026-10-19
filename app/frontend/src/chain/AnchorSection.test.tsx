import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChainNode } from "../api";
import AnchorSection from "./AnchorSection";

const base = { x: 0, y: 0, role: null, scope: null, product: null, products: [], classes: [], frames: 0, labeled: 0, product_counts: {}, unlabeled: 0 };
const detector = { ...base, id: "det:1", kind: "detector", ref: null, label: "Detector 1", flow: { targets: ["hole", "notch"] } } as ChainNode;
const roi = { ...base, id: "roi:part", kind: "roi", ref: "part", label: "part", role: "quality", scope: "camera" } as ChainNode;

let calls: { url: string; method: string; body?: any }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/boxes")) return new Response(JSON.stringify({ boxes: { "b.png": { hole: {} }, "a.png": { hole: {} }, "c.png": { notch: {} } }, review: [] }));
    return new Response(JSON.stringify({}));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("sets the anchor from the first picture where the target was found, with the chosen options", async () => {
  const onChanged = vi.fn();
  render(<AnchorSection camera="camA" roi={roi} detectors={[detector]} onChanged={onChanged} onError={() => {}} />);
  await userEvent.click(screen.getByLabelText(/my own rectangle/));
  await waitFor(() => expect(screen.getByRole("option", { name: "a.png" })).toBeInTheDocument());
  expect(screen.queryByRole("option", { name: "c.png" })).toBeNull(); // the notch was found there, not the hole
  await userEvent.click(screen.getByLabelText(/Follow rotation/));
  await userEvent.click(screen.getByRole("button", { name: "Set anchor" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.url).toContain("/rois/part/anchor");
  expect(put.body).toEqual({ detector: "det:1", target: "hole", mode: "rect", frame: "a.png", follow_rotation: true });
});

test("an anchored ROI can be released", async () => {
  const anchored = { ...roi, anchor: { detector: "det:1", target: "hole", mode: "rect", margin: 0.1, follow_rotation: false, angle0: 0, dx: 1, dy: 1, w: 5, h: 5 } } as ChainNode;
  render(<AnchorSection camera="camA" roi={anchored} detectors={[detector]} onChanged={() => {}} onError={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Remove anchor" }));
  await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rois/part/anchor"))).toBe(true));
});

test("by default the ROI is the found box with a margin; no example picture is needed", async () => {
  const onChanged = vi.fn();
  render(<AnchorSection camera="camA" roi={roi} detectors={[detector]} onChanged={onChanged} onError={() => {}} />);
  expect(screen.getByLabelText(/the found box/)).toBeChecked();
  expect(screen.queryByLabelText(/Rectangle drawn on/)).toBeNull();
  const margin = screen.getByLabelText(/Margin on each side/);
  await userEvent.clear(margin);
  await userEvent.type(margin, "25");
  await userEvent.click(screen.getByRole("button", { name: "Set anchor" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ detector: "det:1", target: "hole", mode: "box", margin: 0.25 });
});
