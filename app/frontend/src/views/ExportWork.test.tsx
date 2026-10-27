import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ExportWork from "./ExportWork";

let calls: { url: string; method: string; body?: any }[];
let latest: any;
const detail = { kind: "export" as const, lines: { ok: [{ feature: "seal", dot: "OK" }], ng: [{ box: "eval:1", dot: "fail" }] }, goldens_only: true };

beforeEach(() => {
  calls = [];
  latest = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/export") && method === "GET")
      return new Response(JSON.stringify({ folders: { "A/OK": 3, "A/NG": 2 }, total: 5, ok: 3, ng: 2, both: 1, not_golden: 4, no_product: 2, uses_product: true, goldens_only: true, lines: { ok: 1, ng: 1 }, latest }));
    if (url.endsWith("/export/freeze")) { latest = { id: 7, number: 2, name: "x", created: "", counts: { total: 5 }, changed: false, exported: false, folder: "exports/project/v002__x" }; return new Response(JSON.stringify({ id: 7, number: 2, counts: {} }), { status: 201 }); }
    if (url.endsWith("/project-versions/7/export")) return new Response(JSON.stringify({ destination: "exports/project/v002__x", written: 5, missing: [], hash_mismatch: [] }));
    return new Response(JSON.stringify(detail));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => render(<ExportWork camera="camA" nodeId="export:1" detail={detail} setDetail={() => {}} onError={() => {}} />);

test("shows the folders and what is left out, freezes, then exports the frozen version", async () => {
  mount();
  expect(await screen.findByText("A/OK")).toBeInTheDocument();
  expect(screen.getByText(/1 left out: they reach both/)).toBeInTheDocument();
  expect(screen.getByText(/4 left out: not golden/)).toBeInTheDocument();
  expect(screen.getByText(/2 left out: no product/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Export version/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Freeze name"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Freeze" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/export/freeze") && c.body.name === "x")).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "Export version 2" }));
  expect(await screen.findByText(/Wrote 5 pictures/)).toBeInTheDocument();
});

test("removing a line and the goldens tick go through the node update", async () => {
  mount();
  await screen.findByText("A/OK");
  fireEvent.click(screen.getByRole("button", { name: "Remove NG line eval:1 · fail" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body.remove_line?.input === "ng")).toBe(true));
  fireEvent.click(screen.getByLabelText("Only goldens"));
  await waitFor(() => expect(calls.some((c) => c.body?.goldens_only === false)).toBe(true));
});
