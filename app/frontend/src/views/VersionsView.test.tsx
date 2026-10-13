import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import VersionsView from "./VersionsView";

const version = (id: number, number: number, active: boolean) => ({
  id,
  number,
  name: `ver${number}`,
  notes: "",
  created: 1_700_000_000,
  counts: { OK: number, NG: 0, golden_OK: 1, golden_NG: 0, unlabeled: 2, total: 5 },
  stats: {},
  active,
  delta: "first version",
});

let calls: { url: string; method: string; body?: string }[];
let versions: ReturnType<typeof version>[];

beforeEach(() => {
  calls = [];
  versions = [version(1, 1, false), version(2, 2, true)];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.includes("/versions/features"))
        return new Response(JSON.stringify([{ feature: "seal", label: "seal" }]));
      if (url.includes("/revert")) return new Response(JSON.stringify({ labels: 3, goldens: 1 }));
      if (url.includes("/export"))
        return new Response(
          JSON.stringify({ destination: "/x/exports", written: 4, missing: ["a.png"], hash_mismatch: [] }),
        );
      if (init?.method === "POST")
        return new Response(JSON.stringify({ id: 3, number: 3, counts: { OK: 7, NG: 1 } }), { status: 201 });
      return new Response(
        JSON.stringify({
          feature: "seal",
          classes: ["OK", "NG"],
          counts: { OK: 2, NG: 1, golden_OK: 1, golden_NG: 0, unlabeled: 2, total: 5 },
          versions,
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("lists history newest first with the active marker", async () => {
  render(<VersionsView camera="camA" />);
  expect(await screen.findByText("History (2)")).toBeInTheDocument();
  expect(screen.getByText("▶ active")).toBeInTheDocument();
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows[0]).toHaveTextContent("v2");
  expect(screen.getByRole("button", { name: /Revert v2/ })).toBeDisabled();
});

test("freeze posts feature, name and notes and reloads", async () => {
  render(<VersionsView camera="camA" />);
  await screen.findByText("History (2)");
  await userEvent.type(screen.getByLabelText(/Version name/), "batch1");
  await userEvent.type(screen.getByLabelText(/Notes/), "why");
  await userEvent.click(screen.getByRole("button", { name: /Freeze version/ }));
  await screen.findByText("Froze v3 — OK: 7, NG: 1");
  const post = calls.find((c) => c.method === "POST")!;
  expect(JSON.parse(post.body!)).toEqual({ feature: "seal", name: "batch1", notes: "why" });
});

test("revert needs confirmation and can be cancelled", async () => {
  render(<VersionsView camera="camA" />);
  await screen.findByText("History (2)");
  await userEvent.click(screen.getByRole("button", { name: /Revert v1/ }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.some((c) => c.url.includes("/revert"))).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: /Revert v1/ }));
  await userEvent.click(screen.getByRole("button", { name: /Yes, revert/ }));
  await screen.findByText("Reverted to v1: 3 labels, 1 golden marks.");
  expect(calls.find((c) => c.url.includes("/revert"))!.url).toContain("/versions/1/revert?feature=seal");
});

test("export shows the report", async () => {
  render(<VersionsView camera="camA" />);
  await screen.findByText("History (2)");
  await userEvent.click(screen.getByRole("button", { name: /Export v1/ }));
  await waitFor(() => expect(screen.getByText("/x/exports")).toBeInTheDocument());
  expect(screen.getByText(/1 frame\(s\) missing: a.png/)).toBeInTheDocument();
});
