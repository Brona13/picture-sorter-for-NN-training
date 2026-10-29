import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { TimingRow } from "../api";
import LogView from "./LogView";
import { logsText, pageText, timingText } from "./logText";

const rec = (id: number, over = {}) => ({
  id, ts: 1_761_400_000 + id, level: "ERROR", source: "backend", logger: "http", message: `msg ${id}`, request_id: `req${id}`,
  camera: "camA", job_id: null, duration_ms: 12.5, exc: id === 1 ? "Traceback...\nValueError: x" : null, extra: null, audit: 0, ...over,
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Handler = (url: string, init?: RequestInit) => unknown;
/** A fetch that answers by address; `page` answers /api/logs/page. */
function stub(page: Handler | unknown[] = [], extra: Record<string, Handler | unknown> = {}) {
  const answers: Record<string, Handler | unknown> = {
    "/api/logs/page": typeof page === "function" ? page : { total: (page as unknown[]).length, rows: page },
    "/api/logs/facets": { areas: ["http", "jobs"], sources: ["backend", "frontend"] },
    "/api/logs/debug": { on: false },
    "/api/version": { version: "1.2.3" },
    ...extra,
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    const a = key ? answers[key] : [];
    return new Response(JSON.stringify(typeof a === "function" ? (a as Handler)(url, init) : a));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const asked = (fetchMock: ReturnType<typeof stub>, part: string) => fetchMock.mock.calls.some(([u]) => String(u).includes(part));

test("lists records, filters by level and request id through the query", async () => {
  const fetchMock = stub([rec(2), rec(1)]);
  render(<LogView camera="camA" />);
  expect(await screen.findByText("msg 2")).toBeInTheDocument();
  expect(asked(fetchMock, "level=WARNING")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "req2" }));
  await waitFor(() => expect(asked(fetchMock, "request_id=req2")).toBe(true));
  await userEvent.click(screen.getByLabelText(/only camA/));
  await waitFor(() => expect(asked(fetchMock, "camera=camA")).toBe(true));
});

test("'since app restart' asks the backend for only what was recorded after it started", async () => {
  const fetchMock = stub([rec(1)]);
  render(<LogView camera="camA" />);
  await screen.findByText("msg 1");
  expect(asked(fetchMock, "since_restart")).toBe(false);
  await userEvent.click(screen.getByLabelText(/since app restart/));
  await waitFor(() => expect(asked(fetchMock, "since_restart=true")).toBe(true));
});

test("a record opens to its traceback", async () => {
  stub([rec(1)]);
  render(<LogView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: "msg 1" }));
  expect(screen.getByText(/ValueError: x/)).toBeInTheDocument();
});

test("the copy text is in time order with a header and the ids", () => {
  const text = logsText([rec(2), rec(1)], "Picture Sorter 1.2.3");
  expect(text.startsWith("Picture Sorter 1.2.3")).toBe(true);
  expect(text.indexOf("msg 1")).toBeLessThan(text.indexOf("msg 2"));
  expect(text).toContain("cam=camA req=req1 12.5ms");
});

test("an empty log says so", async () => {
  stub([]);
  render(<LogView camera="" />);
  expect(await screen.findByText("No records for this filter.")).toBeInTheDocument();
});

test("clicking a column sorts by it, and again reverses it", async () => {
  const fetchMock = stub([rec(2), rec(1)]);
  render(<LogView camera="camA" />);
  await screen.findByText("msg 2");
  expect(asked(fetchMock, "order=time")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: /^ms( [▼▲])?$/ }));
  await waitFor(() => expect(asked(fetchMock, "order=ms")).toBe(true));
  const before = fetchMock.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: /^ms( [▼▲])?$/ }));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain("desc=true");
  expect(screen.getByRole("button", { name: /^ms ▲$/ }).closest("th")).toHaveAttribute("aria-sort", "ascending");
});

test("paging: a page of records, the range, Next and the records-per-page choice", async () => {
  const fetchMock = stub((url) => {
    const offset = Number(new URL(url, "http://x").searchParams.get("offset") ?? 0);
    return { total: 120, rows: [rec(offset + 1)] };
  });
  render(<LogView camera="camA" />);
  expect(await screen.findByText("1–50 of 120")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(await screen.findByText("51–100 of 120")).toBeInTheDocument();
  expect(asked(fetchMock, "offset=50")).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText("Per page"), "100");
  await waitFor(() => expect(asked(fetchMock, "limit=100")).toBe(true));
  expect(await screen.findByText("1–100 of 120")).toBeInTheDocument(); // a new size starts again at the first page
});

test("area, search and slower-than become filters of the query", async () => {
  const fetchMock = stub([rec(1)]);
  render(<LogView camera="camA" />);
  await screen.findByText("msg 1");
  await userEvent.selectOptions(screen.getByLabelText("Area"), "jobs");
  await waitFor(() => expect(asked(fetchMock, "area=jobs")).toBe(true));
  await userEvent.type(screen.getByLabelText("Find text"), "canvas");
  await userEvent.type(screen.getByLabelText("Slower than (ms)"), "250");
  await waitFor(() => expect(asked(fetchMock, "text=canvas")).toBe(true));
  await waitFor(() => expect(asked(fetchMock, "min_ms=250")).toBe(true));
});

test("grouped by request: a request shows its steps below it, indented, when opened", async () => {
  const fetchMock = stub((url) => {
    const p = new URL(url, "http://x").searchParams;
    if (p.get("children_of")) {
      return { total: 2, rows: [rec(11, { level: "DEBUG", logger: "timing", message: "chain.canvas", extra: '{"depth": 1}', duration_ms: 90 }), rec(12, { level: "DEBUG", logger: "timing", message: "chain.edges", extra: '{"depth": 2}', duration_ms: 5 })] };
    }
    return { total: 1, rows: [{ ...rec(1, { message: "GET /api/cameras/camA/chain -> 200", duration_ms: 100, request_id: "r1" }), children: 2 }] };
  });
  render(<LogView camera="camA" />);
  await screen.findByText("GET /api/cameras/camA/chain -> 200");
  expect(screen.queryByRole("button", { name: /Show 2 steps/ })).not.toBeInTheDocument(); // not grouped yet
  await userEvent.click(screen.getByLabelText(/Group by request/));
  await waitFor(() => expect(asked(fetchMock, "nested=true")).toBe(true));
  await userEvent.click(await screen.findByRole("button", { name: "Show 2 steps" }));
  expect(await screen.findByText(/↳ chain\.canvas/)).toBeInTheDocument();
  expect(asked(fetchMock, "children_of=r1")).toBe(true);
  const edges = screen.getByText(/↳ chain\.edges/).closest("td")!;
  const canvas = screen.getByText(/↳ chain\.canvas/).closest("td")!;
  expect(parseInt(edges.style.paddingLeft)).toBeGreaterThan(parseInt(canvas.style.paddingLeft)); // the deeper step is indented more
  await userEvent.click(screen.getByRole("button", { name: "Hide 2 steps" }));
  await waitFor(() => expect(screen.queryByText(/↳ chain\.canvas/)).not.toBeInTheDocument());
});

test("the copy text puts a request's opened steps right after it", () => {
  const request = rec(1, { message: "GET /chain", request_id: "r1", ts: 100 });
  const step = rec(5, { message: "chain.canvas", logger: "timing", request_id: "r1", ts: 99 });
  const text = pageText([request], { r1: [step] }, "Picture Sorter 1.2.3");
  expect(text.indexOf("GET /chain")).toBeLessThan(text.indexOf("chain.canvas"));
  expect(text).toContain("    chain.canvas");
});

test("the debug switch is sent to the backend, and the timing table loads on demand", async () => {
  const fetchMock = stub([], {
    "/api/logs/debug": (_u: string, init?: RequestInit) => ({ on: init?.method === "PUT" }),
    "/api/logs/timing": [{ kind: "step", name: "chain.canvas", count: 3, total_ms: 900, avg_ms: 300, p95_ms: 410, max_ms: 410 }],
  });
  render(<LogView camera="camA" />);
  await userEvent.click(await screen.findByLabelText(/Debug mode/));
  await userEvent.click(await screen.findByRole("button", { name: "Show" }));
  expect(await screen.findByText(/chain\.canvas/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([u, i]) => String(u).startsWith("/api/logs/debug") && (i as RequestInit | undefined)?.method === "PUT")).toBe(true);
});

const TIMING: TimingRow[] = [
  { kind: "request", name: "GET /api/cameras/c/chain", count: 3, total_ms: 1000, avg_ms: 333, p95_ms: 500, max_ms: 500 },
  { kind: "step", name: "chain.canvas", count: 3, total_ms: 900, avg_ms: 300, p95_ms: 410, max_ms: 410 },
  { kind: "step", name: "dedup.frames", count: 12, total_ms: 2100, avg_ms: 175, p95_ms: 1262, max_ms: 1262 },
];
const timingRows = () => within(screen.getByRole("region", { name: "Where the time went" })).getAllByRole("row").slice(1).map((r) => r.textContent);

test("the timing table sorts by a column, filters by kind and text, and folds away", async () => {
  stub([], { "/api/logs/timing": TIMING });
  render(<LogView camera="camA" />);
  await userEvent.click(await screen.findByRole("button", { name: "Show" }));
  await screen.findByText(/dedup\.frames/);
  expect(timingRows()[0]).toContain("dedup.frames"); // largest total first
  await userEvent.click(screen.getByRole("button", { name: /^Times/ }));
  expect(timingRows()[0]).toContain("dedup.frames"); // 12 times, first in descending order
  await userEvent.click(screen.getByRole("button", { name: /^What/ }));
  expect(timingRows()[0]).toContain("chain.canvas"); // by name, ascending
  await userEvent.selectOptions(screen.getByLabelText("Show"), "request");
  expect(timingRows()).toHaveLength(1);
  await userEvent.selectOptions(screen.getByLabelText("Show"), "");
  await userEvent.type(screen.getByLabelText("Search timing"), "dedup");
  expect(timingRows()).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: /Where the time went/ }));
  expect(screen.queryByText(/dedup\.frames/)).not.toBeInTheDocument();
  // the fold and the sort are remembered
  expect(JSON.parse(localStorage.getItem("picture-sorter.log-timing")!)).toMatchObject({ open: false, column: "name", desc: false });
});

test("the timing text is a plain table with the version", () => {
  const text = timingText([TIMING[1]], "Picture Sorter 1.2.3");
  expect(text).toContain("Picture Sorter 1.2.3");
  expect(text).toMatch(/· chain\.canvas\s+3\s+900\s+300\s+410\s+410/);
});

test("the filters and the order are remembered the next time the page opens", async () => {
  stub([rec(1)]);
  const first = render(<LogView camera="camA" />);
  await screen.findByText("msg 1");
  await userEvent.selectOptions(screen.getByLabelText("Level"), "DEBUG");
  await userEvent.selectOptions(screen.getByLabelText("Source"), "backend");
  await userEvent.selectOptions(screen.getByLabelText("Per page"), "25");
  await userEvent.click(screen.getByLabelText(/only camA/));
  await userEvent.click(screen.getByLabelText(/since app restart/));
  await userEvent.click(screen.getByLabelText(/Group by request/));
  await userEvent.click(screen.getByRole("button", { name: /^ms( [▼▲])?$/ }));
  first.unmount();
  const fetchMock = stub([rec(1)]);
  render(<LogView camera="camA" />);
  await screen.findByText("msg 1");
  expect(screen.getByLabelText("Level")).toHaveValue("DEBUG");
  expect(screen.getByLabelText("Source")).toHaveValue("backend");
  expect(screen.getByLabelText("Per page")).toHaveValue("25");
  expect(screen.getByLabelText(/only camA/)).toBeChecked();
  expect(screen.getByLabelText(/since app restart/)).toBeChecked();
  expect(screen.getByLabelText(/Group by request/)).toBeChecked();
  expect(asked(fetchMock, "level=DEBUG")).toBe(true);
  expect(asked(fetchMock, "order=ms")).toBe(true);
  expect(asked(fetchMock, "limit=25")).toBe(true);
});
