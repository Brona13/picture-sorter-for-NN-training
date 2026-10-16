import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ProjectVersions from "./ProjectVersions";

const summary = (over: Record<string, number> = {}) => ({
  frames: 12, total: 10, deleted: 2, ok: 4, ng: 2, open: 1, contradiction: 1, stale: 1, duplicates: 1, ...over,
});

const pv = (id: number, number: number, active: boolean, over: Record<string, unknown> = {}) => ({
  id, number, name: `p${number}name`, notes: "", created: 1_700_000_000, active, deleted: null, delta: "first version", stats: {},
  counts: { ok: 4, ng: 2, contradiction: 1, stale: 1, open: 1, duplicates: 1, deleted: 2, total: 10 }, results: [], ...over,
});

let calls: { url: string; method: string; body?: any }[];
let state: { summary: ReturnType<typeof summary>; versions: ReturnType<typeof pv>[] };

beforeEach(() => {
  calls = [];
  state = { summary: summary(), versions: [pv(1, 1, false), pv(2, 2, true)] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith("/project-versions") && init?.method === "POST") return ok({ id: 3, number: 3, counts: { ok: 4, ng: 2 } }, 201);
      if (url.endsWith("/project-versions")) return ok({ ...state, result_names: [] });
      if (url.endsWith("/export")) return ok({ destination: "/x/exports/project/v002", written: 5, missing: ["a.png"], hash_mismatch: ["b.png"] });
      if (init?.method === "DELETE") return ok({ deleted: 1 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("shows the live verdicts, a warning about pictures without a verdict and the history newest first", async () => {
  render(<ProjectVersions camera="camA" />);
  expect(await screen.findByTestId("freeze-warning")).toHaveTextContent("3 picture(s) have no valid verdict (1 open, 1 contradictions, 1 stale)");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows[0]).toHaveTextContent("p2");
  expect(rows[0]).toHaveTextContent("▶ latest");
  expect(within(rows[0]).getAllByRole("cell")[4]).toHaveTextContent("4");
});

test("no warning when every picture has a verdict; freeze needs at least one verdict", async () => {
  state.summary = summary({ open: 0, contradiction: 0, stale: 0, duplicates: 0 });
  render(<ProjectVersions camera="camA" />);
  await screen.findByRole("table", { name: "Project version history" });
  expect(screen.queryByTestId("freeze-warning")).toBeNull();
  state.summary = summary({ ok: 0, ng: 0 });
  render(<ProjectVersions camera="camB" />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: /Freeze verdicts/ }).at(-1)).toBeDisabled());
});

test("freeze posts the name and notes and reloads", async () => {
  render(<ProjectVersions camera="camA" />);
  await screen.findByRole("table", { name: "Project version history" });
  await userEvent.type(screen.getByLabelText("Project version name"), "batch 1");
  await userEvent.type(screen.getByLabelText(/Project notes/), "first");
  await userEvent.click(screen.getByRole("button", { name: /Freeze verdicts/ }));
  await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "batch 1", notes: "first" }));
  expect(await screen.findByText(/Froze project v3 — OK 4, NG 2/)).toBeInTheDocument();
});

test("export reports what was written, missing and changed", async () => {
  render(<ProjectVersions camera="camA" />);
  await screen.findByRole("table", { name: "Project version history" });
  await userEvent.click(screen.getByRole("button", { name: /Export p1/ }));
  expect(await screen.findByText("/x/exports/project/v002")).toBeInTheDocument();
  expect(calls.some((c) => c.url === "/api/cameras/camA/project-versions/1/export" && c.method === "POST")).toBe(true);
  expect(screen.getByText(/1 frame\(s\) missing: a.png/)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("1 frame(s) changed since freeze: b.png");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
});

test("the latest version cannot be deleted; an older one can after confirming", async () => {
  render(<ProjectVersions camera="camA" />);
  await screen.findByRole("table", { name: "Project version history" });
  expect(screen.getByRole("button", { name: /Delete p2/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /Delete p1/ }));
  await userEvent.click(screen.getByRole("button", { name: "✅ Yes, delete" }));
  await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/cameras/camA/versions/1?feature=%40project"));
});

test("a deleted version is greyed out without actions", async () => {
  state.versions = [pv(1, 1, false, { deleted: 1_700_000_500 }), pv(2, 2, true)];
  render(<ProjectVersions camera="camA" />);
  await screen.findByRole("table", { name: "Project version history" });
  const row = screen.getAllByRole("row").slice(1)[1];
  expect(row).toHaveClass("deleted-version");
  expect(screen.queryByRole("button", { name: /Export p1/ })).toBeNull();
});
