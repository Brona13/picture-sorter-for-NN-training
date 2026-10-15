import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import EdgeAngleView from "./EdgeAngleView";

let calls: { url: string; method: string; body?: any }[];
let state: any;

const savedSettings = {
  p1: { x: 0.2, y: 0.5 },
  p2: { x: 0.8, y: 0.5 },
  half_width: 0.1,
  points: 8,
  expected: null,
};

const measurement = {
  status: "ok",
  angle: 91.2,
  polarity: "+",
  contrast: 120,
  rms: 0.4,
  n_points: 7,
  points: [{ x: 0.3, y: 0.5 }],
  line: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
  patch_points: [{ x: 0.3, y: 0.5 }],
  patch_line: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
};

const baseState = (over: Record<string, unknown> = {}) => ({
  feature: "seal",
  settings: savedSettings,
  ranges: { points: [3, 40], half_width: [0.005, 0.5], tolerance: [0.1, 90] },
  defaults: { points: 10, half_width: 0.05, tolerance: 5 },
  results: "none",
  summary: null,
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
      if (url.includes("/frames")) return ok({ frames: ["f1.png", "f2.png"], showing_all: false, total: 2, reference_frame: null });
      if (url.endsWith("/vision/seal/preview")) return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
      if (url.endsWith("/rules/edge-angle/seal/preview")) {
        const b = JSON.parse(init!.body as string);
        const exp = b.settings.expected;
        const verdict = exp ? (Math.abs(exp.angle - 91.2) <= exp.tolerance && exp.polarity === "+" ? "pass" : "fail") : null;
        return ok({ measurement, verdict, band: [], patch: "data:image/png;base64,AAAA", crop_size: [200, 100] });
      }
      if (url.endsWith("/rules/edge-angle/seal/run")) return ok({ id: "r1", status: "queued", progress: {}, result: null, error: null }, 202);
      if (url === "/api/jobs/r1")
        return ok({ id: "r1", status: "done", progress: {}, error: null, result: { total: 5, pass: 3, fail: 1, undetermined: 1, measured: 0 } });
      if (url.endsWith("/rules/edge-angle/seal") && method === "PUT") {
        const b = JSON.parse(init!.body as string);
        state = baseState({ settings: b.settings });
        return ok(state);
      }
      if (url.endsWith("/rules/edge-angle/seal")) return ok(state);
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  calls = [];
  state = baseState();
  URL.createObjectURL = vi.fn(() => "blob:crop");
  URL.revokeObjectURL = vi.fn();
  install();
});
afterEach(() => vi.unstubAllGlobals());

const previewCalls = () => calls.filter((c) => c.url.endsWith("/rules/edge-angle/seal/preview"));

test("loads the saved line and shows the live measurement and the straightened band", async () => {
  render(<EdgeAngleView camera="camA" />);
  expect(await screen.findByTestId("band")).toBeInTheDocument();
  const meas = await screen.findByTestId("measurement");
  expect(meas).toHaveTextContent("91.2°");
  expect(meas).toHaveTextContent("left side brighter");
  expect(meas).toHaveTextContent("7 of 8");
  expect(await screen.findByAltText("Straightened band")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  expect(previewCalls()[0].body).toEqual({ frame: "f1.png", settings: savedSettings });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing changed yet
});

test("moving the points slider re-measures with the new setting and enables Save", async () => {
  render(<EdgeAngleView camera="camA" />);
  await screen.findByTestId("measurement");
  fireEvent.change(screen.getByLabelText("Points used"), { target: { value: "12" } });
  await waitFor(() => expect(previewCalls().at(-1)!.body.settings.points).toBe(12));
  expect(screen.getByRole("button", { name: "Save *" })).toBeEnabled();
});

test("the OK example button fills the expectation, the verdict appears, and Save sends it", async () => {
  const user = userEvent.setup();
  render(<EdgeAngleView camera="camA" />);
  await screen.findByTestId("measurement");
  expect(screen.getByText(/No expectation yet/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use this frame as the OK example" }));
  expect((screen.getByLabelText("Expected angle") as HTMLInputElement).value).toBe("91.2");
  await waitFor(() => expect(screen.getByTestId("measurement")).toHaveTextContent("pass"));
  fireEvent.change(screen.getByLabelText("Tolerance"), { target: { value: "3" } });
  await user.click(screen.getByRole("button", { name: "Save *" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  expect(calls.find((c) => c.method === "PUT")!.body.settings.expected).toEqual({ angle: 91.2, tolerance: 3, polarity: "+" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
});

test("Measure all frames runs the job and shows the counts", async () => {
  state = baseState({ settings: { ...savedSettings, expected: { angle: 90, tolerance: 5, polarity: "+" } } });
  const user = userEvent.setup();
  render(<EdgeAngleView camera="camA" />);
  await screen.findByTestId("measurement");
  state = baseState({
    settings: { ...savedSettings, expected: { angle: 90, tolerance: 5, polarity: "+" } },
    results: "fresh",
    summary: { total: 5, pass: 3, fail: 1, undetermined: 1, measured: 0 },
  });
  await user.click(screen.getByRole("button", { name: "Measure all frames" }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/run"))).toBe(true));
  expect(calls.some((c) => c.method === "PUT")).toBe(false); // nothing unsaved, so no save first
  expect(await screen.findByTestId("summary")).toHaveTextContent("3 pass · 1 fail · 1 undetermined");
});

test("with no saved line the view asks for one and nothing is measured", async () => {
  state = baseState({ settings: null });
  render(<EdgeAngleView camera="camA" />);
  expect(await screen.findByText(/Click once to place the first point/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Measure all frames" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(previewCalls()).toHaveLength(0);
});

test("stale results are flagged", async () => {
  state = baseState({ results: "stale" });
  render(<EdgeAngleView camera="camA" />);
  expect(await screen.findByText(/saved results are for an earlier line/)).toBeInTheDocument();
});
