import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import AugmentationView from "./AugmentationView";

let calls: { url: string; method: string; body?: any }[];
let state: any;

const axis = (lo: number, hi: number, n = 20) => ({
  n,
  min: lo - 2,
  max: hi + 2,
  mean: 0,
  median: 0.4,
  suggested: [lo, hi],
  hist: { edges: [lo - 2, lo, hi, hi + 2], counts: [1, 18, 1] },
});

const analysis = (over: Record<string, unknown> = {}) => ({
  crop: [320, 240],
  reference: "f00.png",
  frames: 20,
  sources: { detector: 5, template: 14, none: 1 },
  coverage: 95,
  dx: axis(-6.04, 8.06),
  dy: axis(-5, 6),
  rot: null,
  ...over,
});

const baseState = (over: Record<string, unknown> = {}) => ({
  feature: "seal",
  classes: ["OK", "NG"],
  settings: { reference: null, source: "auto", rotation: false, coverage: 95, label: null, ranges: { dx: null, dy: null, rot: null } },
  saved: false,
  reference: "f00.png",
  has_detector: true,
  results: "fresh",
  analysis: analysis(),
  coverage_range: [50, 100],
  ...over,
});

function install() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/versions/features")) return ok([{ feature: "seal", label: "seal" }]);
      if (url.includes("/frames")) return ok({ frames: ["f00.png", "f01.png", "f02.png"], showing_all: false, total: 3, reference_frame: null });
      if (url.endsWith("/augmentation/seal/run")) return ok({ id: "m1", status: "queued", progress: {}, result: null, error: null }, 202);
      if (url === "/api/jobs/m1") return ok({ id: "m1", status: "done", progress: {}, error: null, result: { measured: 19, total: 20, reference: "f00.png" } });
      if (url.includes("/augmentation/seal") && method === "PUT") {
        const b = JSON.parse(init!.body as string);
        state = baseState({ settings: b.settings, saved: b.settings !== null, results: state.results, analysis: state.analysis });
        return ok(state);
      }
      if (url.includes("/augmentation/seal?")) {
        const q = new URL(url, "http://x").searchParams;
        const cov = Number(q.get("coverage") ?? 95);
        return ok({ ...state, analysis: state.analysis && analysis({ coverage: cov, dx: axis(-6 + (95 - cov) / 10, 8, 20) }) });
      }
      if (url.endsWith("/augmentation/seal")) return ok(state);
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  calls = [];
  state = baseState();
  install();
});
afterEach(() => vi.unstubAllGlobals());

test("shows the sources, the distributions, the suggested ranges and a hint for the unmeasured rotation", async () => {
  render(<AugmentationView camera="camA" />);
  const dx = await screen.findByTestId("axis-dx");
  expect(within(dx).getByRole("img", { name: "20 frames histogram" })).toBeInTheDocument();
  expect(within(dx).getByTestId("suggested-dx")).toHaveTextContent("-6 … 8.1 px");
  expect(screen.getByTestId("sources")).toHaveTextContent("detector 5, picture matching 14, not measured 1");
  expect(screen.getByTestId("axis-rot")).toHaveTextContent("Tick “Measure rotation”");
  expect((screen.getByLabelText("Reference frame") as HTMLSelectElement).value).toBe("f00.png");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("Use suggested fills the range, Save sends it, and the page is clean again", async () => {
  const user = userEvent.setup();
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  await user.click(screen.getByRole("button", { name: "Use suggested dx" }));
  expect((screen.getByLabelText("dx low") as HTMLInputElement).value).toBe("-6");
  expect((screen.getByLabelText("dx high") as HTMLInputElement).value).toBe("8.1");
  fireEvent.change(screen.getByLabelText("dx high"), { target: { value: "9" } });
  await user.click(screen.getByRole("button", { name: "Save *" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  const sent = calls.find((c) => c.method === "PUT")!.body.settings;
  expect(sent.ranges).toEqual({ dx: [-6, 9], dy: null, rot: null });
  expect(sent.reference).toBe("f00.png");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
});

test("the coverage slider previews another analysis without saving", async () => {
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  fireEvent.change(screen.getByLabelText("Coverage"), { target: { value: "80" } });
  await waitFor(() => expect(calls.some((c) => c.url.includes("coverage=80"))).toBe(true));
  await waitFor(() => expect(screen.getByTestId("suggested-dx")).toHaveTextContent("-4.5 … 8 px"));
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  expect(screen.getByRole("button", { name: "Save *" })).toBeEnabled(); // coverage is a setting you may keep
});

test("choosing a class restricts the frames used", async () => {
  const user = userEvent.setup();
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  await user.selectOptions(screen.getByLabelText("Frames to use"), "OK");
  await waitFor(() => expect(calls.some((c) => c.url.includes("label=OK"))).toBe(true));
});

test("Measure all frames runs the job and reloads the state, without saving when nothing changed", async () => {
  const user = userEvent.setup();
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  await user.click(screen.getByRole("button", { name: "Measure all frames" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/run"))).toBe(true));
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  expect(await screen.findByText("Measured 19 of 20 frames.")).toBeInTheDocument();
});

test("after a change the button saves first, then measures", async () => {
  const user = userEvent.setup();
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  await user.click(screen.getByLabelText("Measure rotation"));
  await user.selectOptions(screen.getByLabelText("Reference frame"), "f01.png");
  await user.click(screen.getByRole("button", { name: "Save and measure all frames" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/run"))).toBe(true));
  const put = calls.findIndex((c) => c.method === "PUT");
  const run = calls.findIndex((c) => c.url.endsWith("/run"));
  expect(put).toBeGreaterThan(-1);
  expect(put).toBeLessThan(run);
  expect(calls[put].body.settings).toMatchObject({ reference: "f01.png", rotation: true });
});

test("changing the method after a measurement is not hidden: stale and missing results are explained", async () => {
  state = baseState({ results: "stale", analysis: null });
  const { unmount } = render(<AugmentationView camera="camA" />);
  expect(await screen.findByText(/made with a different reference frame/)).toBeInTheDocument();
  unmount();
  state = baseState({ results: "none", analysis: null });
  render(<AugmentationView camera="camA" />);
  expect(await screen.findByText(/No measurements yet/)).toBeInTheDocument();
});

test("without a detector the detector-only source is disabled", async () => {
  state = baseState({ has_detector: false });
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  expect(screen.getByRole("option", { name: "detector box only" })).toBeDisabled();
  expect(screen.getByText(/no detector set up/)).toBeInTheDocument();
});

test("Clear removes a range", async () => {
  const user = userEvent.setup();
  state = baseState({ settings: { ...baseState().settings, ranges: { dx: [-5, 5], dy: null, rot: null } }, saved: true });
  render(<AugmentationView camera="camA" />);
  await screen.findByTestId("axis-dx");
  expect((screen.getByLabelText("dx low") as HTMLInputElement).value).toBe("-5");
  await user.click(screen.getByRole("button", { name: "Clear dx" }));
  expect((screen.getByLabelText("dx low") as HTMLInputElement).value).toBe("");
});
