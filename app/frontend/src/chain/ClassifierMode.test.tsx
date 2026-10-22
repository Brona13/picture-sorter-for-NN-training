import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChainNode } from "../api";
import ClassifierMode from "./ClassifierMode";

const node = (over: Partial<ChainNode>): ChainNode =>
  ({ id: "roi:seal", kind: "roi", ref: "seal", label: "seal", role: null, scope: null, classes: ["OK", "NG"], labeled: 3, unlabeled: 1, product_counts: {}, products: [], ...over }) as ChainNode;

let calls: { url: string; method: string; body?: any }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ cleared: 3 }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("a Feature Classifier becomes the Product Classifier with the names typed, and says its labels are cleared", async () => {
  const changed = vi.fn();
  render(<ClassifierMode camera="camA" node={node({})} productTaken={false} onChanged={changed} onError={() => {}} />);
  expect(screen.getByRole("button", { name: "Feature" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "Product" }));
  expect(screen.getByText(/Its 3 labels are cleared/)).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Product names"));
  await userEvent.type(screen.getByLabelText("Product names"), "A, B ,C");
  await userEvent.click(screen.getByRole("button", { name: "Make it the Product Classifier" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(calls[0]).toMatchObject({ method: "PUT", body: { mode: "product", product_names: ["A", "B", "C"] } });
  expect(calls[0].url).toContain("/rois/seal/mode");
});

test("the Product button is off when the camera has its Product Classifier already", () => {
  render(<ClassifierMode camera="camA" node={node({})} productTaken onChanged={() => {}} onError={() => {}} />);
  expect(screen.getByRole("button", { name: "Product" })).toBeDisabled();
});

test("the Product Classifier goes back to Feature only after a second click", async () => {
  const changed = vi.fn();
  render(<ClassifierMode camera="camA" node={node({ role: "classify", classes: ["A", "B"] })} productTaken={false} onChanged={changed} onError={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Feature" }));
  expect(calls).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Switch to Feature" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(calls[0].body).toMatchObject({ mode: "feature" });
});
