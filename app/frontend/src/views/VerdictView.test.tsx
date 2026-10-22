import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
afterEach(() => {
  fireEvent.blur(window); // ends any painting stroke
  vi.unstubAllGlobals();
});

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

test("clicking a picture opens the shared viewer: keys decide, the file name sits under the picture", async () => {
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 2, items: [item("a.png"), item("b.png")] });
  render(<VerdictView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: "Open a.png" }));
  const viewer = await screen.findByRole("dialog", { name: "Full-size picture" });
  expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("a.png");
  expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("1 / 2");
  expect(within(viewer).getByTestId("viewer-verdict")).toHaveTextContent("contradiction — roi1: OK, roi2: NG");
  fireEvent.keyDown(window, { key: "2" });
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/decision"))?.body).toEqual({ frame: "a.png", cls: "NG" }));
  expect(calls.filter((c) => c.url.includes("/verdicts/decision")).length).toBe(1); // the card under the overlay did not act as well
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await waitFor(() => expect(within(viewer).getByTestId("viewer-filename")).toHaveTextContent("b.png"));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Full-size picture" })).toBeNull();
});

test("holding 1, 2 or 0 and sweeping the mouse over the cards paints them, and never overrides a decision of yours", async () => {
  list = () => ({
    status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 3,
    items: [item("a.png"), item("b.png", { status: "ng", verdict: "NG", kind: "manual", decision: "NG" }), item("c.png")],
  });
  render(<VerdictView camera="camA" />);
  await screen.findByTestId("verdict-card-a.png");
  const sweep = (f: string) => fireEvent.mouseMove(screen.getByTestId(`verdict-card-${f}`), { movementX: 6, movementY: 2 });
  const decisions = () => calls.filter((c) => c.url.includes("/verdicts/decision")).map((c) => `${c.body.frame}:${c.body.cls}`);
  const cursor = () => (document.documentElement.classList.contains("painting") ? decodeURIComponent(document.documentElement.style.getPropertyValue("--paint-cursor")) : null);
  fireEvent.keyDown(window, { key: "1" });
  expect(cursor()).toBeNull(); // no pointer over a card yet
  for (const f of ["a.png", "b.png", "c.png"]) sweep(f);
  await waitFor(() => expect(decisions()).toEqual(["a.png:OK", "c.png:OK"])); // b.png is your decision: left alone
  fireEvent.keyUp(window, { key: "1" });
  expect(cursor()).toBeNull();
  fireEvent.keyDown(window, { key: "0" });
  for (const f of ["a.png", "b.png", "c.png"]) sweep(f);
  await waitFor(() => expect(decisions()).toEqual(["a.png:OK", "c.png:OK", "b.png:null"])); // only the card with a decision of yours is cleared
  fireEvent.keyUp(window, { key: "0" });
});

test("the sweep cursor on Verdict is the class colour: green for OK, red for NG, from the moment the key goes down over a card", async () => {
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  const cursor = () => (document.documentElement.classList.contains("painting") ? decodeURIComponent(document.documentElement.style.getPropertyValue("--paint-cursor")) : null);
  await userEvent.hover(card);
  fireEvent.keyDown(window, { key: "2" });
  expect(cursor()).toContain("#c62828");
  fireEvent.keyUp(window, { key: "2" });
  fireEvent.keyDown(window, { key: "1" });
  expect(cursor()).toContain("#1a7f37");
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
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/grid-settings"))?.body).toEqual({ per_page: 6, cols: 3 })); // 12 on 5 columns is 2 rows, so 2 rows of 3
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

test("X clears a decision like 0: by pressing on the card and by sweeping, never a card you have not decided", async () => {
  list = () => ({
    status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 3,
    items: [item("a.png", { decision: "OK" }), item("b.png"), item("c.png", { decision: "NG" })],
  });
  render(<VerdictView camera="camA" />);
  await screen.findByTestId("verdict-card-a.png");
  const sweep = (f: string) => fireEvent.mouseMove(screen.getByTestId(`verdict-card-${f}`), { movementX: 6, movementY: 2 });
  const decisions = () => calls.filter((c) => c.url.includes("/verdicts/decision")).map((c) => `${c.body.frame}:${c.body.cls}`);
  fireEvent.keyDown(window, { key: "x" });
  for (const f of ["a.png", "b.png", "c.png"]) sweep(f);
  await waitFor(() => expect(decisions()).toEqual(["a.png:null", "c.png:null"])); // b has no decision of yours
  fireEvent.keyUp(window, { key: "x" });
  // the sweep cursor is the grey cross, as for 0
  fireEvent.keyDown(window, { key: "X" });
  fireEvent.mouseEnter(screen.getByTestId("verdict-card-a.png"));
  const cursor = decodeURIComponent(document.documentElement.style.getPropertyValue("--paint-cursor"));
  expect(cursor).toContain("#555");
  fireEvent.keyUp(window, { key: "X" });
});

test("X in the viewer clears my decision too", async () => {
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png", { decision: "OK" })] });
  render(<VerdictView camera="camA" />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a.png" }));
  await screen.findByTestId("verdict-viewer");
  fireEvent.keyDown(window, { key: "x" });
  await waitFor(() => expect(calls.find((c) => c.url.includes("/verdicts/decision"))?.body).toEqual({ frame: "a.png", cls: null }));
});

test("the Verdict buttons and its viewer carry only OK / NG, with the shortcut in the hint", async () => {
  list = () => ({ status: "contradiction", page: 1, per_page: 24, n_pages: 1, total: 1, items: [item("a.png")] });
  render(<VerdictView camera="camA" />);
  const card = await screen.findByTestId("verdict-card-a.png");
  expect(card.querySelector("kbd")).toBeNull();
  expect(within(card).getByRole("button", { name: "Decide NG for a.png" })).toHaveAttribute("title", expect.stringContaining("press 2"));
  fireEvent.click(await screen.findByRole("button", { name: "Open a.png" }));
  const viewer = await screen.findByTestId("verdict-viewer");
  expect(viewer.querySelector("kbd")).toBeNull();
  expect(within(viewer).getByRole("button", { name: "NG" })).toHaveAttribute("title", "Shortcut: press 2.");
});
