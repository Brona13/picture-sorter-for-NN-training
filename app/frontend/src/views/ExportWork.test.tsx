import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ExportWork, { when } from "./ExportWork";

let calls: { url: string; method: string; body?: any }[];
let frozen: any[];
let counts: { both: number; not_golden: number; no_product: number; total: number; folders: Record<string, number> };
const detail = { kind: "export" as const, lines: { ok: [{ feature: "seal", dot: "OK" }], ng: [{ box: "eval:1", dot: "fail" }] }, goldens_only: true };

const version = (over: Record<string, unknown> = {}) => ({
  id: 7, number: 2, name: "x", created: 1793350800, counts: { total: 5, ok: 3, ng: 2 }, changed: false, exported: false, folder: "exports/project/v002__x", ...over,
});

beforeEach(() => {
  calls = [];
  frozen = [];
  counts = { both: 1, not_golden: 4, no_product: 2, total: 5, folders: { "A/OK": 3, "A/NG": 2 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/export") && method === "GET")
      return new Response(JSON.stringify({
        folders: counts.folders, total: counts.total, ok: 3, ng: 2, both: counts.both, not_golden: counts.not_golden, no_product: counts.no_product,
        uses_product: true, goldens_only: true, lines: { ok: 1, ng: 1 }, latest: frozen[0] ?? null, versions: frozen,
      }));
    if (url.endsWith("/export/freeze")) { frozen = [version(), ...frozen]; return new Response(JSON.stringify({ id: 7, number: 2, counts: {} }), { status: 201 }); }
    if (url.endsWith("/project-versions/7/export")) {
      frozen = frozen.map((v) => (v.id === 7 ? { ...v, exported: true } : v));
      return new Response(JSON.stringify({ destination: "exports/project/v002__x", written: 5, missing: [], hash_mismatch: [] }));
    }
    return new Response(JSON.stringify(detail));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => render(<ExportWork camera="camA" nodeId="export:1" detail={detail} setDetail={() => {}} onError={() => {}} />);

test("one table holds the folders, what is left out and why, and the total", async () => {
  mount();
  expect(await screen.findByText("A/OK")).toBeInTheDocument();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getByText("Left out: they reach both OK and NG").nextSibling).toHaveTextContent("1");
  expect(screen.getByText("Left out: not golden").nextSibling).toHaveTextContent("4");
  expect(screen.getByText("Left out: no product").nextSibling).toHaveTextContent("2");
  expect(screen.getByText("Total to export").nextSibling).toHaveTextContent("5");
});

test("a reason with nothing behind it has no row, and nothing arriving says where to connect", async () => {
  counts = { both: 0, not_golden: 0, no_product: 0, total: 0, folders: {} };
  mount();
  expect(await screen.findByText(/Nothing arrives yet/)).toHaveTextContent("on the Chain");
  expect(screen.queryByText(/Left out/)).not.toBeInTheDocument();
  expect(screen.queryByText("Total to export")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Freeze" })).toBeDisabled();
});

test("the lines are not listed here: they are drawn on the Chain", async () => {
  mount();
  await screen.findByText("A/OK");
  expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  expect(screen.queryByText("seal · OK")).not.toBeInTheDocument();
});

test("freezes with a name, lists the freeze, then exports it and shows where it went", async () => {
  mount();
  await screen.findByText("A/OK");
  expect(screen.getByText(/Nothing frozen yet/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Export version/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Freeze name"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/export/freeze") && c.body.name === "x")).toBe(true));

  const row = within((await screen.findByRole("table", { name: "Frozen versions" })).querySelector("tbody tr") as HTMLElement);
  expect(row.getByText("v2")).toBeInTheDocument();
  expect(row.getByText("x")).toBeInTheDocument();
  expect(row.getByText("Not exported")).toBeInTheDocument();
  expect(row.getByText("exports/project/v002__x")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Export version 2" }));
  expect(await screen.findByText(/Wrote 5 pictures/)).toHaveTextContent("exports/project/v002__x");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
  expect(await screen.findByText("Exported")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export version 2" })).toHaveTextContent("Export again");
});

test("every freeze has a row, newest first, and only the newest can say the Chain changed", async () => {
  frozen = [version({ id: 9, number: 3, name: "third", changed: true }), version({ id: 7, number: 2, name: "second", exported: true, changed: true })];
  mount();
  const rows = Array.from((await screen.findByRole("table", { name: "Frozen versions" })).querySelectorAll("tbody tr"));
  expect(rows).toHaveLength(2);
  expect(within(rows[0] as HTMLElement).getByText("v3")).toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).getByText("v2")).toBeInTheDocument();
  expect(within(rows[0] as HTMLElement).getByText("Chain changed")).toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).queryByText("Chain changed")).not.toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).getByText("Exported")).toBeInTheDocument();
});

test("an older backend that only sends the latest freeze still fills the table", async () => {
  frozen = [version()];
  (fetch as any).mockImplementation(async (url: string) =>
    new Response(JSON.stringify(url.endsWith("/export")
      ? { folders: {}, total: 0, ok: 0, ng: 0, both: 0, not_golden: 0, no_product: 0, uses_product: false, goldens_only: true, lines: { ok: 0, ng: 0 }, latest: frozen[0] }
      : detail)));
  mount();
  expect(await screen.findByText("v2")).toBeInTheDocument();
});

test("the goldens tick goes through the node update", async () => {
  mount();
  await screen.findByText("A/OK");
  fireEvent.click(screen.getByLabelText("Only goldens"));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.goldens_only === false)).toBe(true));
});

test("a freeze time in epoch seconds is shown as a date, text is kept as it is", () => {
  expect(when(1793350800)).toMatch(/^2026-10-30 \d\d:\d\d$/);
  expect(when("yesterday")).toBe("yesterday");
});
