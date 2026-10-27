import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChainNode } from "../api";
import RegionSection from "./RegionSection";

const base = { x: 0, y: 0, role: "quality", scope: "camera", product: null, products: [], classes: [], frames: 0, labeled: 0, product_counts: {}, unlabeled: 0 };
const roi = (over: Partial<ChainNode>) => ({ ...base, id: "roi:part", kind: "roi", ref: "part", label: "part", region: "as_is", region_source: "ingest", ...over }) as ChainNode;

let calls: { url: string; method: string; body?: any }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ feature: "part", region: "own_pending" }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("from Ingest the picture is whole: my own rectangle is not offered, and the way to a part is named", () => {
  render(<RegionSection camera="camA" roi={roi({})} onChanged={() => {}} onError={() => {}} />);
  expect(screen.getByLabelText(/the whole picture \(as Ingest gives it\)/)).toBeChecked();
  expect(screen.getByLabelText(/my own rectangle/)).toBeDisabled();
  expect(screen.getByText(/connect a Picture edits box or a detector/)).toBeInTheDocument();
});

test("behind a Picture edits box the choice is open, and choosing my own rectangle tells the server", async () => {
  const onChanged = vi.fn();
  render(<RegionSection camera="camA" roi={roi({ region_source: "edits", input: "crop:1" })} onChanged={onChanged} onError={() => {}} />);
  expect(screen.getByLabelText(/the picture as it comes in/)).toBeChecked();
  await userEvent.click(screen.getByLabelText(/my own rectangle/));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: expect.stringContaining("/rois/part/region"), body: { mode: "own" } });
});

test("chosen but not drawn: it says no pictures until a rectangle is saved", () => {
  render(<RegionSection camera="camA" roi={roi({ region: "own_pending", region_source: "edits" })} onChanged={() => {}} onError={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("No rectangle drawn yet");
  expect(screen.getByLabelText(/my own rectangle/)).toBeChecked();
});

test("a rectangle kept from before on an Ingest Classifier can be dropped for the whole picture", async () => {
  render(<RegionSection camera="camA" roi={roi({ region: "own" })} onChanged={() => {}} onError={() => {}} />);
  expect(screen.getByText(/drawn before Ingest-only Classifiers used whole pictures/)).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText(/the whole picture/));
  await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "as_is" }));
});

test("a Classifier that follows a detector shows nothing here (the Anchor section decides)", () => {
  const { container } = render(<RegionSection camera="camA" roi={roi({ anchor: { detector: "det:1", target: "t", mode: "box", follow_rotation: false } })} onChanged={() => {}} onError={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
