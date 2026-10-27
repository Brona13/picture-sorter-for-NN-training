import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChainNode } from "../api";
import AnchorSection from "./AnchorSection";

const base = { x: 0, y: 0, role: null, scope: null, product: null, products: [], classes: [], frames: 0, labeled: 0, product_counts: {}, unlabeled: 0 };
const detector = { ...base, id: "det:1", kind: "detector", ref: null, label: "Detector 1", flow: { targets: ["hole", "notch"] } } as ChainNode;
const roi = { ...base, id: "roi:part", kind: "roi", ref: "part", label: "part", role: "quality", scope: "camera", anchor: { detector: "det:1", target: "hole", mode: "box", follow_rotation: false } } as ChainNode;

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

test("has no detector or target to pick: the line already says it; nothing without an anchor", async () => {
  const { container, rerender } = render(<AnchorSection camera="camA" roi={roi} detectors={[detector]} onChanged={() => {}} onError={() => {}} />);
  expect(screen.queryByLabelText("Detector")).toBeNull();
  expect(screen.queryByLabelText("Target")).toBeNull();
  expect(screen.queryByRole("button", { name: /anchor/i })).toBeNull();
  expect(screen.getByLabelText(/the found box/)).toBeChecked();
  const bare = { ...roi, anchor: undefined } as ChainNode;
  rerender(<AnchorSection camera="camA" roi={bare} detectors={[detector]} onChanged={() => {}} onError={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

test("choosing my own rectangle is saved at once, from the first picture where the target was found", async () => {
  const onChanged = vi.fn();
  render(<AnchorSection camera="camA" roi={roi} detectors={[detector]} onChanged={onChanged} onError={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText(/my own rectangle/)).toBeEnabled());
  await userEvent.click(screen.getByLabelText(/my own rectangle/));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.url).toContain("/rois/part/anchor");
  expect(put.body).toEqual({ detector: "det:1", target: "hole", mode: "rect", frame: "a.png", follow_rotation: false });
});

test("with its own rectangle, the example picture lists only pictures with the target, and follow rotation is saved at once", async () => {
  const own = { ...roi, anchor: { detector: "det:1", target: "hole", mode: "rect", frame: "a.png", follow_rotation: false } } as ChainNode;
  render(<AnchorSection camera="camA" roi={own} detectors={[detector]} onChanged={() => {}} onError={() => {}} />);
  await waitFor(() => expect(screen.getByRole("option", { name: "b.png" })).toBeInTheDocument());
  expect(screen.queryByRole("option", { name: "c.png" })).toBeNull();
  await userEvent.click(screen.getByLabelText(/Follow rotation/));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ detector: "det:1", target: "hole", mode: "rect", frame: "a.png", follow_rotation: true });
});

test("going back to the found box is saved at once", async () => {
  const own = { ...roi, anchor: { detector: "det:1", target: "hole", mode: "rect", frame: "a.png", follow_rotation: false } } as ChainNode;
  render(<AnchorSection camera="camA" roi={own} detectors={[detector]} onChanged={() => {}} onError={() => {}} />);
  await userEvent.click(screen.getByLabelText(/the found box/));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ detector: "det:1", target: "hole", mode: "box" });
});

test("a target that looks for several elements gives every box its own picture; no own rectangle", async () => {
  const pair = { ...detector, flow: { targets: ["hole 1", "hole 2", "notch"], groups: ["hole"] } } as ChainNode;
  render(<AnchorSection camera="camA" roi={roi} detectors={[pair]} onChanged={() => {}} onError={() => {}} />);
  expect(screen.getByLabelText(/my own rectangle/)).toBeDisabled();
  expect(screen.getByText(/its own picture/)).toBeInTheDocument();
});
