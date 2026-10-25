import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import LogView from "./LogView";
import { logsText } from "./logText";

const rec = (id: number, over = {}) => ({
  id, ts: 1_761_400_000 + id, level: "ERROR", source: "backend", logger: "http", message: `msg ${id}`, request_id: `req${id}`,
  camera: "camA", job_id: null, duration_ms: 12.5, exc: id === 1 ? "Traceback...\nValueError: x" : null, extra: null, audit: 0, ...over,
});
afterEach(() => vi.unstubAllGlobals());

function stub(rows: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/version") ? { version: "1.2.3" } : rows)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("lists records, filters by level and request id through the query", async () => {
  const fetchMock = stub([rec(2), rec(1)]);
  render(<LogView camera="camA" />);
  expect(await screen.findByText("msg 2")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes("level=WARNING"))).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "req2" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("request_id=req2"))).toBe(true));
  await userEvent.click(screen.getByLabelText(/only camA/));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("camera=camA"))).toBe(true));
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
