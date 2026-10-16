import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import VerdictView from "./VerdictView";

const summary = (over: Record<string, number> = {}) => ({
  frames: 12, total: 10, deleted: 2, ok: 4, ng: 2, open: 1, contradiction: 1, stale: 1, duplicates: 1, ...over,
});

const item = (frame: string, over: Record<string, unknown> = {}) => ({
  frame, status: "contradiction", bucket: "contradiction", verdict: null, kind: null, decision: null, muted_in: [],
  inputs: [
    { feature: "roi1", short_name: "roi1", cls: "OK", source: "manual", via: "Classify", updated: 1 },
    { feature: "roi2", short_name: "roi2", cls: "NG", source: "bulk", via: "Dedup", updated: 2 },
  ],
  ...over,
});

let calls: { url: string; method: string; body?: any }[];
let list: (url: string) => unknown;

beforeEach(() => {
  calls = [];
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png")] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/verdicts/summary")) return ok(summary());
      if (url.includes("/verdicts/decision")) return ok({ item: item("a.png", { status: "ng", verdict: "NG", kind: "manual", decision: "NG" }), summary: summary() });
      if (url.includes("/verdicts?")) return ok(list(url));
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("opens on contradictions and shows where each ROI's label came from", async () => {
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  expect(calls.find((c) => c.url.includes("/verdicts?"))!.url).toContain("status=contradiction");
  expect(within(card).getByText(/manual · Classify/)).toBeInTheDocument();
  expect(within(card).getByText(/bulk · Dedup/)).toBeInTheDocument();
  expect(within(card).getByTestId("status-a.png")).toHaveTextContent("contradiction");
  expect(screen.getByTestId("verdict-bar")).toHaveTextContent("6 of 10 with a verdict");
  expect(screen.getByTestId("verdict-deleted")).toHaveTextContent("2 deleted");
});

test("a label without a recorded page says so", async () => {
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png", { inputs: [{ feature: "roi1", short_name: "roi1", cls: "OK", source: "manual", via: "", updated: 1 }] })] });
  render(<VerdictView camera="camA" />);
  expect(await screen.findByText(/page unknown/)).toBeInTheDocument();
});

test("deciding sends the class and reloads", async () => {
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  const before = calls.filter((c) => c.url.includes("/verdicts?")).length;
  await userEvent.click(within(card).getByRole("button", { name: "Decide NG for a.png" }));
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/decision"))?.body).toEqual({ frame: "a.png", cls: "NG" }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/verdicts?")).length).toBeGreaterThan(before));
});

test("a stale decision offers Keep and Clear", async () => {
  list = () => ({ status: "stale", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png", { status: "stale", bucket: "stale", decision: "NG" })] });
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  expect(within(card).getByText(/labels changed since you decided NG/)).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Keep NG for a.png" }));
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/decision"))?.body).toEqual({ frame: "a.png", cls: "NG" }));
  await userEvent.click(within(card).getByRole("button", { name: "Clear my decision for a.png" }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/verdicts/decision")).at(-1)?.body).toEqual({ frame: "a.png", cls: null }));
});

test("the filter changes the request and automatic verdicts are labelled", async () => {
  render(<VerdictView camera="camA" />);
  await screen.findByTestId("verdict-card-a.png");
  list = () => ({ status: "ok", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("b.png", { status: "ok", bucket: "ok", verdict: "OK", kind: "auto", inputs: [] })] });
  await userEvent.selectOptions(screen.getByLabelText("Show"), "ok");
  const card = await screen.findByTestId("verdict-card-b.png");
  expect(calls.at(-2)!.url + calls.at(-1)!.url).toContain("status=ok");
  expect(within(card).getByTestId("status-b.png")).toHaveTextContent("OK · automatic");
  expect(within(card).getByText(/No ROI has labelled this picture/)).toBeInTheDocument();
});

test("uses the saved grid: columns, the pager, and saving a new choice", async () => {
  const settings = { per_page: 12, cols: 5, per_page_options: [12, 24], cols_options: [3, 5] };
  list = () => ({ status: "contradiction", page: 1, per_page: 12, n_pages: 3, total: 30, settings, items: [item("a.png"), item("b.png")] });
  render(<VerdictView camera="camA" />);
  await screen.findByTestId("verdict-card-a.png");
  expect(screen.getByTestId("verdict-card-a.png").parentElement!.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
  expect(screen.getAllByText(/Page/)[0]).toHaveTextContent("Page 1 of 3");
  await userEvent.selectOptions(screen.getByLabelText("Columns top"), "3");
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/grid-settings"))?.body).toEqual({ per_page: 12, cols: 3 }));
});

test("hover keys decide: 1 = OK, 2 = NG, 0 clears an existing decision", async () => {
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png", { decision: "OK" })] });
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  await userEvent.hover(card);
  await userEvent.keyboard("2");
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/decision"))?.body).toEqual({ frame: "a.png", cls: "NG" }));
  await userEvent.keyboard("0");
  await waitFor(() => expect(calls.filter((c) => c.url.includes("/verdicts/decision")).at(-1)?.body).toEqual({ frame: "a.png", cls: null }));
});
