import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VersionInfo } from "./api";
import VersionResults from "./VersionResults";

const result = (id: number, version_id: number, name: string, value: number, measured: string, note = "") => ({ id, version_id, name, value, measured, note, created: 0 });

const version = (id: number, number: number, active: boolean, results: ReturnType<typeof result>[] = [], deleted: number | null = null): VersionInfo => ({
  id,
  number,
  name: `ver${number}`,
  notes: "",
  created: 1_700_000_000,
  counts: {},
  stats: {},
  active,
  deleted,
  delta: "",
  results,
});

let calls: { url: string; method: string; body?: any }[];
const onChanged = vi.fn();
const onNotice = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  calls = [];
  [onChanged, onNotice, onError].forEach((f) => f.mockClear());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (init?.method === "DELETE") return new Response(JSON.stringify({ deleted: 1 }));
      return new Response(JSON.stringify({ id: 9 }), { status: init?.method === "POST" ? 201 : 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = (versions: VersionInfo[], names: string[] = []) =>
  render(<VersionResults camera="camA" feature="seal" versions={versions} names={names} onChanged={onChanged} onNotice={onNotice} onError={onError} />);

test("records a result against the active version with the typed values", async () => {
  const user = userEvent.setup();
  renderIt([version(1, 1, false), version(2, 2, true)], ["accuracy"]);
  expect((screen.getByLabelText("Version") as HTMLSelectElement).value).toBe("2");
  await user.type(screen.getByLabelText("Metric"), "NG recall");
  fireEvent.change(screen.getByLabelText("Value"), { target: { value: "0.915" } });
  fireEvent.change(screen.getByLabelText("Measured on"), { target: { value: "2026-10-14" } });
  await user.type(screen.getByLabelText("Note"), "run 3");
  await user.click(screen.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].url).toBe("/api/cameras/camA/versions/2/results");
  expect(calls[0].body).toEqual({ feature: "seal", name: "NG recall", value: 0.915, note: "run 3", measured: "2026-10-14" });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(onNotice).toHaveBeenCalledWith("Recorded NG recall for v2.");
  expect((screen.getByLabelText("Metric") as HTMLInputElement).value).toBe(""); // the form is ready for the next one
});

test("the date defaults to today and earlier metric names are offered", () => {
  renderIt([version(1, 1, true)], ["accuracy", "NG recall"]);
  expect((screen.getByLabelText("Measured on") as HTMLInputElement).value).toBe(new Date().toLocaleDateString("en-CA"));
  const options = Array.from(document.querySelectorAll("#result-names option")).map((o) => o.getAttribute("value"));
  expect(options).toEqual(["accuracy", "NG recall"]);
});

test("the comparison table shows the latest value of each metric per version", () => {
  renderIt([
    version(1, 1, false, [result(1, 1, "accuracy", 0.9, "2026-10-01"), result(2, 1, "NG recall", 0.7, "2026-10-01")]),
    version(2, 2, false, [result(4, 2, "accuracy", 0.95, "2026-10-12", "run 5"), result(3, 2, "accuracy", 0.93, "2026-10-10")]),
    version(3, 3, true),
  ]);
  const matrix = screen.getByTestId("results-matrix");
  const row = (metric: string) => within(within(matrix).getByText(metric).closest("tr") as HTMLElement).getAllByRole("cell").map((c) => c.textContent);
  expect(row("accuracy")).toEqual(["accuracy", "0.9", "0.95"]);
  expect(row("NG recall")).toEqual(["NG recall", "0.7", "—"]);
  expect(within(matrix).queryByText("v3")).toBeNull(); // nothing recorded on v3, so no column
  expect(within(matrix).getByText("0.95")).toHaveAttribute("title", "2026-10-12 · run 5 · 2 values recorded");
});

test("a non-numeric value is refused before anything is sent", async () => {
  const user = userEvent.setup();
  renderIt([version(1, 1, true)]);
  await user.type(screen.getByLabelText("Metric"), "accuracy");
  await user.click(screen.getByRole("button", { name: "Record" }));
  expect(calls).toHaveLength(0);
});

test("editing sends an update to the same result and keeps its version", async () => {
  const user = userEvent.setup();
  renderIt([version(1, 1, false, [result(7, 1, "accuracy", 0.5, "2026-10-01", "typo")]), version(2, 2, true)]);
  await user.selectOptions(screen.getByLabelText("Version"), "1");
  await user.click(screen.getByRole("button", { name: "Edit accuracy 2026-10-01" }));
  expect((screen.getByLabelText("Version") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("0.5");
  fireEvent.change(screen.getByLabelText("Value"), { target: { value: "0.55" } });
  await user.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].method).toBe("PUT");
  expect(calls[0].url).toBe("/api/cameras/camA/versions/1/results/7");
  expect(calls[0].body).toMatchObject({ name: "accuracy", value: 0.55, note: "typo", measured: "2026-10-01" });
});

test("deleting a result calls the API for that result and reloads", async () => {
  const user = userEvent.setup();
  renderIt([version(1, 1, true, [result(7, 1, "accuracy", 0.5, "2026-10-01")])]);
  await user.click(screen.getByRole("button", { name: "Delete accuracy 2026-10-01" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/cameras/camA/versions/1/results/7?feature=seal" });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

test("a deleted version can still be chosen and is marked", () => {
  renderIt([version(1, 1, false, [result(1, 1, "accuracy", 0.9, "2026-10-01")], 1_700_000_100), version(2, 2, true)]);
  expect(screen.getByRole("option", { name: "v1 ver1 (deleted)" })).toBeInTheDocument();
});

test("an API error is reported and the form keeps what was typed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "The date must look like 2026-10-15" }), { status: 422 })));
  const user = userEvent.setup();
  renderIt([version(1, 1, true)]);
  await user.type(screen.getByLabelText("Metric"), "accuracy");
  fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1" } });
  await user.click(screen.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("The date must look like 2026-10-15"));
  expect((screen.getByLabelText("Metric") as HTMLInputElement).value).toBe("accuracy");
});
