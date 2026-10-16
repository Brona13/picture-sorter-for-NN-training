import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import StepBar from "./StepBar";

const pipeline = (feature: string, next: string | null = "labeled") => ({
  feature,
  frames: 8,
  labeled: 2,
  next,
  stages: [
    { id: "roi", label: "ROI", view: "roi", optional: false, status: "done", detail: "" },
    { id: "labeled", label: "Labels", view: "classify", optional: false, status: "partial", detail: "2 of 8" },
    { id: "version", label: "Version", view: "versions", optional: false, status: "todo", detail: "" },
  ],
});

let calls: string[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const feature = decodeURIComponent(new URL(url, "http://x").searchParams.get("feature") ?? "");
      return new Response(JSON.stringify(pipeline(feature)));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const renderAt = (path: string, camera = "camA", feature = "seal") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <StepBar camera={camera} feature={feature} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

test("on a page that works on one ROI it shows that ROI's stages with the current page marked", async () => {
  renderAt("/classify");
  const bar = await screen.findByTestId("step-bar");
  expect(bar).toHaveTextContent("seal");
  expect(screen.getByTestId("stage-labeled")).toHaveAttribute("aria-current", "step");
  expect(screen.getByTestId("stage-version")).not.toHaveAttribute("aria-current");
  expect(calls).toEqual(["/api/cameras/camA/pipeline?feature=seal"]);
  expect(screen.getByText("2 of 8 frames labeled")).toBeInTheDocument();
});

test("clicking a stage goes to the page that does it", async () => {
  renderAt("/classify");
  await userEvent.click(await screen.findByTestId("stage-version"));
  expect(screen.getByTestId("where")).toHaveTextContent("/versions");
});

test("it stays away from the overview, status and ingest pages and when no ROI is chosen", async () => {
  for (const path of ["/overview", "/status", "/ingest"]) {
    const { unmount } = renderAt(path);
    await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());
    expect(screen.queryByTestId("step-bar")).toBeNull();
    unmount();
  }
  renderAt("/classify", "camA", "");
  await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());
  expect(screen.queryByTestId("step-bar")).toBeNull();
  expect(calls).toEqual([]);
});

test("it reloads when the page changes so it catches up with the work done", async () => {
  renderAt("/classify");
  await screen.findByTestId("step-bar");
  await userEvent.click(screen.getByTestId("stage-version"));
  await waitFor(() => expect(calls).toHaveLength(2));
});

test("a failed request just hides the bar", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  renderAt("/dedup");
  await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());
  expect(screen.queryByTestId("step-bar")).toBeNull();
});

test("labeling something refreshes the counts without a page change", async () => {
  let labeled = 2;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/classify/label")) {
        labeled = 9;
        return new Response(JSON.stringify({ card: { frame: "a.png", label: "OK", golden: null, deleted: false }, counts: {} }));
      }
      const p = pipeline("seal");
      return new Response(JSON.stringify({ ...p, labeled, stages: p.stages.map((s) => (s.id === "labeled" ? { ...s, detail: `${labeled} of 8` } : s)) }));
    }),
  );
  renderAt("/dedup");
  expect(await screen.findByText(/2 of 8/)).toBeInTheDocument();
  const { api } = await import("./api");
  await api.setLabel("camA", "seal", "a.png", "OK");
  expect(await screen.findByText(/9 of 8/)).toBeInTheDocument();
});

test("plain reads do not trigger a refresh", async () => {
  renderAt("/dedup");
  await screen.findByTestId("step-bar");
  const n = calls.length;
  const { api } = await import("./api");
  await api.pipeline("camA", "seal");
  await new Promise((r) => setTimeout(r, 450));
  expect(calls.length).toBe(n + 1); // the read itself, nothing more
});
