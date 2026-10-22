import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import IngestTable from "./IngestTable";

const at = (iso: string) => new Date(iso).getTime() / 1000;
let calls: { url: string; method: string; body?: any }[];
let rows: any[];

beforeEach(() => {
  calls = [];
  rows = [
    { frame: "a", width: 1920, height: 1080, created: at("2026-10-20T09:00:00"), removed: false },
    { frame: "b", width: 1920, height: 1080, created: at("2026-10-21T09:00:00"), removed: false },
    { frame: "c", width: 640, height: 480, created: at("2026-10-21T09:00:00"), removed: false },
    { frame: "d", width: 640, height: 480, created: at("2026-10-21T09:00:00"), removed: true },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/ingest/overview")) return new Response(JSON.stringify({ frames: rows }));
    if (url.endsWith("/ingest/remove") || url.endsWith("/ingest/keep-only")) return new Response(JSON.stringify({ removed: 2 }));
    if (url.endsWith("/ingest/bring-back")) return new Response(JSON.stringify({ restored: 1 }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const show = async () => {
  const onChanged = vi.fn();
  render(<IngestTable camera="camA" revision={0} onChanged={onChanged} />);
  await screen.findByTestId("ingest-table");
  return onChanged;
};

test("the table lists sizes by days with the counts, and shows removed pictures beside them", async () => {
  await show();
  expect(screen.getByRole("button", { name: "1920 × 1080 on 2026-10-20: 1 in use" })).toHaveTextContent("1");
  expect(screen.getByRole("button", { name: "640 × 480 on 2026-10-21: 1 in use, 1 removed" })).toHaveTextContent("+1 removed");
});

test("picking a size row and pressing Remove asks first, then removes exactly those pictures", async () => {
  const user = userEvent.setup();
  const onChanged = await show();
  expect(screen.getByRole("button", { name: "Remove picked" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Pick size 640 × 480" }));
  await user.click(screen.getByRole("button", { name: "Remove picked" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Remove 1 picture(s)?");
  expect(calls.some((c) => c.url.endsWith("/ingest/remove"))).toBe(false); // nothing yet
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/ingest/remove"))?.body).toEqual({ frames: ["c"] }));
  expect(onChanged).toHaveBeenCalled();
});

test("Keep only picked sends the picked pictures; Bring back sends the removed ones in the picked cells", async () => {
  const user = userEvent.setup();
  await show();
  await user.click(screen.getByRole("button", { name: "Pick day 2026-10-20" }));
  await user.click(screen.getByRole("button", { name: "Keep only picked" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Keep only 1 picture(s) and remove the other 2?");
  await user.click(screen.getByRole("button", { name: "Keep only these" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/ingest/keep-only"))?.body).toEqual({ frames: ["a"] }));
  await user.click(await screen.findByRole("button", { name: "Pick day 2026-10-21" }));
  await user.click(screen.getByRole("button", { name: "Bring back picked" }));
  await user.click(screen.getByRole("button", { name: "Bring back" }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith("/ingest/bring-back"))?.body).toEqual({ frames: ["d"] }));
});

test("Cancel leaves everything as it is", async () => {
  const user = userEvent.setup();
  await show();
  await user.click(screen.getByRole("button", { name: "Pick everything" }));
  await user.click(screen.getByRole("button", { name: "Remove picked" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});
