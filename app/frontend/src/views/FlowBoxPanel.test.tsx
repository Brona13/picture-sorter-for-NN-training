import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChainNode, FlowTolerance } from "../api";
import FlowBoxPanel, { deviation, ToleranceHistogram } from "./FlowBoxPanel";
import { rectOf } from "./FlowDetectorPage";

const box = (kind: string) => ({ id: `${kind}:1`, kind, label: kind, ref: null }) as unknown as ChainNode;
let calls: { url: string; method: string; body?: any }[];
let detail: any;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(detail));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("deviation wraps angles around 0/360", () => {
  expect(deviation(359, 1, true)).toBe(-2);
  expect(deviation(1, 359, true)).toBe(2);
  expect(deviation(359, 1, false)).toBe(358);
});

test("rectOf is the same for any drag direction", () => {
  expect(rectOf({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual([10, 10, 40, 30]);
});

test("histogram: clicking a bar proposes its value as the nominal; bars inside the band are marked", async () => {
  const onPick = vi.fn();
  const tol: FlowTolerance = {
    kind: "tolerance", nominal: 5, tolerance: 10, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 1, fail: 0, undetermined: 0 }, histogram: { low: 0, high: 360, bins: [3, 0, 0, 1, ...Array(32).fill(0)] }, features: [],
  };
  render(<ToleranceHistogram detail={tol} onPick={onPick} />);
  const bars = screen.getAllByRole("button");
  expect(bars).toHaveLength(36);
  expect(bars[0]).toHaveClass("inside");
  expect(bars[35]).toHaveClass("inside"); // 355 deg is 10 deg from 5: wraps around
  expect(bars[18]).not.toHaveClass("inside");
  await userEvent.click(bars[3]);
  expect(onPick).toHaveBeenCalledWith(35);
});

test("Calculate panel offers the operations and the direction toggle, and sends the choice", async () => {
  detail = { kind: "calc", op: "angle", operations: { angle: "Angle A to B", distance: "Distance A to B" }, points: ["A", "B"], a: "A", b: "B", clockwise: false, measured: 3 };
  render(<FlowBoxPanel camera="camA" node={box("calc")} onChanged={() => {}} onOpenPage={() => {}} />);
  expect(await screen.findByRole("option", { name: "Distance A to B" })).toBeInTheDocument();
  expect(screen.getByLabelText(/Counter-clockwise/)).toBeChecked();
  fireEvent.click(screen.getByLabelText(/^↻ Clockwise/));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.clockwise === true)).toBe(true));
});

test("Tolerance panel sends the typed nominal and shows the counts", async () => {
  detail = {
    kind: "tolerance", nominal: null, tolerance: 3, calc: "calc:1", wrap: true, unit: "deg",
    counts: { pass: 0, fail: 0, undetermined: 4 }, histogram: null, features: ["part"],
  };
  render(<FlowBoxPanel camera="camA" node={box("tolerance")} onChanged={() => {}} onOpenPage={() => {}} />);
  const input = await screen.findByLabelText(/Nominal/);
  fireEvent.change(input, { target: { value: "175" } });
  fireEvent.blur(input);
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.nominal === 175)).toBe(true));
  expect(screen.getByRole("status")).toHaveTextContent("4 undetermined");
});

test("Detector panel: adds a target and opens the page for it", async () => {
  detail = {
    kind: "detector", input: "ingest", rotate: true, angle_range: null, pad: 0.3, status: "none",
    targets: [{ name: "left hole", examples: [] }], summary: { frames: 0, found: {}, complete: 0, review: 0 },
  };
  const onOpenPage = vi.fn();
  render(<FlowBoxPanel camera="camA" node={box("detector")} onChanged={() => {}} onOpenPage={onOpenPage} />);
  await userEvent.type(await screen.findByLabelText("New target name"), "right hole");
  await userEvent.click(screen.getByRole("button", { name: "Add target" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/targets") && c.body.name === "right hole")).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Draw example…" }));
  expect(onOpenPage).toHaveBeenCalledWith("detector:1", "left hole");
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});
