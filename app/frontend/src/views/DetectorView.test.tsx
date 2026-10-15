import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DetectorView from "./DetectorView";

let calls: { url: string; method: string; body?: any }[];
let detections: any;

function install(savedFilter: any = null, savedMask: any = null, savedDetector: any = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/vision/filters"))
        return new Response(
          JSON.stringify({
            filters: {
              gaussian: { label: "Gaussian blur", params: { sigma: { min: 0.1, max: 10, step: 0.1, default: 1.5 } } },
            },
          }),
        );
      if (url.endsWith("/vision/detector"))
        return new Response(JSON.stringify({ available: true, model: "m", max_exemplars: 3, topk: [1, 5] }));
      if (url.includes("/detections") && method === "GET")
        return new Response(JSON.stringify(detections));
      if (url.includes("/detections") && method === "PUT") return new Response('{"ok":true}');
      if (url.endsWith("/detect")) return new Response(JSON.stringify({ id: "j1", status: "queued", progress: {}, result: null, error: null }));
      if (url.includes("/jobs/j1"))
        return new Response(
          JSON.stringify({ id: "j1", status: "done", progress: {}, error: null, result: { detected: 3, needs_review: 1, skipped_human: 0 } }),
        );
      if (url.includes("/versions/features")) return new Response(JSON.stringify([{ feature: "seal", label: "seal" }]));
      if (url.includes("/frames"))
        return new Response(JSON.stringify({ frames: ["f1.png"], showing_all: false, total: 1, reference_frame: null }));
      if (url.endsWith("/preview")) return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response; // jsdom Blob != undici Blob
      if (url.includes("/vision/seal") && method === "PUT") return new Response(init!.body as string);
      if (url.includes("/vision/seal")) return new Response(JSON.stringify({ filter: savedFilter, mask: savedMask, detector: savedDetector }));
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  calls = [];
  detections = { threshold: 0.3, counts: {}, frames: [] };
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

test("choosing a filter shows its sliders, previews it and saves it", async () => {
  install();
  render(<DetectorView camera="camA" />);
  const select = await screen.findByLabelText("Filter");
  await screen.findByRole("option", { name: "Gaussian blur" });
  await userEvent.selectOptions(select, "gaussian");
  expect(screen.getByLabelText("sigma")).toBeInTheDocument();
  await waitFor(() =>
    expect(
      calls.some((c) => c.url.endsWith("/preview") && c.body?.filter?.name === "gaussian"),
    ).toBe(true),
  );
  expect(await screen.findByAltText("Filtered preview")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ filter: { name: "gaussian", params: { sigma: 1.5 } }, mask: null, detector: null });
  });
});

test("saved filter is loaded and Save is disabled until changed", async () => {
  install({ name: "gaussian", params: { sigma: 3 } });
  render(<DetectorView camera="camA" />);
  const slider = await screen.findByLabelText("sigma");
  await waitFor(() => expect(slider).toHaveValue("3"));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
});

test("choosing a shape adds an editable mask; enabling it previews and saves it", async () => {
  install();
  render(<DetectorView camera="camA" />);
  await userEvent.click(screen.getByRole("tab", { name: /Mask/ }));
  const select = await screen.findByLabelText("Shape");
  await userEvent.selectOptions(select, "circle");
  expect(await screen.findByTestId("handle-radius")).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText(/Apply mask/));
  await userEvent.click(screen.getByRole("button", { name: "Masked" }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/preview") && c.body?.mask?.enabled === true)).toBe(true),
  );
  // the editing canvas image is requested without the mask
  expect(calls.some((c) => c.url.endsWith("/preview") && c.body?.mask === null)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body.mask).toEqual({ enabled: true, shape: { shape: "circle", cx: 0.5, cy: 0.5, r: 0.25 } });
  });
});

test("saved mask is loaded and Revert restores it", async () => {
  install(null, { enabled: true, shape: { shape: "rect", x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  render(<DetectorView camera="camA" />);
  await userEvent.click(screen.getByRole("tab", { name: /Mask/ }));
  const select = await screen.findByLabelText("Shape");
  await waitFor(() => expect(select).toHaveValue("rect"));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await userEvent.selectOptions(select, "polygon");
  expect(screen.getByRole("button", { name: "Add point" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Revert" }));
  expect(select).toHaveValue("rect");
});

test("polygon: Add point adds a vertex handle; double-click removes it", async () => {
  install();
  render(<DetectorView camera="camA" />);
  await userEvent.click(screen.getByRole("tab", { name: /Mask/ }));
  await userEvent.selectOptions(await screen.findByLabelText("Shape"), "polygon");
  expect(await screen.findByTestId("handle-v2")).toBeInTheDocument();
  expect(screen.queryByTestId("handle-v3")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Add point" }));
  expect(await screen.findByTestId("handle-v3")).toBeInTheDocument();
  await userEvent.dblClick(screen.getByTestId("handle-v3"));
  await waitFor(() => expect(screen.queryByTestId("handle-v3")).toBeNull());
});

test("tabs show a status chip each and the purpose of the active step", async () => {
  install({ name: "gaussian", params: { sigma: 3 } });
  render(<DetectorView camera="camA" />);
  const tabs = await screen.findAllByRole("tab");
  await waitFor(() => expect(tabs[0].textContent).toMatch(/saved/));
  expect(tabs.map((t) => t.textContent)).toEqual([
    expect.stringMatching(/Filter.*saved/),
    expect.stringMatching(/Detector.*not set/),
    expect.stringMatching(/Review.*not run/),
    expect.stringMatching(/Mask.*not set/),
  ]);
  expect(screen.getByText(/Clean up every frame/)).toBeInTheDocument();
  await userEvent.click(tabs[1]);
  expect(screen.getByText(/Show the detector what the object looks like/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Filter")).toBeNull(); // one step visible at a time
});

test("the save bar stays visible on every tab and flags unsaved changes", async () => {
  install();
  render(<DetectorView camera="camA" />);
  await screen.findByRole("option", { name: "Gaussian blur" });
  await userEvent.selectOptions(screen.getByLabelText("Filter"), "gaussian");
  expect(screen.getByRole("tab", { name: /Filter.*unsaved/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /Review/ }));
  expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
});
